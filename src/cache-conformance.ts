import { createHash } from "node:crypto";
import { Type, type AssistantMessage, type Context, type Tool } from "@earendil-works/pi-ai";
import { collectAssistantMessageIssues } from "./conformance.ts";
import {
  ContextCompiler,
  type CompiledProviderContext,
} from "./context/context-compiler.ts";

export const CACHE_CONFORMANCE_SCHEMA_VERSION = 1 as const;
export const CACHE_CONFORMANCE_MINIMUM_PREFIX_TOKENS = 1_024;
export const CACHE_CONFORMANCE_WARM_REPEATS = 5;
const CACHE_CONFORMANCE_ESTIMATED_PREFIX_TARGET = 3_000;

export type CacheProbeKind =
  | "cold"
  | "warm"
  | "system-byte-invalidation"
  | "tool-reorder"
  | "drop-oldest-truncation";

export interface CacheProbeTiming {
  /** Request start through the first text/thinking/tool-call stream event. */
  promptLatencyMs: number;
  /** First output event through the terminal stream event. */
  generationLatencyMs: number;
  /** Whole operation, including retry delay and failed attempts. */
  totalLatencyMs: number;
  retryCount: number;
  measurement: "request-to-first-output-and-first-output-to-terminal";
}

export interface CacheCallObservation {
  message: AssistantMessage;
  timing: CacheProbeTiming;
}

export type CacheProbeExecutor = (
  context: Context,
  probe: { label: string; kind: CacheProbeKind },
) => Promise<CacheCallObservation>;

export interface CacheProbeEvidence {
  label: string;
  kind: CacheProbeKind;
  promptFingerprint: string;
  systemHash: string;
  toolsHash: string;
  fixedOverheadTokens: number;
  projectedHistoryMessages: number;
  droppedHistoryMessages: number;
  retainedStablePrefixTokens: number;
  /** input + cacheRead + cacheWrite reconstructs the provider-observed prompt. */
  providerPromptTokens: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
  };
  costUsd: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  timing: CacheProbeTiming;
  responseConformance: {
    verdict: "pass" | "fail";
    issues: string[];
    stopReason: AssistantMessage["stopReason"];
  };
}

export interface CacheConformanceTargetReport {
  schemaVersion: typeof CACHE_CONFORMANCE_SCHEMA_VERSION;
  recordedAt: string;
  configKey: string;
  provider: string;
  modelId: string;
  contextWindow: number;
  stablePrefix: {
    minimumRequiredTokens: typeof CACHE_CONFORMANCE_MINIMUM_PREFIX_TOKENS;
    fixedOverheadTokens: number;
    systemTemplateVersion: string;
    systemHash: string;
    toolsHash: string;
  };
  probes: CacheProbeEvidence[];
  invariants: {
    warmRepeats: typeof CACHE_CONFORMANCE_WARM_REPEATS;
    stablePrefixAboveMinimum: boolean;
    providerPromptAboveMinimum: boolean;
    warmSystemAndToolsStable: boolean;
    oneByteSystemChangeInvalidatedCompilerFingerprint: boolean;
    toolReorderingPreservedProviderContext: boolean;
    truncationExercised: boolean;
  };
  cacheEvidence: {
    metrics: "reported-nonzero" | "unreported-or-not-observed";
    cacheReadObserved: boolean;
    cacheWriteObserved: boolean;
    systemByteInvalidation: "observed" | "contradicted" | "unverified";
    toolReorderRetention: "observed" | "contradicted" | "unverified";
    truncationRetention: "observed" | "unverified";
    note: string;
  };
  verdict: "pass" | "fail";
}

export interface RunCacheConformanceOptions {
  recordedAt: string;
  configKey: string;
  provider: string;
  modelId: string;
  contextWindow: number;
  execute: CacheProbeExecutor;
}

interface PlannedProbe {
  label: string;
  kind: CacheProbeKind;
  compiled: CompiledProviderContext;
}

