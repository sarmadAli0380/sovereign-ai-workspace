import assert from "node:assert/strict";
import test from "node:test";
import type { Models } from "@earendil-works/pi-ai";
import { parseConfig } from "../config.ts";
import { parseSingleNodeDeploymentConfig } from "../deployment/config.ts";
import type { LocalRuntimeSnapshot } from "../model-control/admission.ts";
import { OllamaRuntimeAdapter, type OllamaModelDescription } from "../model-control/ollama.ts";
import { DeploymentOllamaRouteResolver } from "./deployment-route.ts";

const digest = "359d7dd4bcdab3d86b87d73ac27966f4dbb9f5efdfcc75d34a8764a09474fae7";
const now = new Date("2026-08-25T00:00:00.000Z");

class Adapter extends OllamaRuntimeAdapter {
  constructor() {
    super({ baseUrl: "http://inference:11434", freeMemory: () => 8_000_000_000 });
  }

  override async inspect(): Promise<LocalRuntimeSnapshot> {
    return {
      runtimeId: "ollama",
      observedAt: now.toISOString(),
      freeMemoryBytes: 8_000_000_000,
      memorySource: "fixture",
      issues: [],
      models: [{
        modelId: "qwen3:4b",
        digest,
        quantization: "Q4_K_M",
        servedContextWindow: 8192,
        residentBytes: 3_000_000_000,
        acceleratorBytes: 3_000_000_000,
      }],
    };
  }

  override async describe(): Promise<OllamaModelDescription> {
    return {
      modelId: "qwen3:4b",
      digest,
      quantization: "Q4_K_M",
      geometry: { paramCount: 4_022_468_096, layers: 36, kvHeads: 8, keyDim: 128, valueDim: 128 },
      weightsBytes: 2_500_000_000,
    };
  }

  override async load(): Promise<void> {
    throw new Error("resident fixture must not load twice");
  }
}

test("C2 deployment route normalizes the full deployment digest to Ollama's bare digest", async () => {
  const model = {
    provider: "ollama",
    id: "qwen3:4b",
    api: "openai-completions",
    contextWindow: 8192,
  };
  const models = { getModel() { return model; } } as unknown as Models;
  const resolver = new DeploymentOllamaRouteResolver({
    config: parseConfig({
      "local-qwen": {
        provider: "ollama", modelId: "qwen3:4b", maxTokens: 2048,
        contextWindow: 8192, maxTokensHonored: true,
      },
    }),
    models,
    deployment: parseSingleNodeDeploymentConfig(),
    freeMemoryBytes: 8_000_000_000,
    deploymentHeadroomBytes: 512 * 1024 * 1024,
    now: () => now,
    adapter: new Adapter(),
  });
  const route = await resolver.resolve("local-qwen");
  assert.equal(route.accounting?.outputTokenLimitEnforced, true);
  const lease = await route.admit();
  assert.equal(lease.admitted, true);
  assert.equal(await resolver.ready(), true);
  lease.release();
});
