import { createHash } from "node:crypto";
import type {
  AssistantMessage,
  Context,
  Message,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";
import { buildStableCachePrompt, cacheConformanceTools } from "./cache-conformance.ts";
import { collectAssistantMessageIssues } from "./conformance.ts";
import {
  ContextCompiler,
  type CompiledProviderContext,
} from "./context/context-compiler.ts";
import {
  createPrefixPreservingCompactionStrategy,
  isPrefixCompactionMarker,
  readPrefixCompactionManifest,
} from "./context/prefix-preserving-compaction.ts";
import {
  dropOldestStrategy,
  estimateContextTokens,
  estimateTokens,
  type TruncationStrategy,
} from "./truncation.ts";

export const TRUNCATION_CONFORMANCE_SCHEMA_VERSION = 1 as const;
export const TRUNCATION_EVALUATION_CONTEXT_WINDOW = 3_500;
export const TRUNCATION_EVALUATION_OUTPUT_RESERVE = 128;
export const TRUNCATION_EVALUATION_FACT_IDS = [0, 1, 16, 17, 33, 34] as const;

export type EvaluatedTruncationStrategy =
  | "drop-oldest"
  | "prefix-preserving-compaction-v1";
export type TruncationProbePhase = "cold" | "warm-appended-history";

export interface TruncationProbeTiming {
  promptLatencyMs: number;
  generationLatencyMs: number;
  totalLatencyMs: number;
  retryCount: number;
  measurement: "request-to-first-output-and-first-output-to-terminal";
}

export interface TruncationCallObservation {
  message: AssistantMessage;
  timing: TruncationProbeTiming;
}

export type TruncationProbeExecutor = (
  context: Context,
  probe: {
    label: string;
    strategy: EvaluatedTruncationStrategy;
    phase: TruncationProbePhase;
  },
) => Promise<TruncationCallObservation>;

export interface TruncationProbeEvidence {
  label: string;
  phase: TruncationProbePhase;
  promptFingerprint: string;
  retainedSourceMessages: number;
  derivedMessages: number;
  droppedSourceMessages: number;
  estimatedInputTokens: number;
  providerPromptTokens: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
  };
  costUsd: Usage["cost"];
  timing: TruncationProbeTiming;
  responseConformance: {
    verdict: "pass" | "fail";
    issues: string[];
    stopReason: AssistantMessage["stopReason"];
  };
}

export interface TruncationStrategyEvidence {
  strategy: EvaluatedTruncationStrategy;
  safety: {
    contextWithinBudget: boolean;
    toolCallResultIntegrity: boolean;
    completeHistoryImmutable: boolean;
    omissionManifest: "not-applicable" | "versioned-rebuildable-no-summary" | "invalid";
  };
  factualRetention: {
    evaluationFactIds: number[];
    retainedFactIds: number[];
    retainedFacts: number;
    totalFacts: number;
    score: number;
  };
  cacheExtent: {
    estimatedStablePrefixTokensAcrossAppend: number;
    coldCacheReadTokens: number;
    warmCacheReadTokens: number;
    providerMetrics: "reported-nonzero" | "unreported-or-not-observed";
  };
  aggregate: {
    costUsd: number;
    promptLatencyMs: number;
    generationLatencyMs: number;
    totalLatencyMs: number;
  };
  probes: TruncationProbeEvidence[];
}

export interface TruncationEvaluationTargetReport {
  schemaVersion: typeof TRUNCATION_CONFORMANCE_SCHEMA_VERSION;
  recordedAt: string;
  configKey: string;
  provider: string;
  modelId: string;
  servedContextWindow: number;
  evaluationContextWindow: typeof TRUNCATION_EVALUATION_CONTEXT_WINDOW;
  strategies: TruncationStrategyEvidence[];
  comparison: {
    factualRetentionDelta: number;
    estimatedStablePrefixTokenDelta: number;
    providerCacheExtent:
      | "candidate-improved"
      | "candidate-equal"
      | "candidate-regressed"
      | "unverified";
    costRatio: number;
    promptLatencyRatio: number;
  };
  verdict: "pass" | "fail";
}

export interface RunTruncationEvaluationOptions {
  recordedAt: string;
  configKey: string;
  provider: string;
  modelId: string;
  servedContextWindow: number;
  execute: TruncationProbeExecutor;
}

