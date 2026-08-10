import assert from "node:assert/strict";
import test from "node:test";
import {
  assistantMessageFingerprint,
  collectAssistantMessageIssues,
  inspectOllamaRuntime,
} from "./conformance.ts";

function valid() {
  return {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    api: "faux",
    provider: "faux",
    model: "m",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

test("accepts a successful runtime AssistantMessage shape", () => {
  assert.deepEqual(collectAssistantMessageIssues(valid(), { requireSuccess: true, requireText: true }), []);
});

test("rejects two identically malformed numeric shapes", () => {
  const malformed = valid();
  (malformed.usage as unknown as Record<string, unknown>).input = "1";
  (malformed.usage.cost as unknown as Record<string, unknown>).total = "free";
  const issues = collectAssistantMessageIssues(malformed);
  assert.ok(issues.includes("usage.input must be a finite non-negative number"));
  assert.ok(issues.includes("usage.cost.total must be a finite non-negative number"));
});

test("requires a real tool call when the conformance leg claims to test tools", () => {
  assert.deepEqual(
    collectAssistantMessageIssues(valid(), { requireToolCall: true }),
    ["no toolCall block was returned"],
  );
});

test("validates tool-call fields instead of accepting any typed block", () => {
  const message = valid();
  message.content = [{ type: "toolCall", text: "" }];
  message.stopReason = "toolUse";
  const issues = collectAssistantMessageIssues(message, { requireToolCall: true });
  assert.ok(issues.some((issue) => issue.includes(".id")));
  assert.ok(issues.some((issue) => issue.includes(".arguments")));
});

test("fingerprints actual runtime types for diagnostics", () => {
  const message = valid();
  const shape = assistantMessageFingerprint(message);
  assert.equal(shape["usage.input"], "number");
  assert.equal(shape["usage.cost.total"], "number");
  assert.equal(shape["content[].types"], "text");
});

test("accepts an Ollama runner whose served context matches the harness budget", () => {
  assert.deepEqual(
    inspectOllamaRuntime(
      { models: [{ model: "qwen3:4b", context_length: 8192, size_vram: 3_777_935_441 }] },
      "qwen3:4b",
      8192,
    ),
    { contextLength: 8192, sizeVramBytes: 3_777_935_441, issues: [] },
  );
});

test("rejects a live Ollama context smaller than the configured window", () => {
  const result = inspectOllamaRuntime(
    { models: [{ name: "qwen3:4b", context_length: 4096, size_vram: 3_169_761_361 }] },
    "qwen3:4b",
    8192,
  );
  assert.deepEqual(result.issues, ["Ollama serves context 4096, but the harness budgets for 8192"]);
});

test("rejects malformed or missing Ollama runner evidence", () => {
  assert.match(inspectOllamaRuntime({}, "qwen3:4b", 8192).issues[0] ?? "", /models array/);
  assert.match(
    inspectOllamaRuntime({ models: [] }, "qwen3:4b", 8192).issues[0] ?? "",
    /does not report/,
  );
});