function outputReserve(contextWindow: number): number {
  return Math.max(1, Math.min(256, Math.floor(contextWindow / 4)));
}

export function cacheConformanceTools(): Tool[] {
  return [
    {
      name: "zeta_lookup",
      description: "Return a deterministic value for cache conformance.",
      parameters: Type.Object({ value: Type.String() }),
    },
    {
      name: "alpha_lookup",
      description: "Return a second deterministic value for cache conformance.",
      parameters: Type.Object({ key: Type.String() }),
    },
  ];
}

/** Build a deterministic fixed prefix whose estimated wire cost clears the cache floor. */
export function buildStableCachePrompt(
  contextWindow: number,
  tools: readonly Tool[] = cacheConformanceTools(),
  namespace = "deterministic-test",
  estimatedPrefixTarget = CACHE_CONFORMANCE_ESTIMATED_PREFIX_TARGET,
): string {
  if (!Number.isFinite(estimatedPrefixTarget) || estimatedPrefixTarget <= 0) {
    throw new TypeError("estimatedPrefixTarget must be a finite positive number");
  }
  const namespaceHash = createHash("sha256").update(namespace, "utf8").digest("hex");
  let prompt =
    "SOVEREIGN CACHE CONFORMANCE TEMPLATE v1\n" +
    `RUN NAMESPACE ${namespaceHash}\n` +
    "Reply with exactly CACHE_OK. Do not call tools and do not add explanation. /no_think\n";
  for (let line = 0; line < 10_000; line += 1) {
    // Unique deterministic bytes resist the extreme tokenizer compression of
    // a repeated English sentence. Provider usage is still the live gate.
    const digest = createHash("sha256")
      .update(`sovereign-cache-conformance-v1:${line}`, "utf8")
      .digest("hex");
    const candidate = `${prompt}${line.toString().padStart(4, "0")}:${digest}\n`;
    const compiled = new ContextCompiler({
      contextWindow,
      outputReserveTokens: outputReserve(contextWindow),
      systemPrompt: candidate,
      systemPromptVersion: "cache-conformance.system.v1",
      tools,
    }).compile({
      completeHistory: [],
      currentInput: { role: "user", content: "cache-prefix-sizing", timestamp: 0 },
    });
    prompt = candidate;
    if (compiled.allocation.fixedOverheadTokens > estimatedPrefixTarget) {
      return prompt;
    }
  }
  throw new Error("could not build a stable cache prefix above the required token floor");
}

/** Same UTF-8 length, exactly one changed ASCII byte. */
export function mutateOneSystemPromptByte(prompt: string): string {
  if (!prompt.startsWith("S")) throw new TypeError("stable prompt must start with ASCII S");
  return `T${prompt.slice(1)}`;
}

function compileProbe(
  contextWindow: number,
  systemPrompt: string,
  tools: readonly Tool[],
  suffix: string,
  completeHistory: Context["messages"] = [],
): CompiledProviderContext {
  return new ContextCompiler({
    contextWindow,
    outputReserveTokens: outputReserve(contextWindow),
    systemPrompt,
    systemPromptVersion: "cache-conformance.system.v1",
    tools,
  }).compile({
    completeHistory,
    currentInput: {
      role: "user",
      content: `Cache conformance suffix ${suffix}. Reply exactly CACHE_OK. /no_think`,
      timestamp: 0,
    },
  });
}

function longHistory(contextWindow: number): Context["messages"] {
  // Scale with the resolved provider window. A fixed corpus that truncates
  // at 8K can fit untouched in a 272K context and would falsely claim this
  // probe exercised the same transition on both providers.
  const messageCount = Math.max(2, Math.ceil(contextWindow / 800));
  return Array.from({ length: messageCount }, (_, index) => ({
    role: "user" as const,
    content: `historical-${index.toString().padStart(4, "0")}-${"x".repeat(3_000)}`,
    timestamp: index,
  }));
}