interface PlannedStrategy {
  strategy: EvaluatedTruncationStrategy;
  sourceColdHistory: Message[];
  sourceWarmHistory: Message[];
  coldHistorySnapshot: Message[];
  warmHistorySnapshot: Message[];
  cold: CompiledProviderContext;
  warm: CompiledProviderContext;
}

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function deterministicFiller(factId: number): string {
  let result = "";
  for (let line = 0; result.length < 420; line += 1) {
    result += createHash("sha256")
      .update(`truncation-eval-v1:${factId}:${line}`, "utf8")
      .digest("hex");
  }
  return result.slice(0, 420);
}

function factMessage(factId: number): Message {
  return {
    role: "user",
    content: `FACT_${factId.toString().padStart(2, "0")}=VALUE_${factId
      .toString()
      .padStart(2, "0")}\n${deterministicFiller(factId)}`,
    timestamp: factId * 10,
  };
}

function toolCall(id: string, factId: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "zeta_lookup", arguments: { value: `${factId}` } }],
    api: "faux",
    provider: "faux",
    model: "faux",
    usage: ZERO_USAGE,
    stopReason: "toolUse",
    timestamp: factId * 10 + 1,
  };
}

function toolResult(id: string, factId: number): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "zeta_lookup",
    content: [{ type: "text", text: `TOOL_FACT_${factId}=TOOL_VALUE_${factId}` }],
    isError: false,
    timestamp: factId * 10 + 2,
  };
}

export function buildTruncationEvaluationHistory(includeAppended = false): Message[] {
  const messages: Message[] = [];
  for (let factId = 0; factId <= (includeAppended ? 34 : 33); factId += 1) {
    messages.push(factMessage(factId));
    if (factId === 4 || factId === 29) {
      const id = `evaluation-call-${factId}`;
      messages.push(toolCall(id, factId), toolResult(id, factId));
    }
  }
  return messages;
}

function compile(
  strategyName: EvaluatedTruncationStrategy,
  strategy: TruncationStrategy,
  history: readonly Message[],
  namespace: string,
  phase: TruncationProbePhase,
): CompiledProviderContext {
  const tools = cacheConformanceTools();
  const systemPrompt = buildStableCachePrompt(
    TRUNCATION_EVALUATION_CONTEXT_WINDOW,
    tools,
    `${namespace}:${strategyName}`,
    600,
  );
  return new ContextCompiler({
    contextWindow: TRUNCATION_EVALUATION_CONTEXT_WINDOW,
    outputReserveTokens: TRUNCATION_EVALUATION_OUTPUT_RESERVE,
    systemPrompt,
    systemPromptVersion: "truncation-conformance.system.v1",
    tools,
    strategy,
  }).compile({
    completeHistory: history,
    currentInput: {
      role: "user",
      content: `Truncation evaluation ${phase}. Reply exactly TRUNCATION_OK. /no_think`,
      timestamp: 1_000,
    },
  });
}

export function planTruncationEvaluation(namespace = "deterministic-test"): PlannedStrategy[] {
  const coldHistory = buildTruncationEvaluationHistory(false);
  const warmHistory = buildTruncationEvaluationHistory(true);
  const strategies: Array<[EvaluatedTruncationStrategy, TruncationStrategy]> = [
    ["drop-oldest", dropOldestStrategy],
    ["prefix-preserving-compaction-v1", createPrefixPreservingCompactionStrategy()],
  ];
  return strategies.map(([strategyName, strategy]) => ({
    strategy: strategyName,
    sourceColdHistory: coldHistory,
    sourceWarmHistory: warmHistory,
    coldHistorySnapshot: structuredClone(coldHistory),
    warmHistorySnapshot: structuredClone(warmHistory),
    cold: compile(strategyName, strategy, coldHistory, namespace, "cold"),
    warm: compile(strategyName, strategy, warmHistory, namespace, "warm-appended-history"),
  }));
}

function toolIntegrity(messages: readonly Message[]): boolean {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content) if (block.type === "toolCall") calls.add(block.id);
    } else if (message.role === "toolResult") {
      if (!calls.has(message.toolCallId)) return false;
      results.add(message.toolCallId);
    }
  }
  return [...calls].every((id) => results.has(id));
}

function commonMessagePrefixTokens(left: readonly Message[], right: readonly Message[]): number {
  let tokens = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (JSON.stringify(left[index]) !== JSON.stringify(right[index])) break;
    tokens += estimateTokens(left[index]!);
  }
  return tokens;
}

