import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { loadModel } from "./load-model.ts";
import { parseConfig } from "./config.ts";
import { HarnessError } from "./types.ts";

function testModels() {
  const faux = fauxProvider({
    provider: "faux",
    models: [
      { id: "small", contextWindow: 8_000, maxTokens: 1_000 },
      { id: "large", contextWindow: 200_000, maxTokens: 8_000 },
    ],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, faux };
}

const config = parseConfig({
  "small-default": { provider: "faux", modelId: "small", maxTokens: 512, temperature: 0.2 },
  "large-default": { provider: "faux", modelId: "large", maxTokens: 4096, temperature: 0.7 },
});

test("resolves a configKey to a model", () => {
  const { models } = testModels();
  const resolved = loadModel("small-default", config, models);
  assert.equal(resolved.model.id, "small");
  assert.equal(resolved.entry.temperature, 0.2);
  assert.equal(resolved.configKey, "small-default");
});

test("routing is a single lookup — swapping the key changes the model, with no caller branching", () => {
  const { models } = testModels();
  const small = loadModel("small-default", config, models);
  const large = loadModel("large-default", config, models);

  assert.equal(small.model.id, "small");
  assert.equal(large.model.id, "large");
  assert.equal(small.model.contextWindow, 8_000);
  assert.equal(large.model.contextWindow, 200_000);
});

test("throws unknownConfigKey for a key not in the config", () => {
  const { models } = testModels();
  assert.throws(
    () => loadModel("nope", config, models),
    (e: unknown) =>
      e instanceof HarnessError &&
      e.kind === "unknownConfigKey" &&
      /large-default, small-default/.test(e.message),
  );
});

test("throws modelNotFound when the provider has no such model", () => {
  const { models } = testModels();
  const bad = parseConfig({
    ghost: { provider: "faux", modelId: "missing", maxTokens: 1, temperature: 0 },
  });
  assert.throws(
    () => loadModel("ghost", bad, models),
    (e: unknown) => e instanceof HarnessError && e.kind === "modelNotFound",
  );
});
