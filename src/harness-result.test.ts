import assert from "node:assert/strict";
import { test } from "node:test";
import { errorMessage, errorResult } from "./harness-result.ts";
import { HarnessError } from "./types.ts";

test("a pre-flight failure surfaces as an AssistantMessage with stopReason error", () => {
  const message = errorMessage({
    error: new HarnessError("unknownConfigKey", 'Unknown configKey "nope".'),
  });

  assert.equal(message.role, "assistant");
  assert.equal(message.stopReason, "error");
  assert.equal(message.errorMessage, 'Unknown configKey "nope".');
  assert.equal(message.usage.totalTokens, 0, "no call was made, so no tokens were spent");
});

test("errorResult has the same shape a successful call returns", () => {
  const result = errorResult({
    error: new HarnessError("modelNotFound", "no such model"),
    configKey: "claude-default",
    provider: "anthropic",
    modelId: "claude-sonnet-5",
  });

  // The whole point: one place to check for failure.
  assert.equal(result.message.stopReason, "error");
  assert.equal(result.configKey, "claude-default");
  assert.equal(result.routedVia, "native");
  assert.equal(typeof result.latencyMs, "number");
  assert.equal(result.message.provider, "anthropic");
  assert.equal(result.message.model, "claude-sonnet-5");
});

test("falls back to harness markers when the provider never resolved", () => {
  const message = errorMessage({ error: new HarnessError("invalidContext", "bad context") });
  assert.equal(message.provider, "harness");
  assert.equal(message.model, "unknown");
});
