# Phase 1 — Model-Agnostic Harness (Expanded)

**Goal:** an abstraction layer that swaps between hosted APIs and self-hosted models without touching business logic.

**Total estimate:** 12–15 working days (fits inside the original 2–4 week window, front-loaded since you already have LLM API and tool-calling experience from the Pi agent work).

---

## 1.1 — Decide: LiteLLM vs. a custom shim
**Time:** 0.5 day

**Steps:**
1. Skim LiteLLM's source for how it normalizes tool-calling across providers — this is the part that usually breaks first.
2. Weigh it against writing your own shim: LiteLLM is faster to start but you own less of the translation logic (matters later when clients ask "how does this actually work under the hood").
3. Make the call. Given you've already hand-rolled tool-calling behavior on Pi, a thin custom shim will teach you more and be easier to explain to a client than a dependency you didn't write.

**Definition of done:** a one-paragraph decision written down (ADR-001 in the repo) — which path, and why. This isn't busywork — you'll want it later when a client asks why you built vs. bought.

---

## 1.2 — Define the unified request/response schema
**Time:** ~0.5 day (reduced — see below)

**Superseded by ADR-002.** `pi-ai`'s own `Context`/`Message`/
`AssistantMessage`/`ToolResultMessage` types are adopted as-is rather than
invented from scratch — full mapping and what the harness still needs to
add on top (routing metadata, latency, pre-flight validation) is in
`adrs/1.2-schema-ontology-mapping.md`.

**Steps (revised):**
1. ~~Write a `UnifiedMessage` type~~ — `pi-ai`'s `Message` union used
   directly.
2. ~~Write a `UnifiedResponse` type~~ — `pi-ai`'s `AssistantMessage` used
   directly; harness adds a thin `HarnessResult` wrapper for
   config/routing/latency, not a reshaped response type.
3. ~~Write a validator function~~ — tool-argument validation is built into
   `pi-ai` (`validateToolCall`). The one real gap is pre-flight `Context`
   validation (empty messages, malformed tool schema, unknown config key)
   — a thin `validateContext()` guard, not a full schema validator.

**Definition of done:** see revised DoD in
`adrs/1.2-schema-ontology-mapping.md`.

---

## 1.3 — Provider coverage (was: build two provider adapters)
**Time:** ~0.5 day (reduced — see below)

**Superseded by ADR-002.** `pi-ai`'s built-in `getModel('anthropic', ...)`
/ `getModel('openai', ...)` factories already are the adapters — no
translation code to write. Full scoping in
`adrs/1.3-provider-coverage-scope.md`.

**Steps (revised):**
1. ~~Build `adapter.chat()` per provider~~ — not needed, `pi-ai` handles
   request/response translation natively for both.
2. Verify the OpenAI leg live with real keys — the 1.1 spike only
   confirmed Anthropic (OpenAI's endpoint wasn't reachable from the spike's
   sandbox). This is the one real open item.
3. Diff `AssistantMessage` outputs from `getModel('anthropic', ...)` and
   `getModel('openai', ...)` on the same prompt for schema conformity —
   a verification script, not adapter modules.
4. LiteLLM-gateway custom `Model` definition is documented but its live
   re-verification is deferred to Phase 5 (ADR-002 already proved it works
   once, for the Anthropic leg).

**Definition of done:** see revised DoD in
`adrs/1.3-provider-coverage-scope.md`.

---

## 1.4 — Config-driven model routing
**Time:** ~0.5 day (reduced — see below)

**Superseded by ADR-002 + `pi-ai`'s `Models` registry.** Full design in
`adrs/1.4-config-routing-design.md`.

**Steps (revised, fields decided with the user 2026-07-28):**
1. `model.config.json` keeps only `provider`, `modelId`, `maxTokens`,
   `temperature`. `api_key_env` is dropped (redundant with `pi-ai`'s own
   env-based auth resolution). `fallback_provider`/`fallbackConfigKey` and
   a `routedVia` tag were both considered and explicitly deferred — no
   failure-handling requirement yet, and no gateway provider registered
   yet to route to. See `adrs/1.4-config-routing-design.md` for the full
   reasoning if either gets revisited.
2. `loadModel(configKey)` — single `models.getModel(provider, modelId)`
   call against a `pi-ai` `Models` collection (`builtinModels()`), no
   caller-side branching. Uses `pi-ai`'s `createModels()`/`Models`
   registry, not the deprecated flat `getModel()` the earlier docs
   illustrated with.
3. Prove it — still not run; blocked on the same live-verification gap as
   1.3 (needs real API keys).

