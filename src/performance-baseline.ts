/** A0-M.3 — deterministic aggregation for live performance samples. */

export const PERFORMANCE_BASELINE_SCHEMA_VERSION = 1 as const;
export const PERFORMANCE_BASELINE_MINIMUM_SAMPLES = 30;

export interface PerformanceSample {
  index: number;
  queueTimeMs: number;
  timeToFirstEventMs: number;
  promptPhaseMs: number;
  generationPhaseMs: number;
  providerTimeMs: number;
  toolDispatchMs: number;
  fullToolRoundTripMs: number;
  promptTokens: number;
  outputTokens: number;
  promptTokensPerSecond: number;
  generationTokensPerSecond: number;
  retryCount: number;
  conformance: "pass" | "fail";
  issues: readonly string[];
}

export interface DistributionSummary {
  min: number;
  p50: number;
  p95: number;
  max: number;
}

export interface PerformanceBaselineSummary {
  sampleCount: number;
  successfulSamples: number;
  failedSamples: number;
  conformanceRate: number;
  metricPopulation: "conformant-samples-only";
  metricSampleCount: number;
  metrics: {
    queueTimeMs: DistributionSummary;
    timeToFirstEventMs: DistributionSummary;
    promptPhaseMs: DistributionSummary;
    generationPhaseMs: DistributionSummary;
    providerTimeMs: DistributionSummary;
    toolDispatchMs: DistributionSummary;
    fullToolRoundTripMs: DistributionSummary;
    promptTokensPerSecond: DistributionSummary;
    generationTokensPerSecond: DistributionSummary;
  } | null;
  totalRetries: number;
  verdict: "pass" | "fail";
}

export interface DurationSample {
  index: number;
  durationMs: number;
  conformance: "pass" | "fail";
  issues: readonly string[];
}

export interface DurationBaselineSummary {
  sampleCount: number;
  successfulSamples: number;
  failedSamples: number;
  conformanceRate: number;
  metricPopulation: "conformant-samples-only";
  metricSampleCount: number;
  durationMs: DistributionSummary | null;
  verdict: "pass" | "fail";
}

function finiteNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`);
}

/** Nearest-rank percentile: p95 of 30 samples is the 29th ordered value. */
export function percentile(values: readonly number[], probability: number): number {
  if (values.length === 0) throw new Error("percentile requires at least one value");
  if (!Number.isFinite(probability) || probability <= 0 || probability > 1) {
    throw new Error("percentile probability must be in (0, 1]");
  }
  values.forEach((value) => finiteNonNegative("percentile value", value));
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(probability * ordered.length) - 1] as number;
}

export function distribution(values: readonly number[]): DistributionSummary {
  return {
    min: Math.min(...values),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
  };
}

export function summarizePerformanceSamples(
  samples: readonly PerformanceSample[],
  minimumSamples = PERFORMANCE_BASELINE_MINIMUM_SAMPLES,
): PerformanceBaselineSummary {
  if (!Number.isFinite(minimumSamples) || !Number.isInteger(minimumSamples) || minimumSamples <= 0) {
    throw new Error("minimumSamples must be a finite positive whole number");
  }
  if (samples.length === 0) throw new Error("performance baseline requires samples");
  for (const [index, sample] of samples.entries()) {
    if (sample.index !== index + 1) throw new Error("performance sample indexes must be contiguous from 1");
    for (const field of [
      "queueTimeMs", "timeToFirstEventMs", "promptPhaseMs", "generationPhaseMs",
      "providerTimeMs", "toolDispatchMs", "fullToolRoundTripMs", "promptTokens",
      "outputTokens", "promptTokensPerSecond", "generationTokensPerSecond", "retryCount",
    ] as const) finiteNonNegative(`sample[${index}].${field}`, sample[field]);
    if (!Number.isInteger(sample.retryCount)) throw new Error("retryCount must be a whole number");
    if (sample.conformance === "pass" && sample.issues.length > 0) {
      throw new Error("a passing performance sample cannot contain issues");
    }
  }
  const conformantSamples = samples.filter((sample) => sample.conformance === "pass");
  const values = (field: keyof PerformanceSample): number[] =>
    conformantSamples.map((sample) => sample[field]).filter((value): value is number => typeof value === "number");
  const successfulSamples = conformantSamples.length;
  const metrics = successfulSamples === 0 ? null : {
    queueTimeMs: distribution(values("queueTimeMs")),
    timeToFirstEventMs: distribution(values("timeToFirstEventMs")),
    promptPhaseMs: distribution(values("promptPhaseMs")),
    generationPhaseMs: distribution(values("generationPhaseMs")),
    providerTimeMs: distribution(values("providerTimeMs")),
    toolDispatchMs: distribution(values("toolDispatchMs")),
    fullToolRoundTripMs: distribution(values("fullToolRoundTripMs")),
    promptTokensPerSecond: distribution(values("promptTokensPerSecond")),
    generationTokensPerSecond: distribution(values("generationTokensPerSecond")),
  };
  return {
    sampleCount: samples.length,
    successfulSamples,
    failedSamples: samples.length - successfulSamples,
    conformanceRate: successfulSamples / samples.length,
    metricPopulation: "conformant-samples-only",
    metricSampleCount: successfulSamples,
    metrics,
    totalRetries: samples.reduce((total, sample) => total + sample.retryCount, 0),
    verdict: samples.length >= minimumSamples && successfulSamples === samples.length ? "pass" : "fail",
  };
}

export function summarizeDurationSamples(
  samples: readonly DurationSample[],
  minimumSamples = PERFORMANCE_BASELINE_MINIMUM_SAMPLES,
): DurationBaselineSummary {
  if (!Number.isFinite(minimumSamples) || !Number.isInteger(minimumSamples) || minimumSamples <= 0) {
    throw new Error("minimumSamples must be a finite positive whole number");
  }
  if (samples.length === 0) throw new Error("duration baseline requires samples");
  for (const [index, sample] of samples.entries()) {
    if (sample.index !== index + 1) throw new Error("duration sample indexes must be contiguous from 1");
    finiteNonNegative(`sample[${index}].durationMs`, sample.durationMs);
    if (sample.conformance === "pass" && sample.issues.length > 0) {
      throw new Error("a passing duration sample cannot contain issues");
    }
  }
  const conformantSamples = samples.filter((sample) => sample.conformance === "pass");
  const successfulSamples = conformantSamples.length;
  return {
    sampleCount: samples.length,
    successfulSamples,
    failedSamples: samples.length - successfulSamples,
    conformanceRate: successfulSamples / samples.length,
    metricPopulation: "conformant-samples-only",
    metricSampleCount: successfulSamples,
    durationMs: successfulSamples === 0
      ? null
      : distribution(conformantSamples.map((sample) => sample.durationMs)),
    verdict: samples.length >= minimumSamples && successfulSamples === samples.length ? "pass" : "fail",
  };
}
