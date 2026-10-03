import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { AssistantMessage, Message, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import {
  collectProductMessageIssues,
  collectProductRunTerminationIssues,
  decodeProductMessageEnvelope,
  encodeProductMessageEnvelope,
  mapAssistantPersistenceOutcome,
  parseProductMessageEnvelope,
  parseProductRunTermination,
  ProductMessageMappingError,
  ProductMessageValidationError,
  productEnvelopeToRuntimeMessage,
  runtimeMessageToProductEnvelope,
} from "./codec.ts";
import { PRODUCT_MESSAGE_SCHEMA_VERSION } from "./envelope.ts";

const timestamp = Date.parse("2026-08-10T12:00:00.000Z");
const usage: Usage = {
  input: 100,
  output: 20,
  cacheRead: 80,
  cacheWrite: 5,
  cacheWrite1h: 3,
  reasoning: 10,
  totalTokens: 205,
  cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 },
};

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "done", textSignature: "opaque-text" }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-fixture",
    usage,
    stopReason: "stop",
    timestamp,
    ...overrides,
  };
}

test("maps user text into a product-owned block without provider metadata", () => {
  const runtime: Message = { role: "user", content: "hello", timestamp };
  const mapped = runtimeMessageToProductEnvelope(runtime, { messageId: "message-user-1" });

  assert.deepEqual(mapped, {
    schemaVersion: PRODUCT_MESSAGE_SCHEMA_VERSION,
    messageId: "message-user-1",
    role: "user",
    createdAt: "2026-08-10T12:00:00.000Z",
    content: [{ type: "text", text: "hello" }],
  });
});

test("maps assistant text, thinking, tool calls, provider metadata, usage, and cost", () => {
  const runtime = assistant({
    content: [
      { type: "text", text: "answer", textSignature: "opaque-text" },
      {
        type: "thinking",
        thinking: "reasoning",
        thinkingSignature: "opaque-thinking",
        redacted: true,
      },
      {
        type: "toolCall",
        id: "call-1",
        name: "read_file",
        arguments: { path: "README.md" },
        thoughtSignature: "opaque-tool",
      },
    ],
    responseModel: "gpt-response-model",
    responseId: "response-1",
    diagnostics: [
      {
        type: "retry",
        timestamp,
        error: { message: "first attempt failed", code: 429 },
        details: { attempt: 1 },
      },
    ],
    stopReason: "toolUse",
  });
  const mapped = runtimeMessageToProductEnvelope(runtime, {
    messageId: "message-assistant-1",
    configKey: "codex-default",
  });

  assert.equal(mapped.assistant?.stopReason, "toolUse");
  assert.deepEqual(mapped.content[1], {
    type: "thinking",
    text: "reasoning",
    signature: "opaque-thinking",
    redacted: true,
  });
  assert.deepEqual(mapped.content[2], {
    type: "toolCall",
    toolCallId: "call-1",
    toolName: "read_file",
    arguments: { path: "README.md" },
    thoughtSignature: "opaque-tool",
  });
  assert.equal(mapped.provider?.responseModel, "gpt-response-model");
  assert.equal(mapped.provider?.diagnostics?.[0]?.occurredAt, "2026-08-10T12:00:00.000Z");
  assert.deepEqual(mapped.usage, {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 80,
    cacheWriteTokens: 5,
    cacheWrite1hTokens: 3,
    reasoningTokens: 10,
    totalTokens: 205,
    costUsd: usage.cost,
  });
});