**Definition of done:** see revised DoD in
`adrs/1.4-config-routing-design.md`. One open item: the LiteLLM-gateway
provider's auth strategy isn't decided yet (not urgent — deferred to
Phase 5 alongside the rest of gateway verification).

---

## 1.5 — Prompt/context management, decoupled from provider
**Time:** 2 days (unchanged — this task isn't reframed by `pi-ai`, see below)

**Not reframed by ADR-002 like 1.2–1.4.** `pi-ai`'s `Context` type has no
behavior — this is genuinely harness-owned design work. Researched how
`pi-coding-agent` (same repo as `pi-ai`) and a cross-harness survey
(Pi/OpenClaw/Claude Code/Letta) solve it before designing from scratch.
Full design in `adrs/1.5-conversation-manager-design.md`.

**Steps (decided with the user, 2026-07-28):**
1. `ConversationManager` is a stateful class wrapping one `pi-ai`
   `Context` (not pure functions) — matches `Context`'s own design as
   serializable state.
2. `append(message)`, `getHistory()`, plus `getContext()` (what actually
   gets passed to `pi-ai`'s `complete()`/`stream()`). Truncation runs on
   every `append()`, not lazily before a call.
3. Truncation is a **pluggable strategy** (not literally just "simple
   sliding window" as originally worded) — ships with drop-oldest as the
   Phase 1 default, atomic tool-call/result pairs enforced (never cut a
   `ToolResultMessage` away from its `ToolCall` — confirmed as a hard rule
   across every harness surveyed, not just a hunch). Summarization becomes
   a swappable strategy implementation later, not a redesign.
4. **New scope, not in the original spec:** a `maxToolResultChars` cap
   applied to `ToolResultMessage.content` at append time, separate from
   whole-conversation truncation. Every harness surveyed does this — tool
   results are consistently the single biggest contributor to context
   bloat, bigger than the conversation text itself.

**Definition of done:** see revised DoD in
`adrs/1.5-conversation-manager-design.md`. Default `reserveTokens` /
`maxToolResultChars` values and the drop-oldest algorithm's exact
implementation are still open — decided shape, not decided numbers.

---

## 1.6 — Provider-agnostic tool-calling
**Time:** ~1 day (reduced — see below)

**Two of three original steps already solved by `pi-ai`**, same shape of
finding as 1.3. Full design in `adrs/1.6-tool-calling-design.md`.

**Steps (revised, decided with the user 2026-07-28):**
1. ~~Define a `ToolDefinition` schema~~ — `pi-ai`'s `Tool` type already is
   this.
2. ~~Write `translateTools(tools, provider)`~~ — `pi-ai` translates tool
   schemas per-provider internally. Not harness code.
3. New: a `ToolRegistry` (toolName → `{ definition, handler }`) —
   something `pi-ai` has no concept of, since its `Tool` is schema-only.
4. `dispatchToolCall` — auto-wraps thrown handler errors into an
   `isError` `ToolResultMessage` (same failure shape as `pi-ai`'s
   built-in argument-validation errors). Multiple tool calls in one turn
   run in parallel via `Promise.allSettled`. Decoupled from 1.5's
   `ConversationManager` — returns results, doesn't append them itself;
   an orchestration loop (not yet designed) does that via `append()`,
   which is also where 1.5's tool-result size cap actually gets applied.
5. Wire in one real tool to test with — Tavily search, unchanged from the
   original pick.

**Definition of done:** see revised DoD in
`adrs/1.6-tool-calling-design.md`.

---

## 1.7 — Capstone: refactor an existing project onto the harness
**Time:** 3–4 days

**Steps:**
1. Pick a real project with existing direct LLM API calls — the Pi agent work is a strong candidate given the multi-provider comparison and tool-calling you've already done there.
2. Find every direct API call in the project and replace it with a harness call.
3. Add a second provider to the config.
4. Swap providers via the config flag only — verify identical behavior, no code changes.
5. Write a short before/after note (2–3 sentences + a screen recording or test log) — this becomes your first proof point for client conversations.

**Definition of done:** same project, same functionality, provider swap demonstrated live via one config-file edit.

---

## Phase 1 exit checklist
- [ ] Two provider adapters implemented and passing shared tests
- [ ] Config-only model swap demoed end to end
- [ ] Tool-calling normalized and proven with at least one real tool
- [ ] Existing project refactored onto the harness, provider-swap verified
- [ ] ADR-001 (LiteLLM vs. custom) written down

Once all five are checked, Phase 2 (local/self-hosted inference) plugs a new adapter into the same harness — no rework of anything above.
