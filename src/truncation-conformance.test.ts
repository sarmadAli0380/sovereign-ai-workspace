import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  planTruncationEvaluation,
  runTruncationEvaluationTarget,
  type TruncationProbeExecutor,
} from "./truncation-conformance.ts";
import { isPrefixCompactionMarker } from "./context/prefix-preserving-compaction.ts";

function response(cacheRead: number, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "TRUNCATION_OK" }],
    api: "faux",
    provider: "faux",
    model: "faux",
    usage: {
      input: 2_400 - cacheRead,
      output: 4,
      cacheRead,
      cacheWrite: 0,
      totalTokens: 2_404,
      cost: {
        input: 0.01,
        output: 0.001,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.011,
      },
    },
    stopReason,
    timestamp: 1,
  };
}

function executor(cacheMetrics = true): TruncationProbeExecutor {
  return async (_context, probe) => {
    const cacheRead =
      cacheMetrics && probe.phase === "warm-appended-history"
        ? probe.strategy === "prefix-preserving-compaction-v1"
          ? 1_800
          : 640
        : 0;
    return {
      message: response(cacheRead),
      timing: {
        promptLatencyMs: probe.strategy === "prefix-preserving-compaction-v1" ? 9 : 10,
        generationLatencyMs: 2,
        totalLatencyMs: 12,
        retryCount: 0,
        measurement: "request-to-first-output-and-first-output-to-terminal",
      },
    };
  };
}

test("fixed corpus forces both strategies to truncate across an appended turn", () => {
  const plan = planTruncationEvaluation();
  const baseline = plan.find((item) => item.strategy === "drop-oldest")!;
  const candidate = plan.find(
    (item) => item.strategy === "prefix-preserving-compaction-v1",
  )!;

  assert.ok(baseline.cold.projection.droppedHistoryMessages > 0);
  assert.ok(baseline.warm.projection.droppedHistoryMessages > 0);
  assert.ok(candidate.cold.projection.droppedHistoryMessages > 0);
  assert.equal(candidate.warm.context.messages.filter(isPrefixCompactionMarker).length, 1);
  assert.notDeepEqual(baseline.cold.context.messages[0], baseline.warm.context.messages[0]);
  assert.deepEqual(candidate.cold.context.messages[0], candidate.warm.context.messages[0]);
});

test("reports candidate safety, factual retention, and observed cache-extent gain", async () => {
  const report = await runTruncationEvaluationTarget({
    recordedAt: "2026-08-10T00:00:00.000Z",
    configKey: "fake",
    provider: "fake",
    modelId: "fake-model",
    servedContextWindow: 8_192,
    execute: executor(),
  });
  const candidate = report.strategies.find(
    (strategy) => strategy.strategy === "prefix-preserving-compaction-v1",
  )!;

  assert.equal(report.verdict, "pass");
  assert.ok(report.comparison.factualRetentionDelta > 0);
  assert.ok(report.comparison.estimatedStablePrefixTokenDelta > 0);
  assert.equal(report.comparison.providerCacheExtent, "candidate-improved");
  assert.equal(candidate.safety.contextWithinBudget, true);
  assert.equal(candidate.safety.toolCallResultIntegrity, true);
  assert.equal(candidate.safety.completeHistoryImmutable, true);
  assert.equal(candidate.safety.omissionManifest, "versioned-rebuildable-no-summary");
  assert.ok(candidate.factualRetention.retainedFactIds.includes(0));
  assert.ok(candidate.factualRetention.retainedFactIds.includes(34));
});

test("zero provider cache fields remain unverified regardless of latency", async () => {
  const report = await runTruncationEvaluationTarget({
    recordedAt: "2026-08-10T00:00:00.000Z",
    configKey: "fake",
    provider: "fake",
    modelId: "fake-model",
    servedContextWindow: 8_192,
    execute: executor(false),
  });
  assert.equal(report.comparison.providerCacheExtent, "unverified");
});

test("malformed live responses fail without persisting provider text", async () => {
  const report = await runTruncationEvaluationTarget({
    recordedAt: "2026-08-10T00:00:00.000Z",
    configKey: "fake",
    provider: "fake",
    modelId: "fake-model",
    servedContextWindow: 8_192,
    execute: async (_context, probe) => ({
      message:
        probe.label === "drop-oldest:cold"
          ? { ...response(0, "error"), content: [], errorMessage: "secret provider echo" }
          : response(0),
      timing: {
        promptLatencyMs: 10,
        generationLatencyMs: 2,
        totalLatencyMs: 12,
        retryCount: 0,
        measurement: "request-to-first-output-and-first-output-to-terminal",
      },
    }),
  });

  assert.equal(report.verdict, "fail");
  assert.doesNotMatch(JSON.stringify(report), /TRUNCATION_OK|secret provider echo/);
});

test("fails closed when the served context is smaller than the evaluation window", async () => {
  await assert.rejects(
    runTruncationEvaluationTarget({
      recordedAt: "2026-08-10T00:00:00.000Z",
      configKey: "fake",
      provider: "fake",
      modelId: "fake-model",
      servedContextWindow: 3_499,
      execute: executor(),
    }),
    /smaller than evaluation context/,
  );
});
