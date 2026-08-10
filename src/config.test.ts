import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, parseConfig, DEFAULT_CONFIG_PATH } from "./config.ts";
import { HarnessError } from "./types.ts";

const valid = {
  "claude-default": {
    provider: "anthropic",
    modelId: "claude-sonnet-5",
    maxTokens: 4096,
    temperature: 0.7,
  },
};

test("parses a valid config", () => {
  const config = parseConfig(valid);
  assert.equal(config["claude-default"]?.provider, "anthropic");
  assert.equal(config["claude-default"]?.maxTokens, 4096);
});

test("the repo's own model.config.json is valid", () => {
  const config = loadConfig(DEFAULT_CONFIG_PATH);
  assert.ok(Object.keys(config).length > 0);
  // provider/modelId/maxTokens are required; temperature is optional
  // (openai-codex rejects the parameter entirely — see ConfigEntry).
  for (const entry of Object.values(config)) {
    const keys = Object.keys(entry).sort();
    assert.ok(keys.includes("provider") && keys.includes("modelId") && keys.includes("maxTokens"));
    for (const key of keys) {
      assert.ok(
        ["provider", "modelId", "maxTokens", "temperature", "contextWindow", "transport", "maxTokensHonored"].includes(key),
        `unexpected config field: ${key}`,
      );
    }
  }
});

test("rejects a missing provider", () => {
  assert.throws(
    () => parseConfig({ k: { modelId: "m", maxTokens: 1, temperature: 0 } }),
    (e: unknown) => e instanceof HarnessError && /provider/.test(e.message),
  );
});

test("accepts an entry with no temperature (openai-codex rejects the parameter)", () => {
  const config = parseConfig({ k: { provider: "openai-codex", modelId: "gpt-5.5", maxTokens: 4096 } });
  assert.equal(config["k"]?.temperature, undefined);
  assert.ok(!("temperature" in config["k"]!), "temperature must be absent, not undefined");
});

test("rejects a non-numeric temperature when present", () => {
  assert.throws(
    () => parseConfig({ k: { provider: "p", modelId: "m", maxTokens: 1, temperature: "hot" } }),
    (e: unknown) => e instanceof HarnessError && /temperature/.test(e.message),
  );
});

test("rejects a non-positive maxTokens", () => {
  assert.throws(
    () => parseConfig({ k: { provider: "p", modelId: "m", maxTokens: 0, temperature: 0 } }),
    (e: unknown) => e instanceof HarnessError && /maxTokens/.test(e.message),
  );
});

test("rejects fractional token limits and windows", () => {
  assert.throws(
    () => parseConfig({ bad: { provider: "p", modelId: "m", maxTokens: 1.5 } }),
    /maxTokens.*whole number/,
  );
  assert.throws(
    () =>
      parseConfig({
        bad: { provider: "p", modelId: "m", maxTokens: 1, contextWindow: 8.5 },
      }),
    /contextWindow.*whole number/,
  );
});

test("rejects maxTokens larger than the configured context window", () => {
  assert.throws(
    () =>
      parseConfig({
        bad: { provider: "p", modelId: "m", maxTokens: 9, contextWindow: 8 },
      }),
    /maxTokens.*cannot exceed.*contextWindow/,
  );
});

test("rejects an empty config", () => {
  assert.throws(() => parseConfig({}), HarnessError);
});

test("rejects a non-object config", () => {
  assert.throws(() => parseConfig([valid]), HarnessError);
});

// The three fields 1.4 deliberately left out. Accepting them silently would
// let a caller believe routing/fallback behaviour exists when nothing reads it.
for (const field of ["fallbackConfigKey", "routedVia", "apiKeyEnv", "api_key_env"]) {
  test(`rejects the deferred field \`${field}\``, () => {
    assert.throws(
      () =>
        parseConfig({
          k: { provider: "p", modelId: "m", maxTokens: 1, temperature: 0, [field]: "x" },
        }),
      (e: unknown) => e instanceof HarnessError && e.message.includes(field),
    );
  });
}

test("reports a readable error for a missing file", () => {
  assert.throws(
    () => loadConfig("does-not-exist.json"),
    (e: unknown) => e instanceof HarnessError && /Could not read config/.test(e.message),
  );
});

test("REGRESSION: a typo'd field is rejected, not silently ignored", () => {
  assert.throws(
    () =>
      parseConfig({
        k: { provider: "p", modelId: "m", maxTokens: 1, temperture: 0.9 },
      }),
    (e: unknown) => e instanceof HarnessError && /temperture/.test(e.message),
  );
});
