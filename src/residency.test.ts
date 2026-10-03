import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { RunEvent, RunEventType } from "./events.ts";
import {
  AirGappedEgressGuard,
  EgressDeniedError,
  operationalLogLine,
  parseResidencyInventory,
  RESIDENCY_STORE_IDS,
} from "./residency.ts";

const occurredAt = "2026-08-21T12:00:00.000Z";

function event<T extends RunEventType>(type: T, payload: Extract<RunEvent, { type: T }>["payload"]): RunEvent {
  return {
    schemaVersion: 1,
    eventId: `event-${type}`,
    runId: "run-1",
    conversationId: "conversation-1",
    sequence: 1,
    turn: 1,
    occurredAt,
    type,
    causationId: "request-1",
    audience: type === "message.delta" ? "ui" : "persistence",
    sensitivity: type === "message.delta" || type === "message.completed" || type === "tool.requested" || type === "tool.completed" || type === "run.failed" || type === "run.cancelled" ? "content" : "metadata",
    payload,
  } as Extract<RunEvent, { type: T }>;
}

test("the checked residency inventory enumerates every B7 store and fixed recovery objective", async () => {
  const raw = JSON.parse(await readFile(
    new URL("../phaseB/residency-inventory.v1.json", import.meta.url),
    "utf8",
  ));
  const inventory = parseResidencyInventory(raw);

  assert.deepEqual(inventory.stores.map((store) => store.id), [...RESIDENCY_STORE_IDS]);
  assert.equal(inventory.recovery.rpoMinutes, 15);
  assert.equal(inventory.recovery.rtoMinutes, 240);
  assert.equal(inventory.defaultExternalTelemetry, false);
  assert.match(inventory.physicalErasure.database, /not claimed as forensic overwrite/i);
  assert.match(inventory.physicalErasure.backups, /erasure records are reapplied/i);
  assert.equal(inventory.stores.find((store) => store.id === "logs")?.contentMode, "metadata-only");
  assert.equal(inventory.stores.find((store) => store.id === "telemetry")?.contentMode, "metadata-only");
});

test("residency validation rejects missing stores, unsafe telemetry, and nested typos", async () => {
  const raw = JSON.parse(await readFile(
    new URL("../phaseB/residency-inventory.v1.json", import.meta.url),
    "utf8",
  ));
  raw.stores = raw.stores.filter((store: { id: string }) => store.id !== "backups");
  raw.defaultExternalTelemetry = true;
  raw.recovery.rpoMinute = raw.recovery.rpoMinutes;

  assert.throws(
    () => parseResidencyInventory(raw),
    /backups must appear exactly once.*defaultExternalTelemetry|defaultExternalTelemetry.*rpoMinute/s,
  );
});

test("operational log serialization excludes prompt, completion, tool, and error canaries", () => {
  const canaries = {
    prompt: "prompt-canary-36b859de",
    completion: "completion-canary-0e2ef985",
    toolArgument: "tool-argument-canary-5d0fd522",
    toolResult: "tool-result-canary-0bef7c9f",
    failure: "failure-detail-canary-5388e347",
  };
  const events: RunEvent[] = [
    event("message.completed", {
      message: {
        schemaVersion: 1,
        messageId: "message-user",
        role: "user",
        createdAt: occurredAt,
        content: [{ type: "text", text: canaries.prompt }],
      },
    }),
    event("message.completed", {
      message: {
        schemaVersion: 1,
        messageId: "message-assistant",
        role: "assistant",
        createdAt: occurredAt,
        content: [{ type: "text", text: canaries.completion }],
        provider: { api: "fixture", provider: "fixture", model: "fixture", configKey: "fixture" },
        assistant: { stopReason: "stop" },
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 2,
          costUsd: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    }),
    event("tool.requested", {
      toolCallId: "tool-1",
      toolName: "lookup",
      arguments: { secret: canaries.toolArgument },
    }),
    event("tool.completed", {
      toolCallId: "tool-1",
      toolName: "lookup",
      isError: false,
      result: { text: canaries.toolResult },
    }),
    event("run.failed", { code: "provider.failed", retryable: false, detail: canaries.failure }),
  ];

  const logs = events.map(operationalLogLine).join("\n");
  for (const canary of Object.values(canaries)) assert.doesNotMatch(logs, new RegExp(canary));
  assert.doesNotMatch(logs, /contentHash|argumentsHash|resultHash/);
  assert.match(logs, /contentBytes/);
  assert.match(logs, /provider\.failed/);
});

test("the air-gapped fetch boundary denies public egress before the network delegate", async () => {
  let calls = 0;
  let receivedMethod = "";
  const delegate = (async (input: string | URL | Request) => {
    calls += 1;
    receivedMethod = input instanceof Request ? input.method : "GET";
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  const guard = new AirGappedEgressGuard([
    "http://127.0.0.1:11434",
    "https://model-gateway.internal",
  ]);
  const guarded = guard.guardedFetch(delegate);

  await assert.rejects(guarded("https://api.openai.com/v1/embeddings"), EgressDeniedError);
  assert.equal(calls, 0);
  assert.equal((await guarded(new Request("http://127.0.0.1:11434/api/embed", {
    method: "POST",
    body: "probe",
  }))).status, 200);
  assert.equal(calls, 1);
  assert.equal(receivedMethod, "POST");
});

test("the air-gapped boundary rejects redirects even when their target is allowlisted", async () => {
  const guard = new AirGappedEgressGuard(["http://127.0.0.1:11434"]);
  const delegate = (async () => new Response(null, {
    status: 307,
    headers: { location: "/other" },
  })) as typeof fetch;

  await assert.rejects(
    guard.guardedFetch(delegate)("http://127.0.0.1:11434/api/embed"),
    /redirects are disabled/,
  );
});