function retainedFactIds(messages: readonly Message[]): number[] {
  const serialized = JSON.stringify(messages);
  return TRUNCATION_EVALUATION_FACT_IDS.filter((factId) =>
    serialized.includes(`FACT_${factId.toString().padStart(2, "0")}=VALUE_${factId
      .toString()
      .padStart(2, "0")}`),
  );
}

function responseIssues(message: AssistantMessage): string[] {
  return [
    ...new Set(
      collectAssistantMessageIssues(message, { requireSuccess: true }).map((issue) =>
        issue.startsWith("call did not succeed")
          ? "unsuccessful-stop-reason"
          : issue === "no non-empty text block was returned"
            ? "missing-text-output"
            : "invalid-assistant-message-shape",
      ),
    ),
  ];
}

function probeEvidence(
  phase: TruncationProbePhase,
  compiled: CompiledProviderContext,
  observation: TruncationCallObservation,
): TruncationProbeEvidence {
  const issues = responseIssues(observation.message);
  const usage = observation.message.usage;
  return {
    label: phase === "cold" ? "cold" : "warm-appended-history",
    phase,
    promptFingerprint: compiled.fingerprint.digest,
    retainedSourceMessages: compiled.projection.retainedHistoryMessages,
    derivedMessages: compiled.projection.derivedHistoryMessages,
    droppedSourceMessages: compiled.projection.droppedHistoryMessages,
    estimatedInputTokens: compiled.allocation.totalInputTokens,
    providerPromptTokens: usage.input + usage.cacheRead + usage.cacheWrite,
    usage: {
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
      totalTokens: usage.totalTokens,
    },
    costUsd: { ...usage.cost },
    timing: observation.timing,
    responseConformance: {
      verdict: issues.length === 0 ? "pass" : "fail",
      issues,
      stopReason: observation.message.stopReason,
    },
  };
}

function manifestVerdict(strategy: PlannedStrategy): TruncationStrategyEvidence["safety"]["omissionManifest"] {
  if (strategy.strategy === "drop-oldest") return "not-applicable";
  const markers = strategy.warm.context.messages.filter(isPrefixCompactionMarker);
  if (markers.length !== 1) return "invalid";
  const manifest = readPrefixCompactionManifest(markers[0]!);
  return manifest?.summaryGenerated === false && manifest.rebuildable === true
    ? "versioned-rebuildable-no-summary"
    : "invalid";
}

function finiteRatio(numerator: number, denominator: number): number {
  if (denominator === 0) return numerator === 0 ? 1 : Number.MAX_SAFE_INTEGER;
  return Number((numerator / denominator).toFixed(4));
}

