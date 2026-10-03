import { createHash } from "node:crypto";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export type LocalEmbeddingProvider = "ollama" | "local-process" | "local-file";

export interface LocalEmbeddingModelManifest {
  readonly provider: LocalEmbeddingProvider;
  readonly model: string;
  readonly version: string;
  readonly dimensions: number;
  readonly digest: `sha256:${string}`;
  readonly endpoint?: string;
}

export interface EmbeddingGenerator {
  readonly manifest: LocalEmbeddingModelManifest;
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export class EmbeddingConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingConfigurationError";
  }
}

export function embeddingManifestDigest(manifest: LocalEmbeddingModelManifest): string {
  const parsed = parseLocalEmbeddingManifest(manifest);
  return createHash("sha256").update(JSON.stringify({
    provider: parsed.provider,
    model: parsed.model,
    version: parsed.version,
    dimensions: parsed.dimensions,
    digest: parsed.digest,
    endpoint: parsed.endpoint ?? null,
  })).digest("hex");
}

export function parseLocalEmbeddingManifest(input: LocalEmbeddingModelManifest): LocalEmbeddingModelManifest {
  if (!["ollama", "local-process", "local-file"].includes(input.provider)) {
    throw new EmbeddingConfigurationError("embedding provider must be local");
  }
  if (typeof input.model !== "string" || input.model.length === 0) {
    throw new EmbeddingConfigurationError("embedding model must be a non-empty string");
  }
  if (typeof input.version !== "string" || input.version.length === 0) {
    throw new EmbeddingConfigurationError("embedding version must be a non-empty string");
  }
  if (!Number.isSafeInteger(input.dimensions) || input.dimensions <= 0 || input.dimensions > 16_000) {
    throw new EmbeddingConfigurationError("embedding dimensions must be a positive safe integer");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(input.digest)) {
    throw new EmbeddingConfigurationError("embedding model digest must be a full SHA-256 digest");
  }
  if (input.endpoint !== undefined) assertLocalEndpoint(input.endpoint);
  return { ...input };
}

export function assertLocalEndpoint(endpoint: string): void {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new EmbeddingConfigurationError("embedding endpoint must be a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "unix:") {
    throw new EmbeddingConfigurationError("embedding endpoint must use local http or unix transport");
  }
  if (parsed.protocol === "http:" && !LOCAL_HOSTS.has(parsed.hostname)) {
    throw new EmbeddingConfigurationError("hosted embedding endpoints are outside the client boundary");
  }
}

export function vectorParameter(vector: readonly number[], expectedDimensions?: number): string {
  if (
    !Array.isArray(vector) ||
    (expectedDimensions !== undefined && vector.length !== expectedDimensions) ||
    vector.length === 0
  ) {
    throw new TypeError("embedding vector dimensions do not match the pinned model");
  }
  for (const value of vector) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError("embedding vector values must be finite numbers");
    }
  }
  return `[${vector.map((value) => Number(value).toString()).join(",")}]`;
}
