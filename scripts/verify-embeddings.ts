/** B5 live local embedding manifest and availability proof. */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  embeddingManifestDigest,
  parseLocalEmbeddingManifest,
  vectorParameter,
  type LocalEmbeddingModelManifest,
} from "../src/search/embeddings.ts";

interface CliOptions {
  output?: string;
  baseUrl: string;
  model: string;
}

const EXPECTED_VERSION = "v1.5";
const EXPECTED_DIMENSIONS = 768;
const DEFAULT_MODEL = "nomic-embed-text:v1.5";
const PROBE_INPUT = "search_query: B5 local embedding availability probe";

function parseCli(argv: readonly string[]): CliOptions {
  let output: string | undefined;
  let baseUrl = "http://127.0.0.1:11434";
  let model = DEFAULT_MODEL;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const next = argv[index + 1];
    if (argument === "--output" || argument === "--base-url" || argument === "--model") {
      if (!next || next.startsWith("--")) throw new Error(`${argument} requires a value`);
      if (argument === "--output") output = next;
      if (argument === "--base-url") baseUrl = next;
      if (argument === "--model") model = next;
      index += 1;
    } else {
      throw new Error(`unknown option ${argument}`);
    }
  }
  return { baseUrl, model, ...(output ? { output } : {}) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fetchJson(url: URL, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${url.pathname} returned HTTP ${response.status}`);
  return response.json();
}

function localEndpoint(baseUrl: string, path: string): URL {
  const root = new URL(baseUrl);
  if (root.protocol !== "http:" || (root.hostname !== "127.0.0.1" && root.hostname !== "localhost")) {
    throw new Error("embedding verification must target a local Ollama HTTP endpoint");
  }
  root.pathname = path;
  root.search = "";
  root.hash = "";
  return root;
}

function findModel(tagsPayload: unknown, model: string): Record<string, unknown> {
  if (!isObject(tagsPayload) || !Array.isArray(tagsPayload["models"])) {
    throw new Error("Ollama /api/tags response does not contain a models array");
  }
  const found = tagsPayload["models"].find((candidate) =>
    isObject(candidate) && (candidate["model"] === model || candidate["name"] === model)
  );
  if (!isObject(found)) throw new Error(`${model} is not installed in local Ollama`);
  return found;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function requireNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be a finite number`);
  return value;
}

function requireEmbedding(payload: unknown): readonly number[] {
  if (!isObject(payload) || !Array.isArray(payload["embeddings"])) {
    throw new Error("Ollama /api/embed response does not contain embeddings");
  }
  const first = payload["embeddings"][0];
  if (!Array.isArray(first)) throw new Error("Ollama /api/embed did not return a first embedding vector");
  return first.map((value, index) => requireNumber(value, `embedding[${index}]`));
}

const cli = parseCli(process.argv.slice(2));
const versionPayload = await fetchJson(localEndpoint(cli.baseUrl, "/api/version"));
const tagsPayload = await fetchJson(localEndpoint(cli.baseUrl, "/api/tags"));
const modelRow = findModel(tagsPayload, cli.model);
const details = isObject(modelRow["details"]) ? modelRow["details"] : {};
const showPayload = await fetchJson(localEndpoint(cli.baseUrl, "/api/show"), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: cli.model }),
});
const show = isObject(showPayload) ? showPayload : {};
const modelInfo = isObject(show["model_info"]) ? show["model_info"] : {};
const embeddingPayload = await fetchJson(localEndpoint(cli.baseUrl, "/api/embed"), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: cli.model, input: PROBE_INPUT }),
});
const embedding = requireEmbedding(embeddingPayload);
const tagDigest = requireString(modelRow["digest"], "model.digest");
const manifest: LocalEmbeddingModelManifest = parseLocalEmbeddingManifest({
  provider: "ollama",
  model: cli.model,
  version: EXPECTED_VERSION,
  dimensions: EXPECTED_DIMENSIONS,
  digest: `sha256:${tagDigest}`,
  endpoint: `${cli.baseUrl.replace(/\/$/, "")}/api/embed`,
});
vectorParameter(embedding, manifest.dimensions);
const issues: string[] = [];
if (requireString(versionPayload && isObject(versionPayload) ? versionPayload["version"] : undefined, "ollama.version") !== "0.32.5") {
  issues.push("Ollama version differs from B0 decision");
}
if (!Array.isArray(modelRow["capabilities"]) || !modelRow["capabilities"].includes("embedding")) {
  issues.push("model does not advertise embedding capability");
}
if (details["embedding_length"] !== EXPECTED_DIMENSIONS) {
  issues.push("tag metadata embedding_length does not match 768");
}
if (modelInfo["nomic-bert.embedding_length"] !== EXPECTED_DIMENSIONS) {
  issues.push("show metadata embedding length does not match 768");
}
if (details["quantization_level"] !== "F16") {
  issues.push("embedding model quantization is not F16");
}

const report = {
  schemaVersion: 1,
  kind: "local-embedding-manifest",
  recordedAt: new Date().toISOString(),
  verdict: issues.length === 0 ? "pass" : "fail",
  issues,
  runtime: {
    provider: "ollama",
    version: requireString(versionPayload && isObject(versionPayload) ? versionPayload["version"] : undefined, "ollama.version"),
    endpoint: manifest.endpoint,
  },
  manifest,
  manifestDigest: embeddingManifestDigest(manifest),
  modelMetadata: {
    sizeBytes: modelRow["size"],
    modifiedAt: modelRow["modified_at"],
    family: details["family"],
    parameterSize: details["parameter_size"],
    quantizationLevel: details["quantization_level"],
    contextLength: details["context_length"],
    embeddingLength: details["embedding_length"],
    architecture: modelInfo["general.architecture"],
    parameterCount: modelInfo["general.parameter_count"],
  },
  probe: {
    inputPrefix: "search_query",
    vectorDimensions: embedding.length,
    vectorSha256: createHash("sha256").update(JSON.stringify(embedding)).digest("hex"),
    durationNs: isObject(embeddingPayload) ? embeddingPayload["total_duration"] : undefined,
    promptEvalCount: isObject(embeddingPayload) ? embeddingPayload["prompt_eval_count"] : undefined,
  },
};

const json = `${JSON.stringify(report, null, 2)}\n`;
if (cli.output) {
  const output = resolve(cli.output);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, json, "utf8");
} else {
  process.stdout.write(json);
}
if (report.verdict !== "pass") process.exitCode = 1;
