import assert from "node:assert/strict";
import test from "node:test";
import {
  LocalModelController,
  type LocalAdmissionPolicy,
  type LocalRuntimeAdapter,
  type LocalRuntimeSnapshot,
} from "./admission.ts";
import { MODEL_CAPABILITY_SCHEMA_VERSION, type ModelCapabilityRecord } from "./capabilities.ts";

const NOW = new Date("2026-08-11T12:00:00.000Z");
const geometry = { paramCount: 4_022_468_096, layers: 36, kvHeads: 8, keyDim: 128, valueDim: 128 };

function capabilities(overrides: { verifiedAt?: string; context?: number } = {}): ModelCapabilityRecord {
  const context = overrides.context ?? 8_192;
  const identity = { provider: "ollama", model: "qwen3:4b", digest: "sha256:abc", quantization: "Q4_K_M" };
  const features = { tools: "supported", images: "unsupported", thinking: "supported", structuredOutput: "unknown", streaming: "supported" } as const;
  return {
    schemaVersion: MODEL_CAPABILITY_SCHEMA_VERSION,
    recordId: "local-qwen@sha256:abc",
    configKey: "local-qwen",
    declared: {
      identity, api: "openai-completions", transport: "http", contextWindow: context,
      outputLimit: { tokens: 2_048, honored: "supported" },
      features, reporting: { usage: "supported", cache: "unknown" },
      provenance: { kind: "configuration", source: "model.config.json#local-qwen", recordedAt: "2026-08-11T10:00:00.000Z" },
    },
    observed: {
      identity, api: "openai-completions", transport: "http", servedContextWindow: context,
      outputLimitHonored: "supported", features, reporting: { usage: "supported", cache: "unknown" },
      health: "healthy", readiness: "ready",
      provenance: { kind: "live-probe", source: "conformance/local-qwen.json", verifiedAt: overrides.verifiedAt ?? "2026-08-11T11:30:00.000Z" },
    },
  };
}

function snapshot(models: LocalRuntimeSnapshot["models"] = [], freeMemoryBytes = 8_000_000_000): LocalRuntimeSnapshot {
  return { runtimeId: "ollama", observedAt: NOW.toISOString(), freeMemoryBytes, memorySource: "test fixture", models, issues: [] };
}

class FakeRuntime implements LocalRuntimeAdapter {
  readonly runtimeId = "ollama";
  current = snapshot();
  loads = 0;
  failLoad = false;

  async inspect(): Promise<LocalRuntimeSnapshot> { return structuredClone(this.current); }
  async load(request: { modelId: string; contextWindow: number }): Promise<void> {
    this.loads += 1;
    if (this.failLoad) throw new Error("simulated loader failure");
    this.current = snapshot([{
      modelId: request.modelId,
      digest: "sha256:abc",
      quantization: "Q4_K_M",
      servedContextWindow: request.contextWindow,
      residentBytes: 3_777_935_441,
      acceleratorBytes: 3_777_935_441,
    }], 4_000_000_000);
  }
}

const policy: LocalAdmissionPolicy = {
  maxResidentModels: 1,
  maxConcurrentSequences: 1,
  deploymentHeadroomBytes: 500_000_000,
  maxCapabilityObservationAgeMs: 60 * 60 * 1_000,
  loadTimeoutMs: 5_000,
  capacityAction: "reject",
};

function request(record = capabilities()) {
  return { capabilityRecord: record, geometry, weightsBytes: 2_497_293_931 };
}

test("cold model is sized, loaded once, re-inspected, and admitted", async () => {
  const runtime = new FakeRuntime();
  const controller = new LocalModelController(runtime, policy, () => NOW);
  const result = await controller.admit(request());
  assert.equal(result.outcome, "admitted");
  assert.equal(result.state, "busy");
  assert.equal(runtime.loads, 1);
  assert.ok(result.estimate && result.estimate.totalBytes > 3_000_000_000);
  assert.ok(result.admissionId);
  assert.equal(controller.activeSequences("qwen3:4b"), 1);
  assert.equal(controller.release(result.admissionId!), true);
  assert.equal(controller.activeSequences("qwen3:4b"), 0);
  assert.equal(controller.release(result.admissionId!), false);
});

test("a matching resident model admits without a duplicate load", async () => {
  const runtime = new FakeRuntime();
  await runtime.load({ modelId: "qwen3:4b", contextWindow: 8_192 });
  runtime.loads = 0;
  const result = await new LocalModelController(runtime, policy, () => NOW).admit(request());
  assert.equal(result.outcome, "admitted");
  assert.equal(runtime.loads, 0);
});

test("concurrent admissions serialize and never duplicate a cold load", async () => {
  const runtime = new FakeRuntime();
  const controller = new LocalModelController(runtime, { ...policy, capacityAction: "queue" }, () => NOW);
  const [first, second] = await Promise.all([controller.admit(request()), controller.admit(request())]);
  assert.equal(runtime.loads, 1);
  assert.equal(first.outcome, "admitted");
  assert.equal(second.outcome, "queued");
  assert.deepEqual(second.reasons, ["concurrent sequence limit reached"]);
});

