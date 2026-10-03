/** A0-M.3 live 30-sample warm performance baseline for one config profile. */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  Type,
  retryAssistantCall,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type Models,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { loadConfig, type ConfigEntry } from "../src/config.ts";
import { callOptions, getModels, loadModel } from "../src/load-model.ts";
import { DEFAULT_RETRY_POLICY } from "../src/complete.ts";
import { collectAssistantMessageIssues } from "../src/conformance.ts";
import { CapabilityPolicy } from "../src/policy.ts";
import { dispatchToolCall, ToolRegistry } from "../src/tool-registry.ts";
import {
  PERFORMANCE_BASELINE_MINIMUM_SAMPLES,
  PERFORMANCE_BASELINE_SCHEMA_VERSION,
  summarizePerformanceSamples,
  type PerformanceSample,
} from "../src/performance-baseline.ts";

const benchmarkPolicy = new CapabilityPolicy({
  rules: [{
    deploymentId: "performance-verifier",
    roleId: "verifier",
    workspaceId: "verification",
    capability: "net",
    decision: "allow",
    reasonCode: "verification.weather-allowed",
  }],
});
const benchmarkPolicyOptions = {
  policy: benchmarkPolicy,
  policyContext: {
    deploymentId: "performance-verifier",
    roleId: "verifier",
    workspaceId: "verification",
  },
};

interface Cli {
  configKey: string;
  samples: number;
  output?: string;
  modelLoadMs: number;
  modelLoadSource: string;
}

function parseCli(argv: readonly string[]): Cli {
  let configKey = "codex-default";
  let samples = PERFORMANCE_BASELINE_MINIMUM_SAMPLES;
  let output: string | undefined;
  let modelLoadMs = 0;
  let modelLoadSource = "not-applicable-or-preloaded";
  let sawConfig = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const next = argv[index + 1];
    if (argument === "--samples" || argument === "--output" || argument === "--model-load-ms" || argument === "--model-load-source") {
      if (!next || next.startsWith("--")) throw new Error(`${argument} requires a value`);
      if (argument === "--samples") samples = Number(next);
      if (argument === "--output") output = next;
      if (argument === "--model-load-ms") modelLoadMs = Number(next);
      if (argument === "--model-load-source") modelLoadSource = next;
      index += 1;
    } else if (argument.startsWith("--")) {
      throw new Error(`unknown option ${argument}`);
    } else if (!sawConfig) {
      configKey = argument;
      sawConfig = true;
    } else {
      throw new Error(`unexpected argument ${argument}`);
    }
  }
  if (!Number.isFinite(samples) || !Number.isInteger(samples) || samples < PERFORMANCE_BASELINE_MINIMUM_SAMPLES) {
    throw new Error(`--samples must be a whole number >= ${PERFORMANCE_BASELINE_MINIMUM_SAMPLES}`);
  }
  if (!Number.isFinite(modelLoadMs) || modelLoadMs < 0) throw new Error("--model-load-ms must be non-negative");
  if (!modelLoadSource.trim()) throw new Error("--model-load-source must be non-empty");
  return { configKey, samples, modelLoadMs, modelLoadSource, ...(output ? { output } : {}) };
}

function firstOutput(type: string): boolean {
  return type.startsWith("text_") || type.startsWith("thinking_") || type.startsWith("toolcall_");
}

interface CallTiming {
  message: AssistantMessage;
  promptMs: number;
  generationMs: number;
  providerMs: number;
  retries: number;
}

const BENCHMARK_MAX_TOKENS = 512;
const BENCHMARK_SYSTEM_PROMPT = "You are a concise assistant. Use tools when they are relevant.";

