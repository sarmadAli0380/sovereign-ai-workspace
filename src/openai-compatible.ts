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
