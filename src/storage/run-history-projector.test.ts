import assert from "node:assert/strict";
import test from "node:test";
import { RUN_EVENT_SENSITIVITY, type RunEvent } from "../events.ts";
import type { JournalDelivery } from "./durable-journal.ts";
import { RunHistoryProjector } from "./run-history-projector.ts";
import type { SqlExecutor, SqlQueryResult } from "./sql.ts";

const occurredAt = "2026-08-21T13:00:00.000Z";

class RecordingExecutor implements SqlExecutor {
  readonly calls: { sql: string; values: readonly unknown[] }[] = [];
  readonly results: SqlQueryResult[] = [];

  async query(sql: string, values: readonly unknown[] = []): Promise<SqlQueryResult> {
    this.calls.push({ sql, values });
    return this.results.shift() ?? { rows: [{ id: String(values[0]) }], rowCount: 1 };
  }
}

function delivery(event: RunEvent, journalSeq = 41): JournalDelivery {
  return { deliveryId: event.eventId, journalSeq, event };
}

function base<T extends RunEvent["type"]>(
  type: T,
  payload: Extract<RunEvent, { type: T }>["payload"],
  turn = 1,
): Extract<RunEvent, { type: T }> {
  return {
    schemaVersion: 1,
    eventId: `event-${type}`,
    runId: "run-1",
    conversationId: "conversation-1",
    sequence: 1,
    turn,
    occurredAt,
    type,
    causationId: "request-1",
    audience: "persistence",
    sensitivity: RUN_EVENT_SENSITIVITY[type],
    payload,
  } as Extract<RunEvent, { type: T }>;
}

test("run and turn starts are idempotent inserts with deterministic identities", async () => {
  const database = new RecordingExecutor();
  const projector = new RunHistoryProjector(database);
  await projector.apply(delivery(base("run.started", {
    configKey: "local-qwen",
    provider: "ollama",
    model: "qwen3:4b",
  }, 0)));
  await projector.apply(delivery(base("turn.started", { inputMessageId: "message-user" })));

  assert.match(database.calls[0]!.sql, /INSERT INTO runs/);
  assert.match(database.calls[0]!.sql, /ON CONFLICT \(id\) DO NOTHING/);
  assert.match(database.calls[1]!.sql, /INSERT INTO turns/);
  assert.equal(database.calls[1]!.values[0], "run-1:turn:1");
});

test("completed messages serialize conversation sequence allocation and keep content out of SQL text", async () => {
  const database = new RecordingExecutor();
  const projector = new RunHistoryProjector(database);
  const canary = "completed-message-canary-47b983b6";
  await projector.apply(delivery(base("message.completed", {
    message: {
      schemaVersion: 1,
      messageId: "message-assistant",
      role: "assistant",
      createdAt: occurredAt,
      content: [{ type: "text", text: canary }],
      provider: { api: "fixture", provider: "fixture", model: "fixture", configKey: "fixture" },
      assistant: { stopReason: "stop" },
      usage: {
        inputTokens: 2,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 3,
        costUsd: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  }), 77));

  assert.match(database.calls[0]!.sql, /INSERT INTO messages/);
  assert.match(database.calls[0]!.sql, /FOR UPDATE/);
  assert.match(database.calls[0]!.sql, /MAX\(existing_message\.seq\) \+ 1/);
  assert.match(String(database.calls[0]!.values[4]), new RegExp(canary));
  assert.doesNotMatch(database.calls[0]!.sql, new RegExp(canary));
});

test("terminal events materialize bounded run metadata and no message", async () => {
  const database = new RecordingExecutor();
  const projector = new RunHistoryProjector(database);
  await projector.apply(delivery(base("run.cancelled", {
    code: "deadline.exceeded",
    detail: "provider-content-must-not-enter-run-row",
  })));

  assert.equal(database.calls.length, 1);
  assert.match(database.calls[0]!.sql, /UPDATE runs/);
  assert.deepEqual(database.calls[0]!.values.slice(1, 5), [
    "cancelled",
    "cancelled",
    "deadline.exceeded",
    null,
  ]);
  assert.doesNotMatch(database.calls[0]!.sql, /provider-content/);
  assert.equal(database.calls[0]!.values.includes("provider-content-must-not-enter-run-row"), false);
});

test("C3 projector materializes tool requests, policy decisions, and pending approvals", async () => {
  const database = new RecordingExecutor();
  const projector = new RunHistoryProjector(database);
  await projector.apply(delivery(base("tool.requested", {
    toolCallId: "call-1", toolName: "write_file", arguments: { path: "a.txt" },
  })));
  await projector.apply(delivery(base("tool.decision", {
    toolCallId: "call-1", toolName: "write_file", capability: "filesystem.write",
    capabilities: ["filesystem.write"], decision: "requireApproval",
    reasonCode: "policy.approval-required",
  })));
  await projector.apply(delivery(base("approval.requested", {
    approvalId: "approval-1", toolCallId: "call-1", toolName: "write_file",
    capability: "filesystem.write", argumentsHash: "a".repeat(64),
    expiresAt: "2026-08-25T14:00:00.000Z",
  })));

  assert.match(database.calls[0]!.sql, /INSERT INTO tool_calls/);
  assert.match(database.calls[1]!.sql, /INSERT INTO tool_decisions/);
  assert.match(database.calls[2]!.sql, /INSERT INTO approvals/);
  assert.match(database.calls[2]!.sql, /requireApproval/);
});

test("non-history events are acknowledged without issuing SQL", async () => {
  const database = new RecordingExecutor();
  const projector = new RunHistoryProjector(database);
  await projector.apply(delivery(base("tool.started", { toolCallId: "tool-1", toolName: "read_file" })));
  assert.equal(database.calls.length, 0);
});

test("conflicting replay and delivery identity mismatch fail closed", async () => {
  const database = new RecordingExecutor();
  database.results.push({ rows: [], rowCount: 0 });
  const projector = new RunHistoryProjector(database);
  const started = base("run.started", { configKey: "fixture", provider: "fixture", model: "fixture" }, 0);

  await assert.rejects(projector.apply(delivery(started)), /conflicted/);
  await assert.rejects(
    projector.apply({ ...delivery(started), deliveryId: "another-event" }),
    /delivery identity/,
  );
});
