# ADR-002: Hybrid Harness — `pi-ai` in front, LiteLLM proxy as an optional gateway

**Status:** Accepted
**Date:** 2026-07-28
**Supersedes:** ADR-001

## Context

ADR-001 chose LiteLLM (SDK/proxy) as the translation layer with a custom
harness on top. A spike (see `1.1-spike-pi-ai-vs-litellm.md`) found `pi-ai`
— the unified-LLM package underneath the Pi coding agent — to be a stronger
fit for Phase 1 specifically: less code, compiler-checked TypeScript types,
and an ontology (`Message`/`ToolCall`/`AssistantMessage`) that nearly
matches 1.2's design directly.

LiteLLM's own strength wasn't eliminated by that finding — its proxy still
does something `pi-ai` doesn't: centralized spend tracking, per-client
virtual keys, and load balancing, which map directly onto Phase 5's
multi-tenant requirements. The question became whether these two had to be
an either/or choice.

## Finding: `pi-ai` supports custom OpenAI-compatible providers

`pi-ai` exposes `createProvider()`, which builds a provider from a `baseUrl`
+ an API implementation (`openai-completions`, etc.) + an auth strategy.
This is the exact same mechanism used internally for providers like Groq
(an OpenAI-compatible endpoint at a custom URL). It means a LiteLLM proxy —
which exposes an OpenAI-compatible `/v1/chat/completions` endpoint — can be
registered as *just another `pi-ai` provider*.

**Verified live:** stood up a LiteLLM proxy locally (Anthropic + OpenAI
models configured), registered it as a custom `pi-ai` provider pointed at
`http://localhost:4000/v1`, and called it through `pi-ai`'s normal
`models.complete()` interface with the same tool-calling test used in the
spike. The call round-tripped through the proxy to the real Anthropic API
and came back correctly wrapped in `pi-ai`'s standard `AssistantMessage`
shape — same typed response your app code gets from any native provider.

## Decision

**`pi-ai` is the harness's public interface. LiteLLM's proxy is registered
as one more provider behind it — used selectively, not universally.**

- App code (1.2's ontology, 1.5's conversation state, 1.6's tool dispatch)
  only ever talks to `pi-ai`'s typed `Context`/`Message`/`ToolCall`
  interface. It never knows or cares whether a given model call went direct
  to a provider SDK or through the LiteLLM proxy.
- **Direct native routing** (via `pi-ai`'s built-in provider factories —
  `anthropicProvider()`, `openaiProvider()`, etc.) is the default: fewer
  hops, lower latency, no extra process to run.
- **LiteLLM-gateway routing** (via the custom provider pattern proven above)
  is used specifically where its proxy features are actually needed —
  multi-tenant client deployments wanting centralized spend tracking,
  virtual keys per client, or load balancing across keys/regions. This
  becomes relevant starting around Phase 5, not Phase 1.
- Which path a given model uses is a **provider registration choice**, not
  an app-code branch — this folds cleanly into 1.4's config-driven routing:
  the config decides whether `claude-model` resolves to the native
  Anthropic provider or the LiteLLM-gateway provider, and app code is
  unchanged either way.

## Consequences

- 1.2 gets built on `pi-ai`'s existing types instead of from scratch.
- 1.3 is mostly "wire up native providers" plus one custom gateway provider
  for the proxy path — not two full adapters built by hand.
- Phase 5's multi-tenant story has a real target (LiteLLM's proxy) without
  it being forced into every deployment — single-client engagements skip
  running the proxy entirely.
- One more thing to document for a client: *why* a given model's calls go
  direct vs. through the gateway. Worth a one-line comment at the config
  level so it doesn't become a mystery six months later.
- Both dependencies are now in play (`pi-ai` and, conditionally, LiteLLM) —
  worth revisiting once Phase 5 firms up whether the proxy path actually
  gets used, or whether it stays theoretical.
