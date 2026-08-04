/**
 * 1.4 — Config-driven model routing: the resolution half.
 *
 * A single lookup, no caller-side branching — that is 1.4's whole
 * definition of done. No fallback recursion and no `routedVia` branch;
 * both deferred per the ADR.
 *
 * NOTE (found while implementing, differs from the ADR's snippet):
 * `builtinModels` is NOT exported from the package root. The ADR shows
 *   import { builtinModels } from "@earendil-works/pi-ai";
 * but the package's `exports` map only publishes ".", "./compat",
 * "./providers/*", "./api/*", "./oauth", "./bedrock-provider" and
 * "./bun-oauth". The real path is "@earendil-works/pi-ai/providers/all".
 * Same family of gotcha as the deprecated flat `getModel()` already
 * recorded in findings-log.md.
 */

import { readFileSync } from "node:fs";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Api, Model, Models, MutableModels, Transport } from "@earendil-works/pi-ai";
import type { ConfigEntry, HarnessConfig } from "./config.ts";
import { FileCredentialStore } from "./credential-store.ts";
import {
  openAICompatibleProvider,
  type OpenAICompatibleProviderSpec,
} from "./openai-compatible.ts";
import { fromRepoRoot } from "./paths.ts";
import { HarnessError } from "./types.ts";

/** Self-hosted provider declarations. Absent file = no local providers. */
const LOCAL_PROVIDERS_PATH: string =
  process.env["HARNESS_LOCAL_PROVIDERS"]?.trim() || fromRepoRoot("local-providers.json");

/** Mirrors pi-ai's `Transport` union — a typo here silently changes behaviour. */
const VALID_TRANSPORTS = new Set(["sse", "websocket", "websocket-cached", "auto"]);

const warnedConfigKeys = new Set<string>();

/**
 * Warns once per configKey that `maxTokens` will not be applied.
 *
 * Driven by the entry's declared `maxTokensHonored`, NOT by a hardcoded
 * provider list. An earlier version kept `new Set(["openai-codex"])` here,
 * which put a provider name into harness control flow — precisely what a
 * model-agnostic harness must not do, since every new provider with the
 * same quirk would mean editing this file.
 *
 * A silent no-op on a spend-limiting field is the failure mode this project
 * already rejected for `fallbackConfigKey` and friends; the difference is
 * that `maxTokens` is real for other providers, so it can't just be
 * rejected. A warning keeps it usable without letting anyone believe their
 * response is bounded when it isn't.
 */
function warnIfMaxTokensIgnored(entry: ConfigEntry, configKey: string): void {
  if (entry.maxTokensHonored !== false) return;
  if (warnedConfigKeys.has(configKey)) return;
  warnedConfigKeys.add(configKey);

  console.warn(
    `[harness] configKey "${configKey}": provider "${entry.provider}" ignores maxTokens ` +
      `(${entry.maxTokens}) per its config declaration. Responses are NOT bounded.`,
  );
}

export interface ResolvedModel {
  model: Model<Api>;
  entry: ConfigEntry;
  configKey: string;
  /**
   * The context window callers should actually budget against: the entry's
   * override when present, else the model's advertised value.
   *
   * Exists because a provider can advertise a window it does not serve
   * (measured: `qwen3:4b` advertises 262144, Ollama serves 4096). Callers
   * should use this rather than `model.contextWindow`, so the override
   * cannot be bypassed by reading the model directly.
   */
  contextWindow: number;
}

/**
 * Turns a config entry into pi-ai call options.
 *
 * `temperature` is omitted entirely when the config doesn't set it —
 * passing `temperature: undefined` is not the same as not passing it, and
 * `openai-codex` rejects the parameter's mere presence. See `ConfigEntry`.
 *
 * `transport` resolves per entry first, then falls back to
 * `HARNESS_TRANSPORT`. The env var was originally the only source, which
 * was wrong granularity: it applied one provider's workaround to every
 * provider in the config. A provider needing `sse` should not force it on a
 * local server that doesn't. The env var is kept as a global escape hatch
 * for the case where the whole network blocks a transport.
 *
 * Why it's needed at all: `openai-codex` defaults to `auto`, which tries
 * WebSocket first and only falls back to SSE after a 15s connect timeout.
 * On a network where WebSocket to chatgpt.com is blocked, every call eats
 * that timeout and then reports `fetch failed`.
 */
