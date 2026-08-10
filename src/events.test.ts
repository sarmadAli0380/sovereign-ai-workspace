import assert from "node:assert/strict";
import test from "node:test";
import {
  RUN_EVENT_SCHEMA_VERSION,
  RUN_EVENT_SENSITIVITY,
  RunEventValidationError,
  assertRunEventSequence,
  collectRunEventIssues,
  collectRunEventSequenceIssues,
  isTerminalRunEvent,
  parseRunEvent,
  type RunEvent,
  type RunEventOf,
  type RunEventPayloadMap,
  type RunEventType,
} from "./events.ts";

const occurredAt = "2026-08-10T12:00:00.000Z";

function event<TType extends RunEventType>(
  type: TType,
  payload: RunEventPayloadMap[TType],
  sequence = 0,
  overrides: Partial<RunEventOf<TType>> = {},
): RunEventOf<TType> {
  return {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    eventId: `event-${sequence}`,
    runId: "run-1",
    conversationId: "conversation-1",
    sequence,
    turn: type === "run.started" ? 0 : 1,
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

const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10 };
const argumentsHash = "a".repeat(64);

const fixtures: readonly RunEvent[] = [
  event("run.started", { configKey: "local-qwen", provider: "ollama", model: "qwen3:4b" }),
  event("turn.started", { inputMessageId: "message-user-1" }, 1),
  event(
    "message.delta",
    { messageId: "message-assistant-1", index: 0, blockType: "text", delta: "hello" },
    2,
  ),
  event(
    "message.completed",
    {
      messageId: "message-assistant-1",
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      provider: "ollama",
      model: "qwen3:4b",
      usage,
    },
    3,
  ),
  event("tool.requested", { toolCallId: "call-1", toolName: "read_file", arguments: { path: "a" } }, 4),
  event(
    "tool.decision",
    {
      toolCallId: "call-1",
      toolName: "read_file",
      decision: "allow",
      reasonCode: "workspace.read.allowed",
      detail: "permitted for this workspace",
    },
    5,
  ),
  event("tool.started", { toolCallId: "call-1", toolName: "read_file" }, 6),
  event(
    "tool.completed",
    { toolCallId: "call-1", toolName: "read_file", isError: false, result: { text: "value" } },
    7,
  ),
  event(
    "approval.requested",
    {
      approvalId: "approval-1",
      toolCallId: "call-2",
      toolName: "write_file",
      capability: "workspace.write",
      argumentsHash,
      expiresAt: occurredAt,
    },
    8,
  ),
  event(
    "approval.resolved",
    {
      approvalId: "approval-1",
      toolCallId: "call-2",
      decision: "approved",
      actorId: "user-1",
      reasonCode: "user.approved",
    },
    9,
  ),
  event("turn.completed", { stopReason: "stop", usage }, 10),
  event("run.completed", { reason: "stop", usage }, 11),
  event("run.failed", { code: "provider.unavailable", retryable: true, detail: "offline" }, 12),
  event("run.cancelled", { code: "user.cancelled", cancelledBy: "user-1", detail: "stop" }, 13),
];

test("every initial event payload has a valid runtime fixture", () => {
  for (const fixture of fixtures) {
    assert.deepEqual(collectRunEventIssues(fixture), [], fixture.type);
    assert.equal(parseRunEvent(fixture), fixture);
  }
});

test("events round-trip through JSON without changing stable identifiers", () => {
  for (const fixture of fixtures) {
    const replayed = parseRunEvent(JSON.parse(JSON.stringify(fixture)));
    assert.deepEqual(replayed, fixture);
    assert.equal(replayed.eventId, fixture.eventId);
    assert.equal(replayed.runId, fixture.runId);
    assert.equal(replayed.sequence, fixture.sequence);
  }
});

test("rejects unknown future versions instead of silently reinterpreting them", () => {
  const future = { ...fixtures[0], schemaVersion: 2 };
  assert.throws(
    () => parseRunEvent(future),
    (error: unknown) =>
      error instanceof RunEventValidationError &&
      error.message.includes("unsupported version 2") &&
      error.message.includes("supported version is 1"),
  );
});

test("allows forward data only through the declared extensions field", () => {
  const base = fixtures[0] as RunEvent;
  assert.deepEqual(
    collectRunEventIssues({ ...base, unexpected: "future" }),
    ["event.unexpected: unknown field"],
  );
  assert.deepEqual(
    collectRunEventIssues({ ...base, extensions: { vendor: { trace: "opaque" } } }),
    [],
  );
});

test("schema-owned sensitivity cannot be weakened by the emitter", () => {
  const contentEvent = event(
    "tool.requested",
    { toolCallId: "call-1", toolName: "shell", arguments: { command: "secret" } },
    1,
    { sensitivity: "metadata" },
  );
  assert.throws(
    () => parseRunEvent(contentEvent),
    /tool\.requested must be classified as content/,
  );
});

test("canonical content cannot be relabelled as an audit or log event", () => {
  const mislabeled = event(
    "tool.requested",
    { toolCallId: "call-1", toolName: "shell", arguments: { command: "secret" } },
    1,
    { audience: "operational" as never },
  );
  assert.throws(
    () => parseRunEvent(mislabeled),
    /canonical content event must target ui or persistence; use projectRunEvent/,
  );
});

test("timestamps must use an explicit RFC 3339 representation", () => {
  const invalid = { ...fixtures[0], occurredAt: "0" };
  assert.throws(() => parseRunEvent(invalid), /occurredAt: must be an RFC 3339 timestamp/);
});

test("rejects non-JSON payloads, non-finite numbers, and circular structures", () => {
  const circular: Record<string, unknown> = {};
  circular["self"] = circular;
  const invalid = event("tool.completed", {
    toolCallId: "call-1",
    toolName: "bad",
    isError: false,
    result: circular as never,
  });
  const issues = collectRunEventIssues(invalid);
  assert.ok(issues.some((issue) => issue.includes("circular references")));

  const invalidUsage = event("run.completed", {
    reason: "stop",
    usage: { ...usage, totalTokens: Number.NaN },
  });
  assert.ok(collectRunEventIssues(invalidUsage).some((issue) => issue.includes("totalTokens")));

  const nonPlain = event("message.completed", {
    messageId: "message-1",
    role: "assistant",
    content: new Date(occurredAt) as never,
  });
  assert.ok(collectRunEventIssues(nonPlain).some((issue) => issue.includes("plain JSON object")));
});

test("a complete ordered run passes the sequence contract", () => {
  const events: RunEvent[] = [
    event("run.started", { configKey: "local", provider: "ollama", model: "qwen" }, 10),
    event("turn.started", {}, 20),
    event(
      "message.completed",
      { messageId: "m1", role: "assistant", content: [{ type: "text", text: "done" }] },
      30,
    ),
    event("turn.completed", { stopReason: "stop" }, 40),
    event("run.completed", { reason: "stop" }, 50),
  ];
  assert.deepEqual(collectRunEventSequenceIssues(events, { complete: true }), []);
  assert.doesNotThrow(() => assertRunEventSequence(events, { complete: true }));
  assert.equal(isTerminalRunEvent(events.at(-1) as RunEvent), true);
  assert.equal(isTerminalRunEvent(events[1] as RunEvent), false);
});

test("sequence validation rejects duplicates, backwards ordering, and identity changes", () => {
  const start = event("run.started", { configKey: "local", provider: "ollama", model: "qwen" }, 1);
  const bad = [
    start,
    event("turn.started", {}, 1, { eventId: start.eventId }),
    event("run.completed", { reason: "stop" }, 0, { runId: "run-other" }),
  ];
  const issues = collectRunEventSequenceIssues(bad, { complete: true });
  assert.ok(issues.some((issue) => issue.includes("duplicate eventId")));
  assert.ok(issues.filter((issue) => issue.includes("strictly increasing")).length >= 2);
  assert.ok(issues.some((issue) => issue.includes("runId changed")));
});

test("a run has exactly one terminal event and nothing may follow it", () => {
  const start = event("run.started", { configKey: "local", provider: "ollama", model: "qwen" }, 1);
  const completed = event("run.completed", { reason: "stop" }, 2);
  const after = event(
    "message.completed",
    { messageId: "late", role: "assistant", content: "must not exist" },
    3,
  );
  const cancelled = event("run.cancelled", { code: "user.cancelled" }, 4);
  const issues = collectRunEventSequenceIssues([start, completed, after, cancelled], {
    complete: true,
  });
  assert.ok(issues.some((issue) => issue.includes("more than one terminal")));
  assert.ok(issues.some((issue) => issue.includes("no event may follow a terminal")));
});

test("a complete run cannot restart itself", () => {
  const events = [
    event("run.started", { configKey: "local", provider: "ollama", model: "qwen" }, 1),
    event("run.started", { configKey: "local", provider: "ollama", model: "qwen" }, 2),
    event("run.completed", { reason: "stop" }, 3),
  ];
  assert.ok(
    collectRunEventSequenceIssues(events, { complete: true }).some((issue) =>
      issue.includes("exactly one run.started"),
    ),
  );
});

test("PROPERTY: generated complete runs preserve ordering and terminal uniqueness", () => {
  for (let seed = 1; seed <= 200; seed += 1) {
    const count = seed % 17;
    const generated: RunEvent[] = [
      event("run.started", { configKey: "local", provider: "ollama", model: "qwen" }, 0),
      event("turn.started", {}, 10),
    ];
    for (let index = 0; index < count; index += 1) {
      generated.push(
        event(
          "message.delta",
          { messageId: "message-1", index, blockType: "text", delta: `chunk-${seed}-${index}` },
          20 + index * 10,
        ),
      );
    }
    generated.push(event("turn.completed", { stopReason: "stop" }, 20 + count * 10));
    generated.push(event("run.completed", { reason: seed % 2 === 0 ? "stop" : "maxTurns" }, 30 + count * 10));

    assert.deepEqual(collectRunEventSequenceIssues(generated, { complete: true }), [], `seed ${seed}`);
    assert.equal(generated.filter(isTerminalRunEvent).length, 1, `seed ${seed}`);
  }
});