export function planCacheConformanceProbes(
  contextWindow: number,
  namespace = "deterministic-test",
): {
  stablePrompt: string;
  tools: Tool[];
  probes: PlannedProbe[];
  toolOrderReference: CompiledProviderContext;
} {
  const tools = cacheConformanceTools();
  const stablePrompt = buildStableCachePrompt(contextWindow, tools, namespace);
  const probes: PlannedProbe[] = [
    {
      label: "cold",
      kind: "cold",
      compiled: compileProbe(contextWindow, stablePrompt, tools, "cold-0"),
    },
    ...Array.from({ length: CACHE_CONFORMANCE_WARM_REPEATS }, (_, index) => ({
      label: `warm-${index + 1}`,
      kind: "warm" as const,
      compiled: compileProbe(contextWindow, stablePrompt, tools, `warm-${index + 1}`),
    })),
    {
      label: "system-byte-invalidation",
      kind: "system-byte-invalidation",
      compiled: compileProbe(
        contextWindow,
        mutateOneSystemPromptByte(stablePrompt),
        tools,
        "system-byte-invalidation",
      ),
    },
    {
      label: "tool-reorder",
      kind: "tool-reorder",
      compiled: compileProbe(
        contextWindow,
        stablePrompt,
        [...tools].reverse(),
        "tool-order-probe",
      ),
    },
    {
      label: "drop-oldest-truncation",
      kind: "drop-oldest-truncation",
      compiled: compileProbe(
        contextWindow,
        stablePrompt,
        tools,
        "truncation-probe",
        longHistory(contextWindow),
      ),
    },
  ];
  return {
    stablePrompt,
    tools,
    probes,
    toolOrderReference: compileProbe(
      contextWindow,
      stablePrompt,
      tools,
      "tool-order-probe",
    ),
  };
}

