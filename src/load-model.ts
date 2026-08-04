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

import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Api, Model, Models, MutableModels, Transport } from "@earendil-works/pi-ai";
import type { ConfigEntry, HarnessConfig } from "./config.ts";
import { FileCredentialStore } from "./credential-store.ts";
import { HarnessError } from "./types.ts";

/** Mirrors pi-ai's `Transport` union — a typo here silently changes behaviour. */
const VALID_TRANSPORTS = new Set(["sse", "websocket", "websocket-cached", "auto"]);

/**
 * Providers whose pi-ai API implementation drops `maxTokens` entirely.
 * Verified by grepping the api module for any max-tokens field name.
 */
const PROVIDERS_IGNORING_MAX_TOKENS = new Set(["openai-codex"]);

const warnedConfigKeys = new Set<string>();

/**
 * Warns once per configKey that `maxTokens` will not be applied.
 *
 * A silent no-op on a spend-limiting field is the failure mode this project
 * already rejected for `fallbackConfigKey` and friends; the difference is
 * that `maxTokens` is real for other providers, so it can't just be
 * rejected. A warning keeps it usable without letting anyone believe their
 * response is bounded when it isn't.
 */
function warnIfMaxTokensIgnored(entry: ConfigEntry, configKey: string): void {
  if (!PROVIDERS_IGNORING_MAX_TOKENS.has(entry.provider)) return;
  if (warnedConfigKeys.has(configKey)) return;
  warnedConfigKeys.add(configKey);

  console.warn(
    `[harness] configKey "${configKey}": provider "${entry.provider}" ignores maxTokens ` +
      `(${entry.maxTokens}) — pi-ai's ${entry.provider} API never sends it. Responses are NOT bounded.`,
  );
}

export interface ResolvedModel {
  model: Model<Api>;
  entry: ConfigEntry;
  configKey: string;
}

/**
 * Turns a config entry into pi-ai call options.
 *
 * `temperature` is omitted entirely when the config doesn't set it —
 * passing `temperature: undefined` is not the same as not passing it, and
 * `openai-codex` rejects the parameter's mere presence. See `ConfigEntry`.
 *
 * `transport` is deliberately NOT part of the config schema: it's a
 * property of the network you're on, not of the model you're routing to,
 * so putting it in `model.config.json` would tie a per-environment fact to
 * a per-model record. It comes from `HARNESS_TRANSPORT` instead, and is
 * unset by default so pi-ai's own "auto" applies.
 *
 * Why it's needed at all: `openai-codex` defaults to `auto`, which tries
 * WebSocket first and only falls back to SSE after a 15s connect timeout.
 * On a network where WebSocket to chatgpt.com is blocked, every call eats
 * that timeout and then reports `fetch failed`. `HARNESS_TRANSPORT=sse`
 * skips straight to the working path.
 */
export function callOptions(entry: ConfigEntry): {
  maxTokens: number;
  temperature?: number;
  transport?: Transport;
} {
  const transport = process.env["HARNESS_TRANSPORT"]?.trim();
  if (transport && !VALID_TRANSPORTS.has(transport)) {
    throw new HarnessError(
      "invalidContext",
      `HARNESS_TRANSPORT="${transport}" is not a valid transport. Expected one of: ${[...VALID_TRANSPORTS].join(", ")}.`,
    );
  }

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
  defaultModels ??= builtinModels({ credentials: new FileCredentialStore() });
  return defaultModels;
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

  return { model, entry, configKey };
}
