import assert from "node:assert/strict";
import test from "node:test";
import {
  fingerprintContent,
  projectRunEvent,
  type AuditMessageCompletedPayload,
  type AuditToolRequestedPayload,
  type OperationalMessageCompletedPayload,
  type OperationalApprovalRequestedPayload,
  type OperationalToolRequestedPayload,
} from "./event-projections.ts";
import {
  RUN_EVENT_SCHEMA_VERSION,
  RUN_EVENT_SENSITIVITY,
  RunEventValidationError,
  type RunEventOf,
  type RunEventPayloadMap,
  type RunEventType,
} from "./events.ts";

const occurredAt = "2026-08-10T12:00:00.000Z";

function event<TType extends RunEventType>(
  type: TType,
  payload: RunEventPayloadMap[TType],
  overrides: Partial<RunEventOf<TType>> = {},
): RunEventOf<TType> {
  return {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    eventId: `event-${type}`,
    runId: "run-1",
    conversationId: "conversation-1",
    sequence: 1,
    turn: 1,
    occurredAt,
    type,
    causationId: "command-1",
    correlationId: "request-1",
    audience: type === "message.delta" ? "ui" : "persistence",
    sensitivity: RUN_EVENT_SENSITIVITY[type],
    payload,
    ...overrides,
  } as RunEventOf<TType>;
}

test("UI and persistence projections retain authorized content in owned snapshots", () => {
  const original = event(
    "message.completed",
    {
      messageId: "message-1",
      role: "assistant",
      content: [{ type: "text", text: "authorized-content" }],
      provider: "ollama",
      model: "qwen3:4b",
    },
    { extensions: { providerTrace: "full-only-extension" } },
  );

  const ui = projectRunEvent(original, "ui");
  const persistence = projectRunEvent(original, "persistence");
  assert.equal(ui.audience, "ui");
  assert.equal(persistence.audience, "persistence");
  assert.match(JSON.stringify(ui), /authorized-content/);
  assert.match(JSON.stringify(persistence), /full-only-extension/);

  (ui.payload.content as Array<Record<string, string>>)[0]!["text"] = "mutated";
  assert.match(JSON.stringify(original), /authorized-content/);
  assert.doesNotMatch(JSON.stringify(original), /mutated/);
});

test("audit projection replaces message content with a deterministic fingerprint", () => {
  const content = { b: "two", a: "one" };
  const original = event("message.completed", {
    messageId: "message-1",
    role: "assistant",
    content,
    provider: "ollama",
    model: "qwen3:4b",
  });
  const audit = projectRunEvent(original, "audit");
  const payload = audit.payload as AuditMessageCompletedPayload;

  assert.equal(audit.audience, "audit");
  assert.equal(payload.contentHash, fingerprintContent({ a: "one", b: "two" }).sha256);
  assert.ok(payload.contentBytes > 0);
  assert.doesNotMatch(JSON.stringify(audit), /one|two/);
});

test("operational projection reports size but omits content hashes", () => {
  const original = event("message.completed", {
    messageId: "message-1",
    role: "assistant",
    content: "private-message-canary",
  });
  const operational = projectRunEvent(original, "operational");
  const payload = operational.payload as OperationalMessageCompletedPayload;

  assert.equal(operational.audience, "operational");
  assert.equal(typeof payload.contentBytes, "number");
  assert.equal("contentHash" in payload, false);
  assert.doesNotMatch(JSON.stringify(operational), /private-message-canary/);
});

test("streaming deltas are ephemeral and never enter persistence or audit", () => {
  const delta = event("message.delta", {
    messageId: "message-1",
    index: 0,
    blockType: "text",
    delta: "stream-delta-canary",
  });
  assert.equal(projectRunEvent(delta, "persistence"), null);
  assert.equal(projectRunEvent(delta, "audit"), null);

  const ui = projectRunEvent(delta, "ui");
  const operational = projectRunEvent(delta, "operational");
  assert.equal(ui.payload.delta, "stream-delta-canary");
  assert.equal(operational.payload.deltaBytes, Buffer.byteLength("stream-delta-canary"));
  assert.doesNotMatch(JSON.stringify(operational), /stream-delta-canary/);
});

