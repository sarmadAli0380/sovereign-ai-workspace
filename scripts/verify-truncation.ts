/**
 * A0-P.3 live truncation-strategy comparison.
 *
 *   node scripts/verify-truncation.ts
 *   node scripts/verify-truncation.ts codex-default local-qwen --output conformance/truncation.json
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  retryAssistantCall,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { inspectOllamaRuntime, type OllamaRuntimeObservation } from "../src/conformance.ts";
import { loadConfig, type ConfigEntry } from "../src/config.ts";
import { DEFAULT_RETRY_POLICY } from "../src/complete.ts";
import { callOptions, getModels, loadModel } from "../src/load-model.ts";
import {
  runTruncationEvaluationTarget,
  type TruncationCallObservation,
  type TruncationEvaluationTargetReport,
  type TruncationProbeExecutor,
  type TruncationProbeTiming,
} from "../src/truncation-conformance.ts";

interface CliOptions {
  configKeys: string[];
  output?: string;
}

interface TargetEvidence {
  evaluation: TruncationEvaluationTargetReport;
  deploymentContext: {
    source: "configured" | "ollama-api-ps";
    configuredTokens: number;
    observedTokens?: number;
    verdict: "pass" | "fail";
    issues: string[];
  };
}

interface TruncationConformanceReport {
  schemaVersion: 1;
  recordedAt: string;
  verdict: "pass" | "fail";
  timingSemantics: {
    promptLatencyMs: "request start to first text, thinking, or tool-call stream event";
    generationLatencyMs: "first output stream event to terminal stream event";
    totalLatencyMs: "whole call including retry delays and failed attempts";
  };
  decision: {
    recommendedDefault: "drop-oldest" | "prefix-preserving-compaction-v1";
    candidateStatus: "selected" | "evaluated-not-selected";
    rule: string;
    reasons: string[];
  };
  targets: TargetEvidence[];
}

function parseCli(argv: readonly string[]): CliOptions {
  const configKeys: string[] = [];
  let output: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--output") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--output requires a path");
      output = value;
      index += 1;
    } else if (argument.startsWith("--")) {
      throw new Error(`unknown option ${argument}`);
    } else {
      configKeys.push(argument);
    }
  }
  return {
    configKeys: configKeys.length > 0 ? configKeys : ["codex-default", "local-qwen"],
    ...(output ? { output } : {}),
  };
}

function isFirstOutput(type: string): boolean {
  return (
    type === "text_start" ||
    type === "text_delta" ||
    type === "text_end" ||
    type === "thinking_start" ||
    type === "thinking_delta" ||
    type === "thinking_end" ||
    type === "toolcall_start" ||
    type === "toolcall_delta" ||
    type === "toolcall_end"
  );
}

function executor(
  models: Models,
  model: Model<Api>,
  entry: ConfigEntry,
  configKey: string,
): TruncationProbeExecutor {
  return async (context, probe): Promise<TruncationCallObservation> => {
    process.stderr.write(`  [${configKey}] ${probe.label}\n`);
    const operationStarted = Date.now();
    let attempts = 0;
    let successfulAttempt:
      | { message: AssistantMessage; promptLatencyMs: number; generationLatencyMs: number }
      | undefined;

    const message = await retryAssistantCall(
      async () => {
        attempts += 1;
        const attemptStarted = Date.now();
        let firstOutputAt: number | undefined;
        let terminalAt = attemptStarted;
        let terminal: AssistantMessage | undefined;
        const stream = models.streamSimple(model, context, {
          ...callOptions(entry),
          maxTokens: Math.min(entry.maxTokens, 128),
          cacheRetention: "short",
          sessionId: `sovereign-truncation-conformance-v1-${configKey}-${probe.strategy}`,
          timeoutMs: 120_000,
        });
        for await (const event of stream) {
          const now = Date.now();
          if (firstOutputAt === undefined && isFirstOutput(event.type)) firstOutputAt = now;
          if (event.type === "done") {
            terminal = event.message;
            terminalAt = now;
          } else if (event.type === "error") {
            terminal = event.error;
            terminalAt = now;
          }
        }
        terminal ??= await stream.result();
        terminalAt = Math.max(terminalAt, Date.now());
        firstOutputAt ??= terminalAt;
        successfulAttempt = {
          message: terminal,
          promptLatencyMs: firstOutputAt - attemptStarted,
          generationLatencyMs: terminalAt - firstOutputAt,
        };
        return terminal;
      },
      DEFAULT_RETRY_POLICY,
      undefined,
      {
        onRetryScheduled: (attempt, maxAttempts, delayMs, error) => {
          process.stderr.write(
            `    transient failure (${error}) — retry ${attempt}/${maxAttempts} in ${delayMs}ms\n`,
          );
        },
      },
    );

    if (!successfulAttempt || successfulAttempt.message !== message) {
      throw new Error(`truncation probe ${probe.label} completed without matching timing evidence`);
    }
    const timing: TruncationProbeTiming = {
      promptLatencyMs: successfulAttempt.promptLatencyMs,
      generationLatencyMs: successfulAttempt.generationLatencyMs,
      totalLatencyMs: Date.now() - operationStarted,
      retryCount: attempts - 1,
      measurement: "request-to-first-output-and-first-output-to-terminal",
    };
    return { message, timing };
  };
}

async function assertAuth(models: Models, provider: string): Promise<void> {
  const stored = await models.checkAuth(provider);
  if (!stored) throw new Error(`no credential is configured for provider ${provider}`);
  await models.getAuth(provider);
}

async function deploymentContext(
  entry: ConfigEntry,
  model: Model<Api>,
  configuredTokens: number,
): Promise<TargetEvidence["deploymentContext"]> {
  if (entry.provider !== "ollama") {
    return {
      source: "configured",
      configuredTokens,
      verdict: "pass",
      issues: [],
    };
  }
  let observation: OllamaRuntimeObservation;
  try {
    const response = await fetch(new URL("/api/ps", model.baseUrl), {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    observation = inspectOllamaRuntime(await response.json(), model.id, configuredTokens);
  } catch (error) {
    observation = {
      issues: [
        `could not verify Ollama served context (${error instanceof Error ? error.message : String(error)})`,
      ],
    };
  }
  return {
    source: "ollama-api-ps",
    configuredTokens,
    ...(observation.contextLength !== undefined
      ? { observedTokens: observation.contextLength }
      : {}),
    verdict: observation.issues.length === 0 ? "pass" : "fail",
    issues: observation.issues,
  };
}

function decide(targets: readonly TargetEvidence[]): TruncationConformanceReport["decision"] {
  const comparisons = targets.map((target) => target.evaluation.comparison);
  const safetyAndResponsesPass = targets.every(
    (target) => target.evaluation.verdict === "pass" && target.deploymentContext.verdict === "pass",
  );
  const factsImprove = comparisons.every((comparison) => comparison.factualRetentionDelta > 0);
  const estimatedCacheImproves = comparisons.every(
    (comparison) => comparison.estimatedStablePrefixTokenDelta > 0,
  );
  const noObservedCacheRegression = comparisons.every(
    (comparison) => comparison.providerCacheExtent !== "candidate-regressed",
  );
  const observedCacheImprovement = comparisons.some(
    (comparison) => comparison.providerCacheExtent === "candidate-improved",
  );
  const costBounded = comparisons.every((comparison) => comparison.costRatio <= 1.25);
  const promptLatencyBounded = comparisons.every(
    (comparison) => comparison.promptLatencyRatio <= 2,
  );
  const selected =
    safetyAndResponsesPass &&
    factsImprove &&
    estimatedCacheImproves &&
    noObservedCacheRegression &&
    observedCacheImprovement &&
    costBounded &&
    promptLatencyBounded;
  const reasons = [
    `safety-and-response-gates=${safetyAndResponsesPass ? "pass" : "fail"}`,
    `fixed-factual-retention=${factsImprove ? "improved" : "not-improved"}`,
    `estimated-stable-prefix=${estimatedCacheImproves ? "improved" : "not-improved"}`,
    `provider-cache-regression=${noObservedCacheRegression ? "none-observed" : "observed"}`,
    `provider-cache-improvement=${observedCacheImprovement ? "observed" : "not-observed"}`,
    `cost-ratio-limit-1.25=${costBounded ? "pass" : "fail"}`,
    `prompt-latency-ratio-limit-2.0=${promptLatencyBounded ? "pass" : "fail"}`,
  ];
  return {
    recommendedDefault: selected ? "prefix-preserving-compaction-v1" : "drop-oldest",
    candidateStatus: selected ? "selected" : "evaluated-not-selected",
    rule:
      "Select only when safety and response gates pass, fixed facts and stable-prefix extent improve, at least one provider reports a cache gain, no provider reports regression, cost stays within 1.25x, and prompt latency within 2x.",
    reasons,
  };
}

const cli = parseCli(process.argv.slice(2));
const recordedAt = new Date().toISOString();
const config = loadConfig();
const models = getModels();
const targets: TargetEvidence[] = [];

for (const configKey of cli.configKeys) {
  const { model, entry, contextWindow } = loadModel(configKey, config, models);
  process.stderr.write(`\n[truncation] ${configKey}: ${entry.provider}/${model.id}\n`);
  await assertAuth(models, entry.provider);
  const evaluation = await runTruncationEvaluationTarget({
    recordedAt,
    configKey,
    provider: entry.provider,
    modelId: model.id,
    servedContextWindow: contextWindow,
    execute: executor(models, model, entry, configKey),
  });
  targets.push({
    evaluation,
    deploymentContext: await deploymentContext(entry, model, contextWindow),
  });
}

const decision = decide(targets);
const report: TruncationConformanceReport = {
  schemaVersion: 1,
  recordedAt,
  verdict:
    targets.every(
      (target) =>
        target.evaluation.verdict === "pass" && target.deploymentContext.verdict === "pass",
    )
      ? "pass"
      : "fail",
  timingSemantics: {
    promptLatencyMs: "request start to first text, thinking, or tool-call stream event",
    generationLatencyMs: "first output stream event to terminal stream event",
    totalLatencyMs: "whole call including retry delays and failed attempts",
  },
  decision,
  targets,
};
const json = `${JSON.stringify(report, null, 2)}\n`;
if (cli.output) {
  const outputPath = resolve(cli.output);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, json, "utf8");
  process.stderr.write(`\n[truncation] wrote ${outputPath}\n`);
}
process.stdout.write(json);
if (report.verdict !== "pass") process.exitCode = 1;