test("maps tool results including images, details, usage, and deferred tool names", () => {
  const runtime: ToolResultMessage = {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "capture",
    content: [
      { type: "text", text: "captured" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ],
    details: { width: 100 },
    usage,
    addedToolNames: ["inspect_image"],
    isError: false,
    timestamp,
  };
  const mapped = runtimeMessageToProductEnvelope(runtime, { messageId: "message-tool-1" });

  assert.equal(mapped.role, "toolResult");
  assert.deepEqual(mapped.toolResult, {
    toolCallId: "call-1",
    toolName: "capture",
    isError: false,
    details: { width: 100 },
    addedToolNames: ["inspect_image"],
  });
  assert.equal(mapped.content[1]?.type, "image");
  assert.equal(mapped.usage?.costUsd.total, usage.cost.total);
});

test("provider extension capture is explicit and absent by default", () => {
  const withoutExtension = runtimeMessageToProductEnvelope(assistant(), {
    messageId: "message-1",
  });
  assert.equal(withoutExtension.extensions, undefined);

  const withExtension = runtimeMessageToProductEnvelope(assistant(), {
    messageId: "message-2",
    providerBlocks: [
      { provider: "openai", kind: "encrypted_reasoning", data: { payload: "opaque" } },
    ],
  });
  assert.deepEqual(withExtension.extensions?.providerBlocks[0], {
    provider: "openai",
    kind: "encrypted_reasoning",
    data: { payload: "opaque" },
  });
});

test("failed and aborted results become terminal metadata, never completed messages", () => {
  const failed = assistant({
    content: [{ type: "text", text: "fabricated-error-message-canary" }],
    stopReason: "error",
    errorMessage: "provider offline",
  });
  const cancelled = assistant({
    content: [{ type: "text", text: "partial-draft-canary" }],
    stopReason: "aborted",
    errorMessage: "cancelled by caller",
  });

  const failedOutcome = mapAssistantPersistenceOutcome(failed, {
    messageId: "must-not-exist",
    retryable: true,
  });
  const cancelledOutcome = mapAssistantPersistenceOutcome(cancelled, {
    messageId: "must-not-exist-either",
  });
  assert.equal(failedOutcome.kind, "terminal");
  assert.equal(cancelledOutcome.kind, "terminal");
  assert.doesNotMatch(JSON.stringify(failedOutcome), /fabricated-error-message-canary|messageId/);
  assert.doesNotMatch(JSON.stringify(cancelledOutcome), /partial-draft-canary|messageId/);
  if (failedOutcome.kind === "terminal" && failedOutcome.terminal.kind === "failed") {
    assert.equal(failedOutcome.terminal.retryable, true);
    assert.equal(failedOutcome.terminal.detail, "provider offline");
    assert.equal(failedOutcome.terminal.usage?.costUsd.total, usage.cost.total);
  }
  if (cancelledOutcome.kind === "terminal") {
    assert.equal(cancelledOutcome.terminal.kind, "cancelled");
  }
  assert.throws(
    () => runtimeMessageToProductEnvelope(failed, { messageId: "bad" }),
    ProductMessageMappingError,
  );
});

test("terminal metadata validates provider extensions and failed/cancelled shape", () => {
  assert.throws(
    () =>
      mapAssistantPersistenceOutcome(assistant({ stopReason: "error" }), {
        messageId: "unused",
        providerBlocks: [
          {
            provider: "openai",
            kind: "bad",
            data: { invalid: Number.NaN },
          },
        ],
      }),
    /JSON numbers must be finite/,
  );
  assert.ok(
    collectProductRunTerminationIssues({
      kind: "cancelled",
      code: "user.cancelled",
      occurredAt: "2026-08-10T12:00:00.000Z",
      retryable: true,
    }).some((issue) => issue.includes("not allowed for a cancelled run")),
  );
  assert.equal(
    parseProductRunTermination({
      kind: "failed",
      code: "provider.error",
      occurredAt: "2026-08-10T12:00:00.000Z",
      retryable: false,
    }).kind,
    "failed",
  );
});

test("codec round-trips into an owned snapshot", () => {
  const mapped = runtimeMessageToProductEnvelope(assistant(), { messageId: "message-1" });
  const decoded = decodeProductMessageEnvelope(encodeProductMessageEnvelope(mapped));
  assert.deepEqual(decoded, mapped);

  (decoded.content[0] as { text: string }).text = "mutated";
  assert.equal((mapped.content[0] as { text: string }).text, "done");
});

test("durable envelopes rebuild the runtime user, assistant, and tool-result union", () => {
  const runtimeMessages: Message[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "hello", textSignature: "user-signature" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
      timestamp,
    },
    assistant({
      content: [
        { type: "thinking", thinking: "reason", thinkingSignature: "opaque", redacted: true },
        { type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "a" } },
      ],
      diagnostics: [{ type: "retry", timestamp, details: { attempt: 1 } }],
      responseId: "response-1",
    }),
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read_file",
      content: [{ type: "text", text: "result" }],
      details: { path: "a" },
      usage,
      addedToolNames: ["write_file"],
      isError: false,
      timestamp,
    },
  ];

  for (const [index, runtime] of runtimeMessages.entries()) {
    const envelope = runtimeMessageToProductEnvelope(runtime, { messageId: `message-${index}` });
    assert.deepEqual(productEnvelopeToRuntimeMessage(envelope), runtime);
  }
});