test("stale capability evidence fails before a load", async () => {
  const runtime = new FakeRuntime();
  const result = await new LocalModelController(runtime, policy, () => NOW).admit(
    request(capabilities({ verifiedAt: "2026-08-10T00:00:00.000Z" })),
  );
  assert.equal(result.outcome, "rejected");
  assert.equal(result.state, "degraded");
  assert.match(result.reasons.join("\n"), /stale/);
  assert.equal(runtime.loads, 0);
});

test("insufficient memory rejects or queues according to explicit policy", async () => {
  for (const capacityAction of ["reject", "queue"] as const) {
    const runtime = new FakeRuntime();
    runtime.current = snapshot([], 3_000_000_000);
    const result = await new LocalModelController(runtime, { ...policy, capacityAction }, () => NOW).admit(request());
    assert.equal(result.outcome, capacityAction === "queue" ? "queued" : "rejected");
    assert.equal(result.state, "busy");
    assert.match(result.reasons[0] ?? "", /exceeds memory budget/);
    assert.equal(runtime.loads, 0);
  }
});

test("resident limit, served-context drift, and accelerator spill fail closed", async () => {
  const other = { modelId: "other", servedContextWindow: 4_096, residentBytes: 1_000, acceleratorBytes: 1_000 };
  const runtime = new FakeRuntime();
  runtime.current = snapshot([other]);
  let result = await new LocalModelController(runtime, policy, () => NOW).admit(request());
  assert.deepEqual(result.reasons, ["resident model limit reached"]);

  runtime.current = snapshot([{ modelId: "qwen3:4b", digest: "sha256:abc", servedContextWindow: 4_096, residentBytes: 3_000, acceleratorBytes: 3_000 }]);
  result = await new LocalModelController(runtime, policy, () => NOW).admit(request());
  assert.match(result.reasons[0] ?? "", /serves context 4096/);

  runtime.current = snapshot([{ modelId: "qwen3:4b", digest: "sha256:abc", servedContextWindow: 8_192, residentBytes: 3_000, acceleratorBytes: 2_000 }]);
  result = await new LocalModelController(runtime, policy, () => NOW).admit(request());
  assert.deepEqual(result.reasons, ["running model is not fully accelerator-resident"]);
});

test("load failures and missing post-load evidence are degraded, never admitted", async () => {
  const failing = new FakeRuntime();
  failing.failLoad = true;
  let result = await new LocalModelController(failing, policy, () => NOW).admit(request());
  assert.equal(result.state, "degraded");
  assert.match(result.reasons[0] ?? "", /simulated loader failure/);

  const invisible = new FakeRuntime();
  invisible.load = async () => { invisible.loads += 1; };
  result = await new LocalModelController(invisible, policy, () => NOW).admit(request());
  assert.equal(result.outcome, "rejected");
  assert.deepEqual(result.reasons, ["runtime did not report the requested model after loading"]);
});

test("invalid policy numbers fail closed instead of disabling limits", () => {
  const runtime = new FakeRuntime();
  for (const maxConcurrentSequences of [0, Number.NaN, 1.5]) {
    assert.throws(
      () => new LocalModelController(runtime, { ...policy, maxConcurrentSequences }),
      /finite positive whole number/,
    );
  }
});

test("status exposes cold, loading, ready, busy, and degraded states", async () => {
  const runtime = new FakeRuntime();
  const controller = new LocalModelController(runtime, policy, () => NOW);
  assert.equal((await controller.status("qwen3:4b", 8_192)).state, "cold");

  let finishLoad!: () => void;
  const waiting = new Promise<void>((resolve) => { finishLoad = resolve; });
  runtime.load = async (loadRequest) => {
    runtime.loads += 1;
    await waiting;
    runtime.current = snapshot([{
      modelId: loadRequest.modelId, digest: "sha256:abc", servedContextWindow: loadRequest.contextWindow,
      residentBytes: 3_000, acceleratorBytes: 3_000,
    }], 4_000_000_000);
  };
  const admissionPromise = controller.admit(request());
  while (runtime.loads === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((await controller.status("qwen3:4b", 8_192)).state, "loading");
  finishLoad();
  const admitted = await admissionPromise;
  assert.equal((await controller.status("qwen3:4b", 8_192)).state, "busy");
  controller.release(admitted.admissionId!);
  assert.equal((await controller.status("qwen3:4b", 8_192)).state, "ready");

  runtime.current = snapshot([{ modelId: "qwen3:4b", servedContextWindow: 4_096, residentBytes: 3_000, acceleratorBytes: 3_000 }]);
  assert.equal((await controller.status("qwen3:4b", 8_192)).state, "degraded");
});
