/** Live A0-M.2 admission proof. Loads only the explicitly named local model. */

import { BITS_PER_WEIGHT } from "../src/sizing.ts";
import { LocalModelController, type LocalAdmissionPolicy } from "../src/model-control/admission.ts";
import { MODEL_CAPABILITY_SCHEMA_VERSION, type ModelCapabilityRecord } from "../src/model-control/capabilities.ts";
import { OllamaRuntimeAdapter } from "../src/model-control/ollama.ts";

const modelId = process.argv[2] ?? "qwen3:4b";
const contextWindow = Number(process.argv[3] ?? "8192");
if (!Number.isFinite(contextWindow) || !Number.isInteger(contextWindow) || contextWindow <= 0) {
  throw new Error("context window must be a finite positive whole number");
}

const measuredFreeRaw = process.env["OLLAMA_ADMISSION_FREE_BYTES"];
const measuredFreeBytes = Number(measuredFreeRaw);
if (
  measuredFreeRaw === undefined ||
  !Number.isFinite(measuredFreeBytes) ||
  !Number.isInteger(measuredFreeBytes) ||
  measuredFreeBytes <= 0
) {
  throw new Error(
    "OLLAMA_ADMISSION_FREE_BYTES must contain a current positive whole-byte memory measurement. " +
      "Do not substitute node:os.freemem on macOS: it excludes reclaimable unified memory.",
  );
}
const adapter = new OllamaRuntimeAdapter({
  freeMemory: () => measuredFreeBytes,
  memorySource: "OLLAMA_ADMISSION_FREE_BYTES (deployment/runtime measurement)",
});
const before = await adapter.inspect(AbortSignal.timeout(5_000));
const description = await adapter.describe(modelId, AbortSignal.timeout(10_000));
const now = new Date();
const support = {
  tools: "supported",
  images: "unknown",
  thinking: "supported",
  structuredOutput: "unknown",
  streaming: "supported",
} as const;
const identity = {
  provider: "ollama",
  model: modelId,
  ...(description.digest ? { digest: description.digest } : {}),
  ...(description.quantization ? { quantization: description.quantization } : {}),
};
const capabilityRecord: ModelCapabilityRecord = {
  schemaVersion: MODEL_CAPABILITY_SCHEMA_VERSION,
  recordId: `${modelId}@${description.digest ?? "digest-unreported"}`,
  configKey: "local-qwen",
  declared: {
    identity,
    api: "openai-completions",
    transport: "http",
    contextWindow,
    outputLimit: { tokens: 2_048, honored: "supported" },
    features: support,
    reporting: { usage: "supported", cache: "unknown" },
    provenance: {
      kind: "configuration",
      source: "model.config.json#local-qwen + local-providers.json#ollama",
      recordedAt: now.toISOString(),
    },
  },
  observed: {
    identity,
    api: "openai-completions",
    transport: "http",
    servedContextWindow: contextWindow,
    outputLimitHonored: "supported",
    features: support,
    reporting: { usage: "supported", cache: "unknown" },
    health: "healthy",
    readiness: "ready",
    provenance: {
      kind: "live-probe",
      source: "live Ollama /api/ps + conformance/2026-08-06-local-qwen.json + conformance/2026-08-10-cache-qwen.json",
      // Oldest evidence in the combined observation. Current /api/ps health
      // must not make the older functional/tool evidence look freshly run.
      verifiedAt: "2026-08-10T12:53:58.296Z",
    },
  },
};
const policy: LocalAdmissionPolicy = {
  maxResidentModels: 1,
  maxConcurrentSequences: 1,
  deploymentHeadroomBytes: 512 * 1024 * 1024,
  maxCapabilityObservationAgeMs: 7 * 24 * 60 * 60 * 1_000,
  loadTimeoutMs: 120_000,
  capacityAction: "reject",
};
const bitsPerWeight = description.quantization
  ? BITS_PER_WEIGHT[description.quantization]
  : undefined;
if (description.weightsBytes === undefined && bitsPerWeight === undefined) {
  throw new Error("Ollama reported neither a measured weight size nor a known quantization");
}
const controller = new LocalModelController(adapter, policy);
const admission = await controller.admit({
  capabilityRecord,
  geometry: description.geometry,
  ...(description.weightsBytes !== undefined ? { weightsBytes: description.weightsBytes } : {}),
  ...(bitsPerWeight !== undefined ? { bitsPerWeight } : {}),
});
if (admission.admissionId) controller.release(admission.admissionId);

const report = {
  schemaVersion: 1,
  kind: "local-inference-admission",
  generatedAt: new Date().toISOString(),
  target: { runtime: adapter.runtimeId, modelId, contextWindow },
  policy,
  before,
  description,
  result: {
    outcome: admission.outcome,
    state: admission.state,
    reasons: admission.reasons,
    ...(admission.estimate ? { estimate: admission.estimate } : {}),
    after: admission.snapshot,
  },
  verdict: admission.outcome === "admitted" ? "pass" : "fail",
};
console.log(JSON.stringify(report, null, 2));
if (admission.outcome !== "admitted") process.exitCode = 1;
