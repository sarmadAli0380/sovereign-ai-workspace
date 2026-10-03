/** A0-M.3 live Ollama cold-load distribution. */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfig } from "../src/config.ts";
import { getModels, loadModel } from "../src/load-model.ts";
import { inspectOllamaRuntime } from "../src/conformance.ts";
import {
  PERFORMANCE_BASELINE_MINIMUM_SAMPLES,
  PERFORMANCE_BASELINE_SCHEMA_VERSION,
  summarizeDurationSamples,
  type DurationSample,
} from "../src/performance-baseline.ts";

interface Cli {
  configKey: string;
  samples: number;
  output?: string;
}

function parseCli(argv: readonly string[]): Cli {
  let configKey = "local-qwen";
  let samples = PERFORMANCE_BASELINE_MINIMUM_SAMPLES;
  let output: string | undefined;
  let sawConfig = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const next = argv[index + 1];
    if (argument === "--samples" || argument === "--output") {
      if (!next || next.startsWith("--")) throw new Error(`${argument} requires a value`);
      if (argument === "--samples") samples = Number(next);
      if (argument === "--output") output = next;
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
  return { configKey, samples, ...(output ? { output } : {}) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fetchJson(url: URL, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${url.pathname} returned HTTP ${response.status}`);
  return response.json();
}

const cli = parseCli(process.argv.slice(2));
const config = loadConfig();
const models = getModels();
const { model, entry, contextWindow } = loadModel(cli.configKey, config, models);
if (entry.provider !== "ollama") throw new Error("model-load baseline currently supports an Ollama profile only");
const root = new URL(model.baseUrl);
root.pathname = "/";
root.search = "";
root.hash = "";
const generateUrl = new URL("/api/generate", root);
const processUrl = new URL("/api/ps", root);

async function unload(): Promise<void> {
  await fetchJson(generateUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: model.id, keep_alive: 0, stream: false }),
  });
  const deadline = performance.now() + 30_000;
  for (;;) {
    const payload = await fetchJson(processUrl);
    const running = isObject(payload) && Array.isArray(payload["models"])
      ? payload["models"].some((candidate) =>
          isObject(candidate) && (candidate["model"] === model.id || candidate["name"] === model.id))
      : true;
    if (!running) return;
    if (performance.now() >= deadline) throw new Error("Ollama did not unload the model within 30 seconds");
    await new Promise((resolve_) => setTimeout(resolve_, 100));
  }
}

type ModelLoadSample = DurationSample & {
  servedContextWindow?: number;
  residentBytes?: number;
  acceleratorBytes?: number;
};

async function measure(index: number): Promise<ModelLoadSample> {
  try {
    await unload();
    const start = performance.now();
    await fetchJson(generateUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: model.id,
        prompt: "",
        stream: false,
        keep_alive: "5m",
        options: { num_ctx: contextWindow },
      }),
    });
    const durationMs = performance.now() - start;
    const payload = await fetchJson(processUrl);
    const observation = inspectOllamaRuntime(payload, model.id, contextWindow);
    const running = isObject(payload) && Array.isArray(payload["models"])
      ? payload["models"].find((candidate) =>
          isObject(candidate) && (candidate["model"] === model.id || candidate["name"] === model.id))
      : undefined;
    const residentBytes = isObject(running) && typeof running["size"] === "number" ? running["size"] : undefined;
    const acceleratorBytes = isObject(running) && typeof running["size_vram"] === "number"
      ? running["size_vram"]
      : undefined;
    const issues = [...observation.issues];
    if (residentBytes === undefined) issues.push("resident size was not reported");
    if (acceleratorBytes === undefined) issues.push("accelerator size was not reported");
    if (residentBytes !== undefined && acceleratorBytes !== undefined && residentBytes !== acceleratorBytes) {
      issues.push("model was not fully accelerator-resident");
    }
    return {
      index,
      durationMs,
      ...(observation.contextLength !== undefined ? { servedContextWindow: observation.contextLength } : {}),
      ...(residentBytes !== undefined ? { residentBytes } : {}),
      ...(acceleratorBytes !== undefined ? { acceleratorBytes } : {}),
      conformance: issues.length === 0 ? "pass" : "fail",
      issues,
    };
  } catch (error) {
    return {
      index,
      durationMs: 0,
      conformance: "fail",
      issues: [error instanceof Error ? error.message : String(error)],
    };
  }
}

process.stderr.write(`[model-load] ${cli.configKey}: warm-up load/unload (excluded)\n`);
const warmup = await measure(1);
const samples: ModelLoadSample[] = [];
for (let index = 1; index <= cli.samples; index += 1) {
  const sample = await measure(index);
  samples.push(sample);
  process.stderr.write(`[model-load] ${cli.configKey} ${index}/${cli.samples}: ${sample.durationMs.toFixed(0)}ms ${sample.conformance}\n`);
}
const summary = summarizeDurationSamples(samples);
const report = {
  schemaVersion: PERFORMANCE_BASELINE_SCHEMA_VERSION,
  kind: "model-load-baseline",
  recordedAt: new Date().toISOString(),
  verdict: summary.verdict,
  thresholds: null,
  thresholdStatus: "not-established",
  profile: { configKey: cli.configKey, provider: entry.provider, modelId: model.id, contextWindow },
  samplePolicy: {
    warmupExcluded: true,
    requiredSamples: PERFORMANCE_BASELINE_MINIMUM_SAMPLES,
    measuredSamples: cli.samples,
    stateBeforeEachSample: "model absent from Ollama /api/ps",
    processAndOsFileCache: "warm after the excluded first load",
  },
  timingSemantics: {
    durationMs: "accepted unload completion to completed /api/generate preload response; post-load inspection excluded",
  },
  warmup,
  samples,
  summary,
};
const json = `${JSON.stringify(report, null, 2)}\n`;
if (cli.output) {
  const output = resolve(cli.output);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, json, "utf8");
  process.stderr.write(`[model-load] wrote ${output}\n`);
}
process.stdout.write(json);
if (summary.verdict !== "pass") process.exitCode = 1;