export async function runTruncationEvaluationTarget(
  options: RunTruncationEvaluationOptions,
): Promise<TruncationEvaluationTargetReport> {
  if (options.servedContextWindow < TRUNCATION_EVALUATION_CONTEXT_WINDOW) {
    throw new Error(
      `served context ${options.servedContextWindow} is smaller than evaluation context ${TRUNCATION_EVALUATION_CONTEXT_WINDOW}`,
    );
  }
  const plan = planTruncationEvaluation(`${options.recordedAt}:${options.configKey}`);
  const strategies: TruncationStrategyEvidence[] = [];

  for (const planned of plan) {
    const coldObservation = await options.execute(planned.cold.context, {
      label: `${planned.strategy}:cold`,
      strategy: planned.strategy,
      phase: "cold",
    });
    const warmObservation = await options.execute(planned.warm.context, {
      label: `${planned.strategy}:warm-appended-history`,
      strategy: planned.strategy,
      phase: "warm-appended-history",
    });
    const probes = [
      probeEvidence("cold", planned.cold, coldObservation),
      probeEvidence("warm-appended-history", planned.warm, warmObservation),
    ];
    const retained = retainedFactIds(planned.warm.context.messages);
    const warmWithinBudget =
      planned.warm.allocation.totalInputTokens + planned.warm.allocation.outputReserveTokens <=
      planned.warm.allocation.contextWindow;
    const coldWithinBudget =
      planned.cold.allocation.totalInputTokens + planned.cold.allocation.outputReserveTokens <=
      planned.cold.allocation.contextWindow;
    const aggregate = {
      costUsd: probes.reduce((sum, probe) => sum + probe.costUsd.total, 0),
      promptLatencyMs: probes.reduce((sum, probe) => sum + probe.timing.promptLatencyMs, 0),
      generationLatencyMs: probes.reduce(
        (sum, probe) => sum + probe.timing.generationLatencyMs,
        0,
      ),
      totalLatencyMs: probes.reduce((sum, probe) => sum + probe.timing.totalLatencyMs, 0),
    };
    strategies.push({
      strategy: planned.strategy,
      safety: {
        contextWithinBudget: warmWithinBudget && coldWithinBudget,
        toolCallResultIntegrity:
          toolIntegrity(planned.cold.context.messages) &&
          toolIntegrity(planned.warm.context.messages),
        completeHistoryImmutable:
          JSON.stringify(planned.sourceColdHistory) ===
            JSON.stringify(planned.coldHistorySnapshot) &&
          JSON.stringify(planned.sourceWarmHistory) ===
            JSON.stringify(planned.warmHistorySnapshot),
        omissionManifest: manifestVerdict(planned),
      },
      factualRetention: {
        evaluationFactIds: [...TRUNCATION_EVALUATION_FACT_IDS],
        retainedFactIds: retained,
        retainedFacts: retained.length,
        totalFacts: TRUNCATION_EVALUATION_FACT_IDS.length,
        score: Number((retained.length / TRUNCATION_EVALUATION_FACT_IDS.length).toFixed(4)),
      },
      cacheExtent: {
        estimatedStablePrefixTokensAcrossAppend:
          planned.cold.allocation.fixedOverheadTokens +
          commonMessagePrefixTokens(
            planned.cold.context.messages,
            planned.warm.context.messages,
          ),
        coldCacheReadTokens: probes[0]!.usage.cacheReadTokens,
        warmCacheReadTokens: probes[1]!.usage.cacheReadTokens,
        providerMetrics: probes.some(
          (probe) => probe.usage.cacheReadTokens > 0 || probe.usage.cacheWriteTokens > 0,
        )
          ? "reported-nonzero"
          : "unreported-or-not-observed",
      },
      aggregate,
      probes,
    });
  }

  const baseline = strategies.find((strategy) => strategy.strategy === "drop-oldest")!;
  const candidate = strategies.find(
    (strategy) => strategy.strategy === "prefix-preserving-compaction-v1",
  )!;
  const providerCacheExtent =
    baseline.cacheExtent.providerMetrics !== "reported-nonzero" ||
    candidate.cacheExtent.providerMetrics !== "reported-nonzero"
      ? "unverified"
      : candidate.cacheExtent.warmCacheReadTokens > baseline.cacheExtent.warmCacheReadTokens
        ? "candidate-improved"
        : candidate.cacheExtent.warmCacheReadTokens < baseline.cacheExtent.warmCacheReadTokens
          ? "candidate-regressed"
          : "candidate-equal";
  const responsesPass = strategies.every((strategy) =>
    strategy.probes.every((probe) => probe.responseConformance.verdict === "pass"),
  );
  const safetyPass = strategies.every(
    (strategy) =>
      strategy.safety.contextWithinBudget &&
      strategy.safety.toolCallResultIntegrity &&
      strategy.safety.completeHistoryImmutable &&
      strategy.safety.omissionManifest !== "invalid",
  );

  return {
    schemaVersion: TRUNCATION_CONFORMANCE_SCHEMA_VERSION,
    recordedAt: options.recordedAt,
    configKey: options.configKey,
    provider: options.provider,
    modelId: options.modelId,
    servedContextWindow: options.servedContextWindow,
    evaluationContextWindow: TRUNCATION_EVALUATION_CONTEXT_WINDOW,
    strategies,
    comparison: {
      factualRetentionDelta:
        candidate.factualRetention.retainedFacts - baseline.factualRetention.retainedFacts,
      estimatedStablePrefixTokenDelta:
        candidate.cacheExtent.estimatedStablePrefixTokensAcrossAppend -
        baseline.cacheExtent.estimatedStablePrefixTokensAcrossAppend,
      providerCacheExtent,
      costRatio: finiteRatio(candidate.aggregate.costUsd, baseline.aggregate.costUsd),
      promptLatencyRatio: finiteRatio(
        candidate.aggregate.promptLatencyMs,
        baseline.aggregate.promptLatencyMs,
      ),
    },
    verdict: safetyPass && responsesPass ? "pass" : "fail",
  };
}
