import assert from "node:assert/strict";
import test from "node:test";
import {
  distribution,
  percentile,
  summarizeDurationSamples,
  summarizePerformanceSamples,
  type DurationSample,
  type PerformanceSample,
} from "./performance-baseline.ts";

function sample(index: number, overrides: Partial<PerformanceSample> = {}): PerformanceSample {
  return {
    index,
    queueTimeMs: index,
    timeToFirstEventMs: index * 2,
    promptPhaseMs: index * 2,
    generationPhaseMs: index * 3,
    providerTimeMs: index * 5,
    toolDispatchMs: 1,
    fullToolRoundTripMs: index * 5 + 1,
    promptTokens: 100,
    outputTokens: 10,
    promptTokensPerSecond: 50,
    generationTokensPerSecond: 5,
    retryCount: 0,
    conformance: "pass",
    issues: [],
    ...overrides,
  };
}

test("nearest-rank p50 and p95 are deterministic for 30 samples", () => {
  const values = Array.from({ length: 30 }, (_, index) => index + 1);
  assert.equal(percentile(values, 0.5), 15);
  assert.equal(percentile(values, 0.95), 29);
  assert.deepEqual(distribution(values), { min: 1, p50: 15, p95: 29, max: 30 });
});

test("30 successful samples produce a baseline pass without inventing an SLO", () => {
  const result = summarizePerformanceSamples(Array.from({ length: 30 }, (_, index) => sample(index + 1)));
  assert.equal(result.verdict, "pass");
  assert.equal(result.sampleCount, 30);
  assert.equal(result.metricPopulation, "conformant-samples-only");
  assert.equal(result.metricSampleCount, 30);
  assert.equal(result.conformanceRate, 1);
  assert.equal(result.metrics?.fullToolRoundTripMs.p95, 146);
  assert.equal("slo" in result, false);
});

test("fewer than 30 samples or one failed conformance sample fails closed", () => {
  assert.equal(summarizePerformanceSamples([sample(1)]).verdict, "fail");
  const samples = Array.from({ length: 30 }, (_, index) => sample(index + 1));
  samples[29] = sample(30, { conformance: "fail", issues: ["missing-tool-call"] });
  const result = summarizePerformanceSamples(samples);
  assert.equal(result.verdict, "fail");
  assert.equal(result.failedSamples, 1);
  assert.equal(result.metricSampleCount, 29);
  assert.equal(result.conformanceRate, 29 / 30);
});

test("failed samples do not contaminate conformant performance distributions", () => {
  const samples = Array.from({ length: 30 }, (_, index) => sample(index + 1));
  samples[0] = sample(1, {
    queueTimeMs: 0,
    timeToFirstEventMs: 0,
    promptPhaseMs: 0,
    generationPhaseMs: 0,
    providerTimeMs: 0,
    toolDispatchMs: 0,
    fullToolRoundTripMs: 0,
    promptTokensPerSecond: 0,
    generationTokensPerSecond: 0,
    conformance: "fail",
    issues: ["provider-call-error"],
  });
  const result = summarizePerformanceSamples(samples);
  assert.equal(result.metrics?.queueTimeMs.min, 2);
  assert.equal(result.metrics?.fullToolRoundTripMs.min, 11);
  assert.equal(result.metrics?.promptTokensPerSecond.min, 50);
});

test("an all-failed run preserves its verdict without inventing metric values", () => {
  const result = summarizePerformanceSamples([
    sample(1, { conformance: "fail", issues: ["provider-call-error"] }),
  ], 1);
  assert.equal(result.verdict, "fail");
  assert.equal(result.metricSampleCount, 0);
  assert.equal(result.metrics, null);
});

test("bad indexes, NaN, negative timing, and vacuous pass issues are rejected", () => {
  assert.throws(() => summarizePerformanceSamples([sample(2)], 1), /indexes/);
  assert.throws(() => summarizePerformanceSamples([sample(1, { queueTimeMs: Number.NaN })], 1), /finite/);
  assert.throws(() => summarizePerformanceSamples([sample(1, { providerTimeMs: -1 })], 1), /non-negative/);
  assert.throws(
    () => summarizePerformanceSamples([sample(1, { issues: ["should-fail"] })], 1),
    /passing performance sample cannot contain issues/,
  );
});

test("percentile validates its own negative control", () => {
  assert.throws(() => percentile([], 0.95), /at least one/);
  assert.throws(() => percentile([1], 0), /probability/);
});

test("duration baselines report p50/p95 over conformant samples only", () => {
  const samples: DurationSample[] = Array.from({ length: 30 }, (_, index) => ({
    index: index + 1,
    durationMs: index + 1,
    conformance: "pass",
    issues: [],
  }));
  samples[0] = { index: 1, durationMs: 0, conformance: "fail", issues: ["load-failed"] };
  const result = summarizeDurationSamples(samples);
  assert.equal(result.verdict, "fail");
  assert.equal(result.metricSampleCount, 29);
  assert.deepEqual(result.durationMs, { min: 2, p50: 16, p95: 29, max: 30 });
});

test("all-failed duration samples do not invent a model-load distribution", () => {
  const result = summarizeDurationSamples([
    { index: 1, durationMs: 0, conformance: "fail", issues: ["load-failed"] },
  ], 1);
  assert.equal(result.verdict, "fail");
  assert.equal(result.durationMs, null);
});