export function callOptions(entry: ConfigEntry): {
  maxTokens: number;
  temperature?: number;
  transport?: Transport;
} {
  const envTransport = process.env["HARNESS_TRANSPORT"]?.trim();
  if (envTransport && !VALID_TRANSPORTS.has(envTransport)) {
    throw new HarnessError(
      "invalidContext",
      `HARNESS_TRANSPORT="${envTransport}" is not a valid transport. Expected one of: ${[...VALID_TRANSPORTS].join(", ")}.`,
    );
  }

  // Per-entry wins; the env var is the global fallback.
  const transport = entry.transport ?? envTransport;

  return {
    maxTokens: entry.maxTokens,
    ...(entry.temperature !== undefined ? { temperature: entry.temperature } : {}),
    ...(transport ? { transport: transport as Transport } : {}),
  };
}

let defaultModels: MutableModels | undefined;

/**
 * The shared `Models` registry, pre-loaded with every built-in provider
 * (auth already wired via each provider's `ProviderAuth`).
 *
 * Built lazily and cached: `builtinModels()` constructs every provider, so
 * calling it per `loadModel()` would be wasteful, and a single registry is
 * also what makes credentials (OAuth in particular) persist across calls.
 *
 * A file-backed credential store is injected because pi-ai's default is
 * in-memory — without it, an OAuth login would not survive the process.
 */
export function getModels(): MutableModels {
  if (!defaultModels) {
    defaultModels = builtinModels({ credentials: new FileCredentialStore() });
    registerLocalProviders(defaultModels);
  }
  return defaultModels;
}

/**
 * Registers every self-hosted provider declared in `local-providers.json`.
 *
 * Data-driven on purpose: adding vLLM, llama.cpp or a second Ollama box is a
 * JSON edit, with no branch anywhere in the harness that names a provider.
 * A missing file is normal — it just means no local providers.
 */
function registerLocalProviders(models: MutableModels): void {
  let raw: string;
  try {
    raw = readFileSync(LOCAL_PROVIDERS_PATH, "utf8");
  } catch {
    return;
  }

  let specs: Record<string, Omit<OpenAICompatibleProviderSpec, "id">>;
  try {
    specs = JSON.parse(raw);
  } catch (error) {
    throw new HarnessError(
      "invalidContext",
      `Could not parse ${LOCAL_PROVIDERS_PATH}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  for (const [id, spec] of Object.entries(specs)) {
    models.setProvider(openAICompatibleProvider({ id, ...spec }));
  }
}

/**
 * Resolves a configKey to a concrete pi-ai `Model`.
 *
 * `models` is injectable purely so tests can pass a registry with a fake
 * provider — production callers use the default.
 */
export function loadModel(
  configKey: string,
  config: HarnessConfig,
  models: Models = getModels(),
): ResolvedModel {
  const entry = config[configKey];
  if (!entry) {
    const available = Object.keys(config).sort().join(", ") || "(none)";
    throw new HarnessError(
      "unknownConfigKey",
      `Unknown configKey "${configKey}". Available: ${available}.`,
    );
  }

  const model = models.getModel(entry.provider, entry.modelId);
  if (!model) {
    throw new HarnessError(
      "modelNotFound",
      `No model "${entry.modelId}" registered for provider "${entry.provider}" (configKey "${configKey}").`,
    );
  }

  warnIfMaxTokensIgnored(entry, configKey);

  return {
    model,
    entry,
    configKey,
    contextWindow: entry.contextWindow ?? model.contextWindow,
  };
}