test("tool arguments are content-bearing and never enter audit or logs", () => {
  const original = event("tool.requested", {
    toolCallId: "call-1",
    toolName: "shell",
    arguments: {
      command: "upload tool-argument-canary",
      token: "tool-secret-canary",
    },
  });
  const audit = projectRunEvent(original, "audit");
  const operational = projectRunEvent(original, "operational");
  const auditPayload = audit.payload as AuditToolRequestedPayload;
  const operationalPayload = operational.payload as OperationalToolRequestedPayload;

  assert.equal(auditPayload.argumentsHash.length, 64);
  assert.ok(auditPayload.argumentsBytes > 0);
  assert.equal("argumentsHash" in operationalPayload, false);
  for (const projection of [audit, operational]) {
    assert.doesNotMatch(JSON.stringify(projection), /tool-argument-canary|tool-secret-canary/);
  }
});

test("tool results, decision detail, and failure detail are schema-redacted", () => {
  const contentEvents = [
    event("tool.completed", {
      toolCallId: "call-1",
      toolName: "read_file",
      isError: false,
      result: { text: "tool-result-canary" },
    }),
    event("tool.decision", {
      toolCallId: "call-1",
      toolName: "read_file",
      decision: "deny",
      reasonCode: "policy.denied",
      detail: "decision-detail-canary",
    }),
    event("run.failed", {
      code: "provider.failed",
      retryable: false,
      detail: "failure-detail-canary",
    }),
    event("run.cancelled", {
      code: "user.cancelled",
      cancelledBy: "user-1",
      detail: "cancel-detail-canary",
    }),
  ] as const;

  for (const contentEvent of contentEvents) {
    const auditJson = JSON.stringify(projectRunEvent(contentEvent, "audit"));
    const operationalJson = JSON.stringify(projectRunEvent(contentEvent, "operational"));
    assert.doesNotMatch(
      `${auditJson}${operationalJson}`,
      /tool-result-canary|decision-detail-canary|failure-detail-canary|cancel-detail-canary/,
      contentEvent.type,
    );
  }
});

test("extensions are retained for full audiences and dropped from metadata audiences", () => {
  const original = event(
    "run.started",
    { configKey: "local", provider: "ollama", model: "qwen" },
    { extensions: { vendorPayload: "extension-secret-canary" } },
  );

  assert.match(JSON.stringify(projectRunEvent(original, "ui")), /extension-secret-canary/);
  assert.match(JSON.stringify(projectRunEvent(original, "persistence")), /extension-secret-canary/);
  assert.doesNotMatch(JSON.stringify(projectRunEvent(original, "audit")), /extension-secret-canary/);
  assert.doesNotMatch(
    JSON.stringify(projectRunEvent(original, "operational")),
    /extension-secret-canary/,
  );
});

test("audit marks fingerprints as derived content and logs omit approval hashes", () => {
  const requested = event("approval.requested", {
    approvalId: "approval-1",
    toolCallId: "call-1",
    toolName: "write_file",
    capability: "workspace.write",
    argumentsHash: "a".repeat(64),
    expiresAt: occurredAt,
  });
  const audit = projectRunEvent(requested, "audit");
  const operational = projectRunEvent(requested, "operational");
  assert.equal(audit.sensitivity, "derived-content");
  assert.equal(operational.sensitivity, "metadata");
  assert.equal(
    "argumentsHash" in (operational.payload as OperationalApprovalRequestedPayload),
    false,
  );
});

test("fingerprints are stable across object insertion order", () => {
  assert.deepEqual(
    fingerprintContent({ alpha: 1, nested: { x: true, y: false } }),
    fingerprintContent({ nested: { y: false, x: true }, alpha: 1 }),
  );
});

test("projection validates its input at runtime", () => {
  const malformed = event("tool.requested", {
    toolCallId: "call-1",
    toolName: "shell",
    arguments: { command: "safe" },
  });
  (malformed.payload as unknown as Record<string, unknown>)["arguments"] = {
    command: Number.NaN,
  };
  assert.throws(() => projectRunEvent(malformed, "audit"), RunEventValidationError);
});
