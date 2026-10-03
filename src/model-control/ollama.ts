/** A0-M.2 — Ollama runtime adapter behind the generic admission interface. */

import type { LocalRuntimeAdapter, LocalRuntimeSnapshot, RunningLocalModel } from "./admission.ts";
import type { ModelGeometry } from "../sizing.ts";

type Fetch = typeof globalThis.fetch;

export interface OllamaAdapterOptions {
  baseUrl?: string;
  fetch?: Fetch;
  now?: () => Date;
  freeMemory?: () => number;
  memorySource?: string;
  keepAlive?: string;
}

export interface OllamaModelDescription {
  modelId: string;
  digest?: string;
  quantization?: string;
  geometry: ModelGeometry;
  weightsBytes?: number;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveWhole(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function ggufNumber(info: Record<string, unknown>, suffix: string): number | undefined {
  for (const [key, value] of Object.entries(info)) {
    if (key.endsWith(suffix) && typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

export function parseOllamaProcessSnapshot(
  payload: unknown,
  options: { observedAt: string; freeMemoryBytes: number; memorySource: string },
): LocalRuntimeSnapshot {
  const issues: string[] = [];
  const models: RunningLocalModel[] = [];
  if (!object(payload) || !Array.isArray(payload["models"])) {
    issues.push("Ollama /api/ps response does not contain a models array");
  } else {
    payload["models"].forEach((candidate, index) => {
      const path = `Ollama model[${index}]`;
      if (!object(candidate)) {
        issues.push(`${path} is not an object`);
        return;
      }
      const modelId = typeof candidate["model"] === "string"
        ? candidate["model"]
        : typeof candidate["name"] === "string" ? candidate["name"] : "";
      const context = candidate["context_length"];
      const size = candidate["size"];
      const sizeVram = candidate["size_vram"];
      if (!modelId.trim()) issues.push(`${path} has no model identity`);
      if (!positiveWhole(context)) issues.push(`${path} context_length is invalid`);
      if (!nonNegative(size) || size === 0) issues.push(`${path} size is invalid`);
      if (!nonNegative(sizeVram)) issues.push(`${path} size_vram is invalid`);
      if (!modelId.trim() || !positiveWhole(context) || !nonNegative(size) || size === 0 || !nonNegative(sizeVram)) return;
      const details = object(candidate["details"]) ? candidate["details"] : undefined;
      models.push({
        modelId,
        ...(typeof candidate["digest"] === "string" && candidate["digest"].trim()
          ? { digest: candidate["digest"] }
          : {}),
        ...(details && typeof details["quantization_level"] === "string"
          ? { quantization: details["quantization_level"] }
          : {}),
        servedContextWindow: context,
        residentBytes: size,
        acceleratorBytes: sizeVram,
        ...(typeof candidate["expires_at"] === "string" ? { expiresAt: candidate["expires_at"] } : {}),
      });
    });
  }
  return {
    runtimeId: "ollama",
    observedAt: options.observedAt,
    freeMemoryBytes: options.freeMemoryBytes,
    memorySource: options.memorySource,
    models,
    issues,
  };
}

export class OllamaRuntimeAdapter implements LocalRuntimeAdapter {
  readonly runtimeId = "ollama";
  readonly #baseUrl: string;
  readonly #fetch: Fetch;
  readonly #now: () => Date;
  readonly #freeMemory: () => number;
  readonly #memorySource: string;
  readonly #keepAlive: string;

  constructor(options: OllamaAdapterOptions = {}) {
    const baseUrl = options.baseUrl ?? process.env["OLLAMA_HOST"] ?? "http://127.0.0.1:11434";
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Ollama baseUrl must use http or https");
    this.#baseUrl = url.toString().replace(/\/$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
    // There is no portable, authoritative accelerator-available-memory API.
    // In particular, node:os.freemem excludes reclaimable unified memory on
    // macOS and measured 187 MB while Ollama's Metal discovery reported
    // 5.3 GiB available. Missing injection stays invalid and is rejected by
    // the controller rather than silently becoming an admission authority.
    this.#freeMemory = options.freeMemory ?? (() => Number.NaN);
    this.#memorySource = options.memorySource ?? "unconfigured memory source";
    this.#keepAlive = options.keepAlive ?? "5m";
  }

  async inspect(signal?: AbortSignal): Promise<LocalRuntimeSnapshot> {
    const response = await this.#fetch(`${this.#baseUrl}/api/ps`, { signal });
    if (!response.ok) throw new Error(`Ollama /api/ps returned HTTP ${response.status}`);
    return parseOllamaProcessSnapshot(await response.json(), {
      observedAt: this.#now().toISOString(),
      freeMemoryBytes: this.#freeMemory(),
      memorySource: this.#memorySource,
    });
  }

  async describe(modelId: string, signal?: AbortSignal): Promise<OllamaModelDescription> {
    if (!modelId.trim()) throw new Error("modelId must be a non-empty string");
    const [show, tags] = await Promise.all([
      this.#fetch(`${this.#baseUrl}/api/show`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: modelId }),
        signal,
      }),
      this.#fetch(`${this.#baseUrl}/api/tags`, { signal }),
    ]);
    if (!show.ok) throw new Error(`Ollama /api/show returned HTTP ${show.status}`);
    if (!tags.ok) throw new Error(`Ollama /api/tags returned HTTP ${tags.status}`);
    const showBody = await show.json();
    const tagsBody = await tags.json();
    if (!object(showBody) || !object(showBody["model_info"])) {
      throw new Error("Ollama /api/show response has no model_info object");
    }
    const info = showBody["model_info"];
    const geometry: Partial<ModelGeometry> = {
      paramCount: ggufNumber(info, "general.parameter_count") ?? ggufNumber(info, "parameter_count"),
      layers: ggufNumber(info, ".block_count"),
      kvHeads: ggufNumber(info, ".attention.head_count_kv"),
      keyDim: ggufNumber(info, ".attention.key_length"),
      valueDim: ggufNumber(info, ".attention.value_length"),
    };
    for (const [field, value] of Object.entries(geometry)) {
      if (value === undefined) throw new Error(`Ollama metadata for ${modelId} has no ${field}`);
    }
    const tag = object(tagsBody) && Array.isArray(tagsBody["models"])
      ? tagsBody["models"].find((candidate) =>
          object(candidate) && (candidate["name"] === modelId || candidate["model"] === modelId))
      : undefined;
    const details = object(showBody["details"]) ? showBody["details"] : undefined;
    return {
      modelId,
      ...(object(tag) && typeof tag["digest"] === "string" ? { digest: tag["digest"] } : {}),
      ...(details && typeof details["quantization_level"] === "string"
        ? { quantization: details["quantization_level"] }
        : {}),
      geometry: geometry as ModelGeometry,
      ...(object(tag) && positiveWhole(tag["size"]) ? { weightsBytes: tag["size"] } : {}),
    };
  }

  async load(request: { modelId: string; contextWindow: number; signal: AbortSignal }): Promise<void> {
    const response = await this.#fetch(`${this.#baseUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: request.modelId,
        prompt: "",
        stream: false,
        keep_alive: this.#keepAlive,
        options: { num_ctx: request.contextWindow },
      }),
      signal: request.signal,
    });
    if (!response.ok) throw new Error(`Ollama load returned HTTP ${response.status}`);
    await response.arrayBuffer();
  }
}
