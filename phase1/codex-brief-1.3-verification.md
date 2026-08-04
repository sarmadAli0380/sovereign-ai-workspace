# Codex brief — 1.3 verification (Sovereign AI Roadmap, Phase 1)

Paste this into Codex as-is.

---

You're working inside the `sovereign-ai-roadmap` repo. Phase 1 is building
a model-agnostic LLM harness. The design decisions are already made and
written down — read these three files first, in order, before writing any
code:

1. `phase1/adrs/ADR-002-hybrid-pi-ai-litellm-gateway.md` — the core
   decision: the harness is built on `@earendil-works/pi-ai` (npm), not a
   custom shim. LiteLLM is registered as one more `pi-ai` provider, used
   only for gateway routing (not needed yet).
2. `phase1/adrs/1.1-spike-pi-ai-vs-litellm.md` — the original spike. It
   proved the Anthropic leg works through `pi-ai` (via a `get_weather`
   tool-calling test) but explicitly left the OpenAI leg untested because
   the spike's sandbox couldn't reach OpenAI's endpoint.
3. `phase1/adrs/1.3-provider-coverage-scope.md` — current task scope. Key
   point: `pi-ai`'s built-in `getModel('anthropic', ...)` and
   `getModel('openai', ...)` factories already are the "provider
   adapters" — there is no translation/adapter code to write for either.
   What's actually left is verification, plus documenting one config
   object.

Do these three things, in order:

## 1. Verify the OpenAI leg live

Recreate the same tool-calling test case the spike used for Anthropic
(one `get_weather` tool, minimal schema), but run it against
`getModel('openai', <a current tool-calling-capable model id>)` using a
real `OPENAI_API_KEY`. Confirm the response comes back as a correctly
typed `pi-ai` `AssistantMessage` (content blocks, `usage`, `stopReason` —
same shape as the Anthropic leg, wording will differ, structure
shouldn't). This closes the one gap the original spike explicitly left
open.

## 2. Diff native provider outputs for schema conformity

Using `getModel('anthropic', ...)` and `getModel('openai', ...)`, run the
*same* prompt through both and diff the two `AssistantMessage` outputs —
checking structural conformity (same fields present, same shape for
`content`, `usage`, `stopReason`), not content wording. This is the actual
proof-of-abstraction step 1.3 originally called for; it's a short
verification script, not a pair of adapter modules.

## 3. Write the LiteLLM-gateway `Model` definition (config only, don't exercise it)

`phase1/adrs/1.3-provider-coverage-scope.md` already has the target shape
— a `Model<'openai-completions'>` object with `provider: 'litellm'`,
pointed at a local LiteLLM proxy's `/v1` endpoint, with
`compat.supportsStore: false` (LiteLLM's documented quirk). Write this as
a small, reusable config/constants file so it exists in the repo, but do
**not** stand up a LiteLLM proxy or live-test it — ADR-002 already proved
the mechanism works once (for Anthropic), and re-verifying both provider
legs through the gateway is explicitly deferred to Phase 5 in that ADR.
Don't pull that work forward.

## Output expected

- Whatever test/verification scripts you write, plus the `Model` config
  file, committed under `phase1/` (pick a sensible subfolder — this repo
  has no code yet, only planning docs, so you're establishing the first
  code location).
- A short findings note (a few sentences per item, matching the tone of
  `findings-log.md` in the repo root — plain prose, no fluff) covering:
  whether the OpenAI leg matched the Anthropic leg structurally, what (if
  anything) differed, and confirmation the gateway `Model` config is
  written and matches the documented shape. Append it to
  `findings-log.md` under a new "Task 1.3 — verification" subsection
  rather than creating a separate file.
- Do not change the scope decisions already made in ADR-002 or
  `1.3-provider-coverage-scope.md` — this is a verification pass, not a
  re-litigation of the architecture.
