import assert from "node:assert/strict";
import { test } from "node:test";
import { openAICompatibleProvider, parseLocalProviders } from "./openai-compatible.ts";

const valid = {
  ollama: {
    baseUrl: "http://localhost:11434/v1",
    models: [{ id: "qwen3:4b", contextWindow: 8192, maxTokens: 2048 }],
  },
};

test("a valid declaration parses", () => {
  const [spec] = parseLocalProviders(valid, "test.json");
  assert.equal(spec?.id, "ollama");
  assert.equal(spec?.models[0]?.contextWindow, 8192);
});

test("REGRESSION: a typo'd field is rejected, not silently dropped", () => {
  // The whole finding: `contextWindows` (extra s) reached ConversationManager
  // as `undefined`, produced a NaN budget, and disabled truncation entirely
  // against a server serving 4096.
  assert.throws(
    () =>
      parseLocalProviders(
        {
          ollama: {
            baseUrl: "http://localhost:11434/v1",
            models: [{ id: "qwen3:4b", contextWindows: 8192, maxTokens: 2048 }],
          },
        },
        "test.json",
      ),
    /contextWindow.*nothing \(typo\?\)|unknown field `contextWindows`/s,
  );
});

test("non-finite and non-positive numbers are rejected", () => {
  for (const bad of [0, -1, "8192", null]) {
    assert.throws(
      () =>
        parseLocalProviders(
          {
            ollama: {
              baseUrl: "http://localhost:11434/v1",
              models: [{ id: "m", contextWindow: bad, maxTokens: 2048 }],
            },
          },
          "test.json",
        ),
      /contextWindow/,
      `contextWindow ${JSON.stringify(bad)} must be rejected`,
    );
  }
});

test("malformed shapes report the problem instead of crashing downstream", () => {
  // Each of these previously produced a raw TypeError out of the provider
  // factory, or was silently accepted.
  assert.throws(() => parseLocalProviders({ ollama: { baseUrl: "x" } }, "t"), /`models` must be an array/);
  assert.throws(() => parseLocalProviders({ ollama: null }, "t"), /must be an object/);
  assert.throws(() => parseLocalProviders({ ollama: "http://x" }, "t"), /must be an object/);
  assert.throws(() => parseLocalProviders([{ baseUrl: "x" }], "t"), /keyed by provider id/);
  assert.throws(() => parseLocalProviders("nope", "t"), /keyed by provider id/);
  assert.throws(
    () => parseLocalProviders({ ollama: { baseUrl: "x", models: [] } }, "t"),
    /`models` is empty/,
  );
});

test("REGRESSION: a nested `id` cannot override the object key", () => {
  // `openAICompatibleProvider({ id, ...spec })` spread the entry AFTER the
  // key, so an `id` field inside the JSON silently won and the provider
  // registered under a name nothing referenced.
  assert.throws(
    () =>
      parseLocalProviders(
        {
          keyFromJson: {
            id: "SPOOFED",
            baseUrl: "http://localhost:11434/v1",
            models: [{ id: "m", contextWindow: 8192, maxTokens: 2048 }],
          },
        },
        "t",
      ),
    /`id` is taken from the object key/,
  );
});

test("the parsed spec registers under the object key", () => {
  const [spec] = parseLocalProviders(valid, "t");
  const provider = openAICompatibleProvider(spec!);
  assert.equal(provider.id, "ollama");
  assert.equal(provider.getModels()[0]?.provider, "ollama");
});

test("the shipped local-providers.json is valid", async () => {
  // Guards against the repo's own declaration drifting out of shape.
  const { readFileSync } = await import("node:fs");
  const { fromRepoRoot } = await import("./paths.ts");
  let raw: string;
  try {
    raw = readFileSync(fromRepoRoot("local-providers.json"), "utf8");
  } catch {
    return; // absent is a valid state
  }
  const specs = parseLocalProviders(JSON.parse(raw), "local-providers.json");
  assert.ok(specs.length > 0);
});
