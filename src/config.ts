/**
 * 1.4 — Config-driven model routing: the config file half.
 *
 * Per `phase1/adrs/1.4-config-routing-design.md`, a config entry carries
 * exactly four fields. Three others were considered and deliberately left
 * out — do not add them back without revisiting that ADR:
 *
 *  - `fallbackConfigKey` — deferred; nothing in Phase 1 exercises failure
 *    modes, so it would be unused surface area.
 *  - `routedVia` — deferred; no gateway provider is registered yet, so
 *    there is nothing to tag. (`HarnessResult.routedVia` still exists and
 *    is always "native" — it just has no config-level source.)
 *  - `apiKeyEnv` — rejected outright, not deferred. pi-ai's providers
 *    already resolve auth via `ProviderAuth`; naming env vars again here
 *    would be a second place that can drift.
 */

import { readFileSync } from "node:fs";
import { fromRepoRoot } from "./paths.ts";
import { HarnessError } from "./types.ts";

export interface ConfigEntry {
  provider: string;
  modelId: string;
  maxTokens: number;
  /**
   * Optional — CORRECTION to 1.4, forced by a real provider constraint.
   *
   * The ADR treats `temperature` as always present. `openai-codex` rejects
   * it outright: `Codex error: Unsupported parameter: temperature`. It is
   * not a compat flag pi-ai can auto-detect — the codex API forwards the
   * value verbatim and ChatGPT's backend refuses it.
   *
   * Made optional rather than inferred from `model.reasoning`, because
   * inference would be wrong elsewhere: Anthropic's reasoning models do
   * accept temperature (constrained), so `reasoning === true` is not a
   * reliable signal for "omit this". An absent field is unambiguous.
   */
  temperature?: number;
}

export type HarnessConfig = Record<string, ConfigEntry>;

/**
 * Default config location — anchored to the repo root, not the cwd, so the
 * scripts work from any directory. An explicit path passed to `loadConfig`
 * still resolves normally (i.e. against the cwd).
 */
export const DEFAULT_CONFIG_PATH: string = fromRepoRoot("model.config.json");

function assertEntry(key: string, value: unknown): ConfigEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HarnessError("invalidContext", `Config entry "${key}" must be an object.`);
  }

  const entry = value as Record<string, unknown>;
  const problems: string[] = [];

  if (typeof entry["provider"] !== "string" || entry["provider"] === "") {
    problems.push("`provider` must be a non-empty string");
  }
  if (typeof entry["modelId"] !== "string" || entry["modelId"] === "") {
    problems.push("`modelId` must be a non-empty string");
  }
  if (typeof entry["maxTokens"] !== "number" || !Number.isFinite(entry["maxTokens"]) || entry["maxTokens"] <= 0) {
    problems.push("`maxTokens` must be a positive number");
  }
  if (
    entry["temperature"] !== undefined &&
    (typeof entry["temperature"] !== "number" || !Number.isFinite(entry["temperature"]))
  ) {
    problems.push("`temperature` must be a number when present");
  }

  // Catch the deferred/rejected fields explicitly rather than ignoring
  // them. Silently accepting a `fallbackConfigKey` that nothing reads is
  // worse than saying it isn't wired up yet.
  const deferredFields = ["fallbackConfigKey", "routedVia", "apiKeyEnv", "api_key_env"];
  for (const deferred of deferredFields) {
    if (deferred in entry) {
      problems.push(
        `\`${deferred}\` is not supported in Phase 1 (see phase1/adrs/1.4-config-routing-design.md) — nothing reads it`,
      );
    }
  }

  // Reject any other unrecognised key too. Without this, the deferred-field
  // check above is trivially defeated by a typo: `temperture: 0.9` was
  // silently dropped, so the config looked applied and wasn't.
  const known = new Set(["provider", "modelId", "maxTokens", "temperature", ...deferredFields]);
  for (const key of Object.keys(entry)) {
    if (!known.has(key)) {
      problems.push(`unknown field \`${key}\` — nothing reads it (typo?)`);
    }
  }

  if (problems.length > 0) {
    throw new HarnessError(
      "invalidContext",
      `Config entry "${key}" is invalid:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }

  return {
    provider: entry["provider"] as string,
    modelId: entry["modelId"] as string,
    maxTokens: entry["maxTokens"] as number,
    ...(entry["temperature"] !== undefined
      ? { temperature: entry["temperature"] as number }
      : {}),
  };
}

/** Validates an already-parsed config object. */
export function parseConfig(raw: unknown): HarnessConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new HarnessError("invalidContext", "Config must be a JSON object keyed by configKey.");
  }

  const config: HarnessConfig = {};
  for (const [key, value] of Object.entries(raw)) {
    config[key] = assertEntry(key, value);
  }

  if (Object.keys(config).length === 0) {
    throw new HarnessError("invalidContext", "Config contains no entries.");
  }

  return config;
}

/** Reads and validates the config file from disk. */
export function loadConfig(path: string = DEFAULT_CONFIG_PATH): HarnessConfig {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    throw new HarnessError(
      "invalidContext",
      `Could not read config at "${path}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    return parseConfig(JSON.parse(contents));
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw new HarnessError(
      "invalidContext",
      `Config at "${path}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