async function timedCall(
  models: Models,
  model: Model<Api>,
  entry: ConfigEntry,
  context: Context,
  sessionId: string,
  toolChoice: "required" | "none",
): Promise<CallTiming> {
  const operationStart = performance.now();
  let attempts = 0;
  let successful: Omit<CallTiming, "providerMs" | "retries"> | undefined;
  const message = await retryAssistantCall(
    async () => {
      attempts += 1;
      const attemptStart = performance.now();
      let firstAt: number | undefined;
      let terminalAt = attemptStart;
      let terminal: AssistantMessage | undefined;
      const options: SimpleStreamOptions & { toolChoice: "required" | "none" } = {
        ...callOptions(entry),
        maxTokens: Math.min(entry.maxTokens, BENCHMARK_MAX_TOKENS),
        sessionId,
        timeoutMs: 120_000,
        toolChoice,
      };
      const stream = models.streamSimple(model, context, options);
      for await (const event of stream) {
        const at = performance.now();
        if (firstAt === undefined && firstOutput(event.type)) firstAt = at;
        if (event.type === "done") { terminal = event.message; terminalAt = at; }
        if (event.type === "error") { terminal = event.error; terminalAt = at; }
      }
      terminal ??= await stream.result();
      terminalAt = Math.max(terminalAt, performance.now());
      firstAt ??= terminalAt;
      successful = { message: terminal, promptMs: firstAt - attemptStart, generationMs: terminalAt - firstAt };
      return terminal;
    },
    DEFAULT_RETRY_POLICY,
    undefined,
  );
  if (!successful || successful.message !== message) throw new Error("provider call completed without timing evidence");
  return { ...successful, providerMs: performance.now() - operationStart, retries: attempts - 1 };
}

function safeIssues(message: AssistantMessage, requireToolCall: boolean): string[] {
  return collectAssistantMessageIssues(message, { requireSuccess: true, ...(requireToolCall ? { requireToolCall: true } : { requireText: true }) })
    .map((issue) => issue.startsWith("call did not succeed") ? "unsuccessful-stop-reason" : issue);
}

async function sample(
  index: number,
  scheduledAt: number,
  models: Models,
  model: Model<Api>,
  entry: ConfigEntry,
  registry: ToolRegistry,
  sessionId: string,
): Promise<PerformanceSample> {
  const start = performance.now();
  const queueTimeMs = start - scheduledAt;
  const user = {
    role: "user" as const,
    content: "What is the weather in Paris? Use the get_weather tool.",
    timestamp: Date.now(),
  };
  const tools = registry.getToolDefinitions();
  const first = await timedCall(
    models,
    model,
    entry,
    { systemPrompt: BENCHMARK_SYSTEM_PROMPT, messages: [user], tools },
    sessionId,
    "required",
  );
  const toolCall = first.message.content.find((block) => block.type === "toolCall");
  const issues = safeIssues(first.message, true);
  let toolDispatchMs = 0;
  let toolResults: Awaited<ReturnType<typeof dispatchToolCall>>[] = [];
  if (toolCall?.type === "toolCall") {
    const toolStart = performance.now();
    toolResults = [await dispatchToolCall(toolCall, registry, benchmarkPolicyOptions)];
    toolDispatchMs = performance.now() - toolStart;
    if (toolResults[0]?.isError) issues.push("tool-dispatch-error");
  } else {
    issues.push("missing-tool-call");
  }
  let second: CallTiming | undefined;
  if (toolResults.length > 0) {
    second = await timedCall(
      models,
      model,
      entry,
      {
        systemPrompt: BENCHMARK_SYSTEM_PROMPT,
        messages: [user, first.message, ...toolResults],
        tools,
      },
      sessionId,
      "none",
    );
    issues.push(...safeIssues(second.message, false));
  }
  const calls = second ? [first, second] : [first];
  const promptPhaseMs = calls.reduce((total, call) => total + call.promptMs, 0);
  const generationPhaseMs = calls.reduce((total, call) => total + call.generationMs, 0);
  const providerTimeMs = calls.reduce((total, call) => total + call.providerMs, 0);
  const promptTokens = calls.reduce((total, call) => total + call.message.usage.input + call.message.usage.cacheRead + call.message.usage.cacheWrite, 0);
  const outputTokens = calls.reduce((total, call) => total + call.message.usage.output, 0);
  return {
    index,
    queueTimeMs,
    timeToFirstEventMs: first.promptMs,
    promptPhaseMs,
    generationPhaseMs,
    providerTimeMs,
    toolDispatchMs,
    fullToolRoundTripMs: performance.now() - start,
    promptTokens,
    outputTokens,
    promptTokensPerSecond: promptPhaseMs > 0 ? promptTokens / (promptPhaseMs / 1_000) : 0,
    generationTokensPerSecond: generationPhaseMs > 0 ? outputTokens / (generationPhaseMs / 1_000) : 0,
    retryCount: calls.reduce((total, call) => total + call.retries, 0),
    conformance: issues.length === 0 && second !== undefined ? "pass" : "fail",
    issues: [...new Set(issues)],
  };
}

