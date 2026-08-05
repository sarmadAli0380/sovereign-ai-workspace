/**
 * Registering any OpenAI-compatible server as a pi-ai provider.
 *
 * Deliberately generic. Ollama is the first user, but nothing here is
 * Ollama-specific: vLLM, llama.cpp's server, LM Studio, LiteLLM's proxy and
 * any other `/v1`-speaking endpoint register through the same function with
 * different data. Adding one is a config edit, not a code change — which is
 * the property the whole harness exists to provide.
 *
 * This is the first real use of the `Model<'openai-completions'>` +
 * custom `baseUrl` shape that ADR 1.3 specified for the LiteLLM gateway and
 * Phase 1 never exercised.
 */

import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createProvider } from "@earendil-works/pi-ai";
import type { Model, Provider } from "@earendil-works/pi-ai";
import { HarnessError } from "./types.ts";

export interface OpenAICompatibleModelSpec {
  /** Model id as the server knows it, e.g. "qwen3:4b". */
  id: string;
  /**
   * Context window the server ACTUALLY serves.
   *
   * Not what the model advertises. Measured: `qwen3:4b` advertises 262144
   * and Ollama serves 4096 (`/api/ps` -> `context served`). Overstating this
   * makes `ConversationManager` fill a budget the server silently discards.
   */
  contextWindow: number;
  maxTokens: number;
  name?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
}

export interface OpenAICompatibleProviderSpec {
  /** Provider id used as `provider` in model.config.json. */
  id: string;
  /** Full base URL including the version segment, e.g. "http://localhost:11434/v1". */
  baseUrl: string;
  models: OpenAICompatibleModelSpec[];
  name?: string;
  /**
   * API key, when the server wants one. Local servers usually don't, but
   * `resolve()` must still return a non-undefined result or pi-ai treats the
   * provider as unconfigured — see below.
   */
  apiKey?: string;
  /**
   * Per-provider compat overrides merged over pi-ai's auto-detection.
   *
   * `maxTokensField` is the one that matters for local servers and is
   * defaulted below; see that comment.
   */
  compat?: Model<"openai-completions">["compat"];
}

/**
 * Compat defaults for a self-hosted OpenAI-compatible server.
 *
 * pi-ai's `detectCompat()` branches on provider id and hostname substrings
 * (`api.together.ai`, `openrouter.ai`, …). It has NO case for localhost or
 * any self-hosted server, so an unrecognised baseUrl silently gets the
 * hosted-OpenAI defaults — including `maxTokensField: "max_completion_tokens"`.
 *
 * Measured against Ollama with a limit of 16:
 *   max_tokens            -> completion_tokens=16   finish=length   BOUNDED
 *   max_completion_tokens -> completion_tokens=156  finish=stop     IGNORED
 *
 * So without this override `maxTokens` is a silent no-op. `max_tokens` is
 * also the older, more broadly supported spelling, which makes it the right
 * default for self-hosted servers generally rather than a per-server patch.
 */
const SELF_HOSTED_COMPAT: Model<"openai-completions">["compat"] = {
  maxTokensField: "max_tokens",
};

/**
 * Validates `local-providers.json`.
 *
 * `model.config.json` has been validated field-by-field since 1.4, with a
 * regression test proving a typo is rejected rather than ignored. This file
 * had no equivalent, and it feeds the same machinery — so a one-character
 * typo landed as `undefined` and propagated. `"contextWindows"` with a
 * stray `s` produced `contextWindow: undefined`, then a `NaN` budget, then
 * a conversation that never truncated at all: the exact silent-overflow
 * failure the `contextWindow` override exists to prevent (2.5).
 *
 * Numeric fields are checked with `Number.isFinite`, not truthiness. `NaN`
 * and `Infinity` are both JSON-reachable via arithmetic upstream and both
 * defeat every `<= 0` guard downstream.
 */