test("runtime validation rejects unknown versions, undeclared fields, and invalid role metadata", () => {
  const mapped = runtimeMessageToProductEnvelope(assistant(), { messageId: "message-1" });
  assert.throws(
    () => parseProductMessageEnvelope({ ...mapped, schemaVersion: 2 }),
    /unsupported version 2/,
  );
  assert.throws(
    () => parseProductMessageEnvelope({ ...mapped, future: true }),
    /future: unknown field/,
  );
  assert.throws(
    () => parseProductMessageEnvelope({ ...mapped, role: "user" }),
    (error: unknown) =>
      error instanceof ProductMessageValidationError &&
      error.issues.some((issue) => issue.includes("not allowed for role user")),
  );
});

test("runtime validation rejects non-JSON extension/details values and impossible usage subsets", () => {
  const mapped = runtimeMessageToProductEnvelope(assistant(), { messageId: "message-1" });
  const invalidUsage = {
    ...mapped,
    usage: { ...mapped.usage, reasoningTokens: 21, outputTokens: 20 },
  };
  assert.ok(
    collectProductMessageIssues(invalidUsage).some((issue) =>
      issue.includes("reasoningTokens: cannot exceed outputTokens"),
    ),
  );
  assert.throws(
    () =>
      runtimeMessageToProductEnvelope(
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bad",
          content: [{ type: "text", text: "bad" }],
          details: { value: Number.NaN },
          isError: false,
          timestamp,
        },
        { messageId: "message-tool-bad" },
      ),
    /JSON numbers must be finite/,
  );
});

test("a checked-in version-1 fixture remains readable without the runtime dependency shape", async () => {
  type SimulatedFutureRuntimeMessage = {
    speaker: "model";
    parts: readonly { kind: string; value: unknown }[];
    accounting: { prompt: number; completion: number };
  };
  const simulatedFutureRuntime: SimulatedFutureRuntimeMessage = {
    speaker: "model",
    parts: [{ kind: "answer", value: "a deliberately incompatible runtime shape" }],
    accounting: { prompt: 1, completion: 1 },
  };
  const fixture = await readFile(new URL("./fixtures/v1-assistant.json", import.meta.url), "utf8");
  const decoded = decodeProductMessageEnvelope(fixture);

  assert.equal(simulatedFutureRuntime.speaker, "model");
  assert.equal(decoded.schemaVersion, 1);
  assert.equal(decoded.messageId, "message-fixture-v1");
  assert.equal(decoded.provider?.model, "fixture-model-v1");
  assert.equal(decoded.extensions?.providerBlocks[0]?.data["opaque"], "retained-v1");
});

test("invalid timestamps and malformed JSON fail explicitly", () => {
  assert.throws(
    () => runtimeMessageToProductEnvelope({ role: "user", content: "bad", timestamp: Number.NaN }, { messageId: "m" }),
    /finite non-negative timestamp/,
  );
  assert.throws(() => decodeProductMessageEnvelope("{"), SyntaxError);
  assert.throws(
    () =>
      runtimeMessageToProductEnvelope(assistant({ responseId: "" }), {
        messageId: "message-invalid-response-id",
      }),
    /responseId: must be a non-empty string/,
  );
});