const cli = parseCli(process.argv.slice(2));
const config = loadConfig();
const models = getModels();
const { model, entry, contextWindow } = loadModel(cli.configKey, config, models);
const stored = await models.checkAuth(entry.provider);
if (!stored) throw new Error(`no credential is configured for provider ${entry.provider}`);
await models.getAuth(entry.provider);

const registry = new ToolRegistry();
registry.register({
  definition: {
    name: "get_weather",
    description: "Get the current weather for a city.",
    parameters: Type.Object({ city: Type.String() }),
  },
  controls: {
    capabilities: ["net"],
    risk: "low",
    timeoutMs: 120_000,
    maxOutputChars: 10_000,
    concurrencyCost: 1,
    sideEffect: "none",
    idempotency: "natural",
  },
  async execute(arguments_) {
    return { content: [{ type: "text", text: `18°C and sunny in ${String(arguments_["city"])}` }] };
  },
});

const sessionId = `sovereign-performance-v1-${cli.configKey}`;
process.stderr.write(`[performance] ${cli.configKey}: warm-up (excluded)\n`);
const warmup = await sample(1, performance.now(), models, model, entry, registry, `${sessionId}-warmup`);
if (warmup.conformance !== "pass") {
  process.stderr.write(`[performance] ${cli.configKey}: warm-up was non-conformant and remains excluded\n`);
}

const samples: PerformanceSample[] = [];
for (let index = 1; index <= cli.samples; index += 1) {
  const scheduledAt = performance.now();
  const measured = await sample(index, scheduledAt, models, model, entry, registry, sessionId);
  samples.push(measured);
  process.stderr.write(
    `[performance] ${cli.configKey} ${index}/${cli.samples}: ${measured.fullToolRoundTripMs.toFixed(0)}ms ${measured.conformance}\n`,
  );
}
const summary = summarizePerformanceSamples(samples);
const report = {
  schemaVersion: PERFORMANCE_BASELINE_SCHEMA_VERSION,
  recordedAt: new Date().toISOString(),
  verdict: summary.verdict,
  thresholds: null,
  thresholdStatus: "not-established",
  profile: { configKey: cli.configKey, provider: entry.provider, modelId: model.id, contextWindow },
  samplePolicy: {
    warmupExcluded: true,
    requiredWarmSamples: PERFORMANCE_BASELINE_MINIMUM_SAMPLES,
    measuredWarmSamples: cli.samples,
    requestedMaxTokensPerProviderCall: Math.min(entry.maxTokens, BENCHMARK_MAX_TOKENS),
    configuredMaxTokens: entry.maxTokens,
    maxTokensHonored: entry.maxTokensHonored !== false,
    firstCallToolChoice: "required",
    secondCallToolChoice: "none",
    workload: "fixed-weather-tool-round-trip-v1",
  },
  timingSemantics: {
    queueTimeMs: "sample scheduled to first provider operation",
    modelLoadMs: "separate pre-warm load measurement, excluded from warm distributions",
    timeToFirstEventMs: "first call start to first text, thinking, or tool-call stream event",
    promptPhaseMs: "sum of request-to-first-output across the two provider calls",
    generationPhaseMs: "sum of first-output-to-terminal across the two provider calls",
    providerTimeMs: "sum of whole provider operations including retry delays",
    fullToolRoundTripMs: "first provider operation through final assistant response",
    throughput: "end-to-end estimate from provider usage divided by stream phase timing; not server-internal kernel throughput",
  },
  modelLoad: { durationMs: cli.modelLoadMs, source: cli.modelLoadSource },
  warmup,
  samples,
  summary,
};
const json = `${JSON.stringify(report, null, 2)}\n`;
if (cli.output) {
  const output = resolve(cli.output);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, json, "utf8");
  process.stderr.write(`[performance] wrote ${output}\n`);
}
process.stdout.write(json);
if (summary.verdict !== "pass") process.exitCode = 1;