export function parseLocalProviders(
  raw: unknown,
  source: string,
): OpenAICompatibleProviderSpec[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new HarnessError(
      "invalidContext",
      `${source} must be a JSON object keyed by provider id, got ` +
        `${Array.isArray(raw) ? "an array" : raw === null ? "null" : typeof raw}.`,
    );
  }

  const problems: string[] = [];
  const specs: OpenAICompatibleProviderSpec[] = [];

  for (const [id, value] of Object.entries(raw)) {
    const where = `provider "${id}"`;

    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      problems.push(`${where}: must be an object, got ${value === null ? "null" : typeof value}`);
      continue;
    }
    const spec = value as Record<string, unknown>;

    if (!id.trim()) problems.push(`provider id must not be blank`);

    if (typeof spec["baseUrl"] !== "string" || !spec["baseUrl"].trim()) {
      problems.push(`${where}: \`baseUrl\` must be a non-empty string`);
    }

    const known = new Set(["baseUrl", "models", "name", "apiKey", "compat"]);
    for (const key of Object.keys(spec)) {
      if (!known.has(key)) {
        // `id` is called out separately: it is not merely unread, it used to
        // silently *win* over the object key it was nested under.
        problems.push(
          key === "id"
            ? `${where}: \`id\` is taken from the object key, not the entry — remove it`
            : `${where}: unknown field \`${key}\` — nothing reads it (typo?)`,
        );
      }
    }

    const models = spec["models"];
    if (!Array.isArray(models)) {
      problems.push(`${where}: \`models\` must be an array`);
      continue;
    }
    if (models.length === 0) {
      problems.push(`${where}: \`models\` is empty — the provider would have nothing to serve`);
    }

    for (const [index, model] of models.entries()) {
      const at = `${where} model[${index}]`;
      if (typeof model !== "object" || model === null || Array.isArray(model)) {
        problems.push(`${at}: must be an object`);
        continue;
      }
      const m = model as Record<string, unknown>;

      if (typeof m["id"] !== "string" || !m["id"].trim()) {
        problems.push(`${at}: \`id\` must be a non-empty string`);
      }
      for (const field of ["contextWindow", "maxTokens"]) {
        const raw = m[field];
        if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
          problems.push(
            `${at}: \`${field}\` must be a finite positive number, got ${
              raw === undefined ? "nothing (typo?)" : JSON.stringify(raw)
            }`,
          );
        }
      }

      const knownModel = new Set([
        "id",
        "contextWindow",
        "maxTokens",
        "name",
        "reasoning",
        "input",
      ]);
      for (const key of Object.keys(m)) {
        if (!knownModel.has(key)) {
          problems.push(`${at}: unknown field \`${key}\` — nothing reads it (typo?)`);
        }
      }
    }

    if (problems.length === 0) {
      specs.push({ ...(spec as Omit<OpenAICompatibleProviderSpec, "id">), id });
    }
  }

  if (problems.length > 0) {
    throw new HarnessError(
      "invalidContext",
      `${source} is invalid:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }

  return specs;
}

export function openAICompatibleProvider(spec: OpenAICompatibleProviderSpec): Provider {
  const models: Model<"openai-completions">[] = spec.models.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    api: "openai-completions",
    provider: spec.id,
    baseUrl: spec.baseUrl,
    reasoning: m.reasoning ?? false,
    input: m.input ?? ["text"],
    // Self-hosted inference has no per-token price. Zeroed rather than
    // omitted so `usage.cost` stays present and the structural conformity
    // checks in verify-swap remain meaningful across providers.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    compat: { ...SELF_HOSTED_COMPAT, ...spec.compat },
  }));

  return createProvider<"openai-completions">({
    id: spec.id,
    name: spec.name ?? spec.id,
    baseUrl: spec.baseUrl,
    models,
    api: openAICompletionsApi(),
    auth: {
      // `createProvider` requires auth even for keyless servers. pi-ai's own
      // docs: "even ambient-credential providers and keyless local servers
      // provide `apiKey` auth whose `resolve()` reports whether the provider
      // is configured." Returning undefined would mark it unconfigured and
      // unusable, so a placeholder key is returned instead — local servers
      // ignore the value.
      apiKey: {
        name: `${spec.name ?? spec.id} (local)`,
        async resolve() {
          return {
            auth: { apiKey: spec.apiKey ?? "local" },
            source: spec.apiKey ? "config" : "keyless local server",
          };
        },
      },
    },
  });
}
