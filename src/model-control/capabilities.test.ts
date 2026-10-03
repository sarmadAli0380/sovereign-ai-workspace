import assert from "node:assert/strict";
import test from "node:test";
import {
  assessModelRoute,
  MODEL_CAPABILITY_SCHEMA_VERSION,
  ModelCapabilityRecordError,
  parseModelCapabilityRecord,
  type ModelCapabilityRecord,
} from "./capabilities.ts";

const NOW = new Date("2026-08-11T12:00:00.000Z");

function record(): ModelCapabilityRecord {
  return {
    schemaVersion: MODEL_CAPABILITY_SCHEMA_VERSION,
    recordId: "local-qwen@sha256:abc",
    configKey: "local-qwen",
    declared: {
      identity: {
        provider: "ollama",
        model: "qwen3:4b",
        digest: "sha256:abc",
        quantization: "Q4_K_M",
      },
      api: "openai-completions",
      transport: "http",
      contextWindow: 8_192,
      outputLimit: { tokens: 2_048, honored: "supported" },
      features: {
        tools: "supported",
        images: "unsupported",
        thinking: "supported",
        structuredOutput: "unknown",
        streaming: "supported",
      },
      reporting: { usage: "supported", cache: "unknown" },
      provenance: {
        kind: "configuration",
        source: "model.config.json#local-qwen",
        recordedAt: "2026-08-11T10:00:00.000Z",
      },
    },
    observed: {
      identity: {
        provider: "ollama",
        model: "qwen3:4b",
        digest: "sha256:abc",
        quantization: "Q4_K_M",
      },
      api: "openai-completions",
      transport: "http",
      servedContextWindow: 8_192,
      outputLimitHonored: "supported",
      features: {
        tools: "supported",
        images: "unsupported",
        thinking: "supported",
        structuredOutput: "unknown",
        streaming: "supported",
      },
      reporting: { usage: "supported", cache: "unknown" },
      health: "healthy",
      readiness: "ready",
      provenance: {
        kind: "live-probe",
        source: "conformance/2026-08-10-local-qwen.json",
        verifiedAt: "2026-08-11T11:30:00.000Z",
      },
    },
  };
}

test("configured claims and observed evidence remain separate and are cloned", () => {
  const source = record();
  const parsed = parseModelCapabilityRecord(source);
  assert.notEqual(parsed, source);
  assert.equal(parsed.declared.contextWindow, 8_192);
  assert.equal(parsed.observed?.servedContextWindow, 8_192);
  assert.equal(parsed.declared.reporting.cache, "unknown");
  assert.equal(parsed.observed?.reporting.cache, "unknown");
});

test("a fresh healthy observation satisfying requirements is routable", () => {
  const assessment = assessModelRoute(record(), {
    now: NOW,
    maxObservationAgeMs: 60 * 60 * 1_000,
    requirements: {
      features: ["tools", "streaming"],
      reporting: ["usage"],
      minimumServedContext: 8_000,
      outputLimitHonored: true,
    },
  });
  assert.deepEqual(assessment, {
    observation: "fresh",
    routable: true,
    reasons: [],
    verifiedAt: "2026-08-11T11:30:00.000Z",
    ageMs: 30 * 60 * 1_000,
  });
});

test("missing and stale observations are visible and fail closed", () => {
  const missing = record();
  delete missing.observed;
  assert.deepEqual(assessModelRoute(missing, { now: NOW, maxObservationAgeMs: 1 }), {
    observation: "missing",
    routable: false,
    reasons: ["live observation is missing"],
  });

  const stale = record();
  stale.observed!.provenance.verifiedAt = "2026-08-10T11:59:59.999Z";
  const assessment = assessModelRoute(stale, {
    now: NOW,
    maxObservationAgeMs: 24 * 60 * 60 * 1_000,
  });
  assert.equal(assessment.observation, "stale");
  assert.equal(assessment.routable, false);
  assert.deepEqual(assessment.reasons, ["live observation is stale"]);
});

test("unknown support, unhealthy state, and inadequate served context are not routable", () => {
  const source = record();
  source.observed!.features.structuredOutput = "unknown";
  source.observed!.reporting.cache = "unknown";
  source.observed!.health = "degraded";
  const assessment = assessModelRoute(source, {
    now: NOW,
    maxObservationAgeMs: 60 * 60 * 1_000,
    requirements: {
      features: ["structuredOutput"],
      reporting: ["cache"],
      minimumServedContext: 16_384,
    },
  });
  assert.equal(assessment.routable, false);
  assert.deepEqual(assessment.reasons, [
    "health is degraded",
    "required feature structuredOutput is unknown",
    "required reporting cache is unknown",
    "served context 8192 is below required 16384",
  ]);
});

test("validation rejects provenance confusion, identity drift, unknown fields, and NaN", () => {
  const bad = record() as unknown as Record<string, unknown>;
  const declared = bad["declared"] as Record<string, unknown>;
  const observed = bad["observed"] as Record<string, unknown>;
  (declared["provenance"] as Record<string, unknown>)["kind"] = "live-probe";
  (observed["provenance"] as Record<string, unknown>)["kind"] = "configuration";
  (observed["identity"] as Record<string, unknown>)["model"] = "different-model";
  observed["servedContextWindow"] = Number.NaN;
  observed["extra"] = true;

  assert.throws(
    () => parseModelCapabilityRecord(bad),
    (error: unknown) => {
      assert.ok(error instanceof ModelCapabilityRecordError);
      assert.match(error.message, /declared\.provenance\.kind/);
      assert.match(error.message, /observed\.provenance\.kind/);
      assert.match(error.message, /does not match the declared identity/);
      assert.match(error.message, /finite positive whole number/);
      assert.match(error.message, /unknown field/);
      return true;
    },
  );
});

test("validation rejects a loose date and an output limit larger than context", () => {
  const bad = record();
  bad.declared.provenance.recordedAt = "2026-08-11";
  bad.declared.outputLimit.tokens = 9_000;
  assert.throws(() => parseModelCapabilityRecord(bad), (error: unknown) => {
    assert.ok(error instanceof ModelCapabilityRecordError);
    assert.match(error.message, /absolute ISO-8601 UTC timestamp/);
    assert.match(error.message, /cannot exceed the declared context window/);
    return true;
  });
});

test("validation rejects non-JSON prototypes and quantization identity drift", () => {
  const inherited = Object.create(record()) as ModelCapabilityRecord;
  assert.throws(() => parseModelCapabilityRecord(inherited), /plain JSON object/);

  const drifted = record();
  drifted.observed!.identity.quantization = "Q8_0";
  assert.throws(() => parseModelCapabilityRecord(drifted), /does not match the declared quantization/);
});

test("route assessment revalidates a typed-but-mutated record", () => {
  const mutated = record();
  mutated.observed!.provenance.kind = "configuration" as "live-probe";
  assert.throws(
    () => assessModelRoute(mutated, { now: NOW, maxObservationAgeMs: 1_000 }),
    /observed\.provenance\.kind/,
  );
});

test("the freshness gate proves its negative control", () => {
  const future = record();
  future.observed!.provenance.verifiedAt = "2026-08-12T00:00:00.000Z";
  const assessment = assessModelRoute(future, {
    now: NOW,
    maxObservationAgeMs: 60 * 60 * 1_000,
  });
  assert.equal(assessment.observation, "stale");
  assert.equal(assessment.routable, false);
  assert.deepEqual(assessment.reasons, ["verification time is in the future"]);
});
