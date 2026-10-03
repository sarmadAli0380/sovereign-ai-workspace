/**
 * A0-P.2 live prompt-cache conformance.
 *
 *   node scripts/verify-cache.ts
 *   node scripts/verify-cache.ts codex-default local-qwen --output conformance/cache.json
 *
 * Stdout is one machine-readable JSON document. Progress and retry messages
 * go to stderr so redirection remains safe.
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
import {
  runCacheConformanceTarget,
  type CacheCallObservation,
  type CacheProbeExecutor,
  type CacheProbeTiming,
  type CacheConformanceTargetReport,
} from "../src/cache-conformance.ts";
import { loadConfig, type ConfigEntry } from "../src/config.ts";
import { callOptions, getModels, loadModel } from "../src/load-model.ts";
import { DEFAULT_RETRY_POLICY } from "../src/complete.ts";

interface CliOptions {
  configKeys: string[];
  output?: string;
}

interface CacheConformanceReport {
  schemaVersion: 1;
  recordedAt: string;
  verdict: "pass" | "fail";
  timingSemantics: {
    promptLatencyMs: "request start to first text, thinking, or tool-call stream event";
    generationLatencyMs: "first output stream event to terminal stream event";
    totalLatencyMs: "whole call including retry delays and failed attempts";
  };
  targets: CacheConformanceTargetReport[];
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
): CacheProbeExecutor {
  const sessionId = `sovereign-cache-conformance-v1-${configKey}`;
  return async (context, probe): Promise<CacheCallObservation> => {
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
          maxTokens: Math.min(entry.maxTokens, 256),
          cacheRetention: "short",
          sessionId,
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
      throw new Error(`cache probe ${probe.label} completed without matching timing evidence`);
    }
    const timing: CacheProbeTiming = {
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

const cli = parseCli(process.argv.slice(2));
const recordedAt = new Date().toISOString();
const config = loadConfig();
const models = getModels();
const targets: CacheConformanceTargetReport[] = [];

for (const configKey of cli.configKeys) {
  const { model, entry, contextWindow } = loadModel(configKey, config, models);
  process.stderr.write(`\n[cache] ${configKey}: ${entry.provider}/${model.id}\n`);
  await assertAuth(models, entry.provider);
  targets.push(
    await runCacheConformanceTarget({
      recordedAt,
      configKey,
      provider: entry.provider,
      modelId: model.id,
      contextWindow,
      execute: executor(models, model, entry, configKey),
    }),
  );
}

const report: CacheConformanceReport = {
  schemaVersion: 1,
  recordedAt,
  verdict: targets.every((target) => target.verdict === "pass") ? "pass" : "fail",
  timingSemantics: {
    promptLatencyMs: "request start to first text, thinking, or tool-call stream event",
    generationLatencyMs: "first output stream event to terminal stream event",
    totalLatencyMs: "whole call including retry delays and failed attempts",
  },
  targets,
};
const json = `${JSON.stringify(report, null, 2)}\n`;
if (cli.output) {
  const outputPath = resolve(cli.output);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, json, "utf8");
  process.stderr.write(`\n[cache] wrote ${outputPath}\n`);
}
process.stdout.write(json);
if (report.verdict !== "pass") process.exitCode = 1;
