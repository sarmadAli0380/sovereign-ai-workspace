import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  CACHE_CONFORMANCE_MINIMUM_PREFIX_TOKENS,
  CACHE_CONFORMANCE_WARM_REPEATS,
  buildStableCachePrompt,
  mutateOneSystemPromptByte,
  planCacheConformanceProbes,
  runCacheConformanceTarget,
  type CacheProbeExecutor,
} from "./cache-conformance.ts";

function response(
  cacheRead: number,
  cacheWrite: number,
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "CACHE_OK" }],
    api: "faux",
    provider: "faux",
    model: "faux",
    usage: {
      input: 1_200 - cacheRead - cacheWrite,
      output: 2,
      cacheRead,
      cacheWrite,
      totalTokens: 1_202,
      cost: {
        input: 0.001,
        output: 0.0001,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.0011,
      },
    },
    stopReason,
    timestamp: 1,
  };
}

function executeWith(
  usage: (label: string) => { cacheRead: number; cacheWrite: number },
): CacheProbeExecutor {
  return async (_context, probe) => {
    const observed = usage(probe.label);
    return {
      message: response(observed.cacheRead, observed.cacheWrite),
      timing: {
        promptLatencyMs: 10,
        generationLatencyMs: 5,
        totalLatencyMs: 15,
        retryCount: 0,
        measurement: "request-to-first-output-and-first-output-to-terminal",
      },
    };
  };
}

test("builds a deterministic stable prefix above the 1024-token cache floor", () => {
  const first = buildStableCachePrompt(8_192);
  const second = buildStableCachePrompt(8_192);
  const plan = planCacheConformanceProbes(8_192);

  assert.equal(first, second);
  assert.ok(
    plan.probes[0]!.compiled.allocation.fixedOverheadTokens >
      CACHE_CONFORMANCE_MINIMUM_PREFIX_TOKENS,
  );
  assert.equal(plan.probes.filter((probe) => probe.kind === "warm").length, 5);
  assert.equal(plan.probes.length, 1 + CACHE_CONFORMANCE_WARM_REPEATS + 3);
  assert.ok(
    plan.probes.find((probe) => probe.kind === "drop-oldest-truncation")!
      .compiled.projection.droppedHistoryMessages > 0,
  );
  assert.ok(
    planCacheConformanceProbes(272_000).probes.find(
      (probe) => probe.kind === "drop-oldest-truncation",
    )!.compiled.projection.droppedHistoryMessages > 0,
  );
});

test("one system byte invalidates while source tool reordering is normalized", () => {
  const plan = planCacheConformanceProbes(8_192);
  const base = plan.probes[0]!.compiled;
  const invalidated = plan.probes.find(
    (probe) => probe.kind === "system-byte-invalidation",
  )!.compiled;
  const reordered = plan.probes.find((probe) => probe.kind === "tool-reorder")!.compiled;

  const mutated = mutateOneSystemPromptByte(plan.stablePrompt);
  assert.equal(Buffer.byteLength(mutated), Buffer.byteLength(plan.stablePrompt));
  assert.equal(
    Buffer.from(mutated).reduce(
      (count, byte, index) => count + (byte === Buffer.from(plan.stablePrompt)[index] ? 0 : 1),
      0,
    ),
    1,
  );
  assert.notEqual(invalidated.fingerprint.hashes.system, base.fingerprint.hashes.system);
  assert.equal(reordered.fingerprint.digest, plan.toolOrderReference.fingerprint.digest);
  assert.deepEqual(reordered.context, plan.toolOrderReference.context);
});

test("reports zero cache fields as unverified and never infers support from latency", async () => {
  const report = await runCacheConformanceTarget({
    recordedAt: "2026-08-10T00:00:00.000Z",
    configKey: "fake",
    provider: "fake",
    modelId: "fake-model",
    contextWindow: 8_192,
    execute: executeWith(() => ({ cacheRead: 0, cacheWrite: 0 })),
  });

  assert.equal(report.verdict, "pass");
  assert.equal(report.cacheEvidence.metrics, "unreported-or-not-observed");
  assert.equal(report.cacheEvidence.systemByteInvalidation, "unverified");
  assert.equal(report.cacheEvidence.toolReorderRetention, "unverified");
  assert.equal(report.cacheEvidence.truncationRetention, "unverified");
  assert.match(report.cacheEvidence.note, /Latency is not used as proof/);
  assert.equal(report.invariants.truncationExercised, true);
});

test("classifies reported cache retention and invalidation from token evidence", async () => {
  const report = await runCacheConformanceTarget({
    recordedAt: "2026-08-10T00:00:00.000Z",
    configKey: "fake",
    provider: "fake",
    modelId: "fake-model",
    contextWindow: 8_192,
    execute: executeWith((label) => {
      if (label === "cold") return { cacheRead: 0, cacheWrite: 1_100 };
      if (label === "system-byte-invalidation") return { cacheRead: 0, cacheWrite: 1_100 };
      return { cacheRead: 1_100, cacheWrite: 0 };
    }),
  });

  assert.equal(report.cacheEvidence.metrics, "reported-nonzero");
  assert.equal(report.cacheEvidence.cacheReadObserved, true);
  assert.equal(report.cacheEvidence.cacheWriteObserved, true);
  assert.equal(report.cacheEvidence.systemByteInvalidation, "observed");
  assert.equal(report.cacheEvidence.toolReorderRetention, "observed");
  assert.equal(report.cacheEvidence.truncationRetention, "observed");
});

test("a malformed provider response fails the target without storing response content", async () => {
  const report = await runCacheConformanceTarget({
    recordedAt: "2026-08-10T00:00:00.000Z",
    configKey: "fake",
    provider: "fake",
    modelId: "fake-model",
    contextWindow: 8_192,
    execute: async (_context, probe) => ({
      message:
        probe.label === "warm-3"
          ? { ...response(0, 0, "error"), content: [], errorMessage: "provider failed" }
          : response(0, 0),
      timing: {
        promptLatencyMs: 10,
        generationLatencyMs: 5,
        totalLatencyMs: 15,
        retryCount: 0,
        measurement: "request-to-first-output-and-first-output-to-terminal",
      },
    }),
  });

  assert.equal(report.verdict, "fail");
  assert.equal(
    report.probes.find((probe) => probe.label === "warm-3")!.responseConformance.verdict,
    "fail",
  );
  assert.doesNotMatch(JSON.stringify(report), /CACHE_OK|provider failed/);
});