function evidenceFor(
  probe: PlannedProbe,
  observation: CacheCallObservation,
): CacheProbeEvidence {
  const rawIssues = collectAssistantMessageIssues(observation.message, {
    requireSuccess: true,
  });
  // Evidence is safe to persist. Provider errors can echo request content,
  // so retain only structural classifications rather than error strings.
  const issues = [
    ...new Set(
      rawIssues.map((issue) =>
        issue.startsWith("call did not succeed")
          ? "unsuccessful-stop-reason"
          : issue === "no non-empty text block was returned"
            ? "missing-text-output"
            : "invalid-assistant-message-shape",
      ),
    ),
  ];
  const usage = observation.message.usage;
  return {
    label: probe.label,
    kind: probe.kind,
    promptFingerprint: probe.compiled.fingerprint.digest,
    systemHash: probe.compiled.fingerprint.hashes.system,
    toolsHash: probe.compiled.fingerprint.hashes.tools,
    fixedOverheadTokens: probe.compiled.allocation.fixedOverheadTokens,
    projectedHistoryMessages: probe.compiled.projection.projectedHistoryMessages,
    droppedHistoryMessages: probe.compiled.projection.droppedHistoryMessages,
    retainedStablePrefixTokens: probe.compiled.allocation.fixedOverheadTokens,
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

function greatestCacheRead(probes: readonly CacheProbeEvidence[]): number {
  return Math.max(0, ...probes.map((probe) => probe.usage.cacheReadTokens));
}

export async function runCacheConformanceTarget(
  options: RunCacheConformanceOptions,
): Promise<CacheConformanceTargetReport> {
  const plan = planCacheConformanceProbes(
    options.contextWindow,
    `${options.recordedAt}:${options.configKey}`,
  );
  const evidence: CacheProbeEvidence[] = [];
  for (const probe of plan.probes) {
    evidence.push(
      evidenceFor(
        probe,
        await options.execute(probe.compiled.context, {
          label: probe.label,
          kind: probe.kind,
        }),
      ),
    );
  }

  const coldAndWarm = evidence.filter(
    (probe) => probe.kind === "cold" || probe.kind === "warm",
  );
  const invalidation = evidence.find((probe) => probe.kind === "system-byte-invalidation")!;
  const reordered = evidence.find((probe) => probe.kind === "tool-reorder")!;
  const truncated = evidence.find((probe) => probe.kind === "drop-oldest-truncation")!;
  const baselineCacheRead = greatestCacheRead(coldAndWarm);
  const cacheReadObserved = greatestCacheRead(evidence) > 0;
  const cacheWriteObserved = evidence.some((probe) => probe.usage.cacheWriteTokens > 0);
  const toolContextStable =
    JSON.stringify(reordered.promptFingerprint) ===
    JSON.stringify(plan.toolOrderReference.fingerprint.digest);

  const invariants = {
    warmRepeats: CACHE_CONFORMANCE_WARM_REPEATS,
    stablePrefixAboveMinimum:
      coldAndWarm[0]!.fixedOverheadTokens > CACHE_CONFORMANCE_MINIMUM_PREFIX_TOKENS,
    providerPromptAboveMinimum: coldAndWarm.every(
      (probe) => probe.providerPromptTokens > CACHE_CONFORMANCE_MINIMUM_PREFIX_TOKENS,
    ),
    warmSystemAndToolsStable: coldAndWarm.every(
      (probe) =>
        probe.systemHash === coldAndWarm[0]!.systemHash &&
        probe.toolsHash === coldAndWarm[0]!.toolsHash,
    ),
    oneByteSystemChangeInvalidatedCompilerFingerprint:
      invalidation.systemHash !== coldAndWarm[0]!.systemHash,
    toolReorderingPreservedProviderContext: toolContextStable,
    truncationExercised: truncated.droppedHistoryMessages > 0,
  } satisfies CacheConformanceTargetReport["invariants"];

  const systemByteInvalidation =
    baselineCacheRead === 0
      ? "unverified"
      : invalidation.usage.cacheReadTokens < baselineCacheRead
        ? "observed"
        : "contradicted";
  const toolReorderRetention =
    baselineCacheRead === 0
      ? "unverified"
      : reordered.usage.cacheReadTokens > 0
        ? "observed"
        : "contradicted";
  const truncationRetention =
    baselineCacheRead > 0 && truncated.usage.cacheReadTokens > 0 ? "observed" : "unverified";
  const invariantPass = Object.entries(invariants)
    .filter(([key]) => key !== "warmRepeats")
    .every(([, value]) => value === true);
  const responsesPass = evidence.every(
    (probe) => probe.responseConformance.verdict === "pass",
  );

  return {
    schemaVersion: CACHE_CONFORMANCE_SCHEMA_VERSION,
    recordedAt: options.recordedAt,
    configKey: options.configKey,
    provider: options.provider,
    modelId: options.modelId,
    contextWindow: options.contextWindow,
    stablePrefix: {
      minimumRequiredTokens: CACHE_CONFORMANCE_MINIMUM_PREFIX_TOKENS,
      fixedOverheadTokens: coldAndWarm[0]!.fixedOverheadTokens,
      systemTemplateVersion: "cache-conformance.system.v1",
      systemHash: coldAndWarm[0]!.systemHash,
      toolsHash: coldAndWarm[0]!.toolsHash,
    },
    probes: evidence,
    invariants,
    cacheEvidence: {
      metrics: cacheReadObserved || cacheWriteObserved ? "reported-nonzero" : "unreported-or-not-observed",
      cacheReadObserved,
      cacheWriteObserved,
      systemByteInvalidation,
      toolReorderRetention,
      truncationRetention,
      note:
        cacheReadObserved || cacheWriteObserved
          ? "Cache conclusions use provider-reported token fields only; latency is observational."
          : "The runtime normalizes absent cache metrics to zero, so zero cannot distinguish unsupported, unreported, disabled, or a genuine miss. Latency is not used as proof.",
    },
    verdict: invariantPass && responsesPass ? "pass" : "fail",
  };
}
