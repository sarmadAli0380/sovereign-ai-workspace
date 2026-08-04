# Findings Log — Sovereign AI Roadmap

Running log of research findings and decisions made while working through the
roadmap. Update as each task progresses — this is the "why did we decide
that" reference, separate from the task breakdown and the ADRs themselves.

---

## Phase 1 — Model-Agnostic Harness

### Task 1.1 — LiteLLM vs. custom shim vs. `pi-ai` → **Decided (see ADR-002, supersedes ADR-001)**

**Final decision:** `pi-ai` (the unified-LLM package underneath the Pi
coding agent) is the harness's public interface. LiteLLM's proxy is
registered as one more provider behind it, used only where its
spend-tracking/virtual-key/load-balancing features are actually needed
(Phase 5-era, multi-tenant deployments) — not for every call.

**How this was reached:** ADR-001 initially chose LiteLLM SDK/proxy with a
custom harness on top. A follow-up spike built the same tool-calling test
case against both `pi-ai` and the LiteLLM proxy and found `pi-ai` came out
ahead for Phase 1 specifically — less code, compiler-checked TypeScript
types end to end, and a built-in ontology (`Message`/`ToolCall`/
`AssistantMessage`) that nearly matches the 1.2 design directly. LiteLLM's
proxy-specific strengths (centralized spend tracking, per-client virtual
keys, load balancing) remained real but scoped to Phase 5, not Phase 1.

**Then verified live that they combine, not compete:** `pi-ai` supports
registering any OpenAI-compatible endpoint as a custom provider via
`createProvider()` — the same mechanism it uses internally for providers
like Groq. Stood up a LiteLLM proxy locally, registered it as a `pi-ai`
provider, and ran the same tool-calling test through `pi-ai`'s normal
interface — the call round-tripped through the proxy to the real Anthropic
API and came back correctly typed as a standard `pi-ai` response. Confirmed
this isn't an either/or: `pi-ai` is the app-facing interface always;
whether a given model routes direct-to-provider or through the LiteLLM
gateway becomes a provider-registration/config choice, not different
application code.

**Findings that led there:**
- LiteLLM already translates OpenAI-format tool definitions into each
  provider's native tool-call format automatically, including `tool_choice`
  strategy mapping and parallel-vs-sequential call handling — the exact
  problem a custom shim would otherwise need to re-solve.
- It has native MCP support: tools loaded via MCP get translated across
  providers the same way, which lines up directly with the MCP work already
  done on the Pi agent project.
- It's MIT-licensed and open source, so the translation logic stays
  auditable even without having written it — usable in a client
  conversation about how the system works.
- It supports self-hosting, including air-gapped deployment — doesn't
  conflict with the sovereignty requirements coming in Phases 3–4.

**What LiteLLM saves specifically:**
- 1.3 (adapters): per-provider request/response translation, streaming
  chunk normalization, and error/exception mapping — largely solved.
- 1.6 (tool-calling): tool schema translation, `tool_choice` mapping,
  parallel-call handling, native MCP tool translation.
- Phase 2 spillover: Ollama and vLLM adapters already exist in LiteLLM, so
  local-model support in Phase 2 is a model-string change, not a
  from-scratch adapter.

**What stays owned regardless:**
- `ConversationManager` / context truncation policy (1.5) — LiteLLM doesn't
  manage conversation state.
- Actual tool *execution* once a call comes back (1.6's `dispatchToolCall`)
  — LiteLLM normalizes the call, execution logic is yours.
- Config-routing conventions for the harness itself (1.4) — can lean on
  LiteLLM's own Router format to save more time, but worth deciding
  deliberately rather than defaulting into it.
- Everything in Phases 3–5: data governance, audit logging, multi-tenant
  config — none of it is LiteLLM's job.

**Chinese open-weight model support (came up checking provider coverage):**
- Kimi (Moonshot AI) — native LiteLLM provider, `moonshot/kimi-k2...`,
  including tool-calling support.
- GLM (Zhipu AI / Z.AI) — native LiteLLM provider, `zai/glm-...`, documented
  as supporting all Z.AI GLM models under that prefix.
- Both also reachable via AWS Bedrock (`bedrock/moonshotai.kimi-k2.5`,
  `bedrock/zai.glm-4.7`) — relevant if a client wants to avoid a direct
  relationship with a Chinese API vendor but still use the model.
- Both are open-weight, so self-hosting via vLLM (Phase 2) is also on the
  table instead of calling the hosted APIs at all — relevant for clients
  whose sovereignty requirement extends to "no data to any external API,
  US or Chinese."

### Task 1.2 — Unified schema → **Decided (see `1.2-schema-ontology-mapping.md`)**

Framed conceptually as an **ontology**: the classes (Message, ToolCall,
ToolResult, Response), their relations, and the properties that must hold
regardless of provider. With ADR-002 in place, the task shifted from
"invent a schema from zero providers" to "decide what subset of `pi-ai`'s
own types becomes the harness's contract, plus what gets bolted on top."

**Verified against `pi-ai`'s actual README/source** (not just the spike's
summary): `Context`, `Message` (`UserMessage | AssistantMessage |
ToolResultMessage`), `ContentBlock` (text/thinking/toolCall/image), `Usage`,
and `StopReason` are adopted as-is — they already are 1.2's ontology.
Tool-argument validation is also already built in (`validateToolCall`
against TypeBox schemas), which was going to be part of 1.2's "validator
function" step.

**What the harness still adds:** a thin `HarnessResult` wrapper —
`{ message: AssistantMessage, configKey, routedVia: 'native' | 'gateway',
latencyMs }` — additive only, doesn't reshape or rename anything `pi-ai`
returns. Plus one real gap `pi-ai` doesn't cover: pre-flight validation of
a `Context` going *in* (empty messages, malformed tool schema, unknown
config key) — a narrow `validateContext()` guard, not a full schema
validator.

**Still research-stage** — no code written. `HarnessResult` needs 1.4's
config-routing shape to exist before it can actually be populated.

### Task 1.3 — Provider adapters → **Scoped down (see `1.3-provider-coverage-scope.md`)**

Confirmed the prediction from the 1.2 note: `pi-ai`'s native
`getModel('anthropic', ...)` / `getModel('openai', ...)` factories already
are the two "adapters" — the GoF adapter pattern named in
`roadmap-concept-map.md` is satisfied by library code, not something to
build. No `adapter.chat()` translation layer needed for either provider.

**Real gap found:** the 1.1 spike only verified the Anthropic leg live
(OpenAI's endpoint was unreachable from that sandbox). The OpenAI leg is
still unverified — that's the one concrete follow-up 1.3 actually owes,
not a from-scratch adapter build.

**The one genuinely new adapter** is the LiteLLM-gateway custom `Model`
definition from ADR-002 — documented now using `pi-ai`'s own published
LiteLLM integration example (`compat.supportsStore: false` etc.), but its
live re-verification is deliberately deferred to Phase 5, since ADR-002
already proved the mechanism works once and gateway routing isn't a Phase
1 concern per that ADR.

**Open question flagged, not resolved:** whether the gateway `Model`'s own
`cost` field is redundant with LiteLLM's own spend tracking — revisit
before Phase 5.

### Task 1.4 — Config-driven model routing → **Designed (see `1.4-config-routing-design.md`)**

Found something while researching this that retroactively affects 1.2 and
1.3: the flat `getModel()` function the `pi-ai` README's Quick Start uses
isn't actually exported from the root package — it only exists via the
deprecated `/compat` subpath (explicit `@deprecated` comment in source,
pointing at `createModels()`/provider factories as the real current
pattern). The README example is stale relative to the library's own
source. Added a correction note to `1.3-provider-coverage-scope.md`;
doesn't change any decision made there, just the exact call shape.

**Decision:** `loadModel(configKey)` resolves through a `pi-ai` `Models`
collection (`builtinModels()`) — one `models.getModel(provider,
modelId)` call, no branching in the caller, which is what the original
1.4 spec's "no branching logic in the caller" was actually asking for.

**Config schema — talked through with the user rather than decided
solo (2026-07-28):** locked in as `provider` + `modelId` + `maxTokens` +
`temperature` only. Three fields were floated and explicitly deferred
rather than included by default:
- `api_key_env` — dropped for good: native providers already resolve
  auth from env vars via `pi-ai`'s `ProviderAuth`, redundant to duplicate
  in harness config (same shape of finding as 1.2's dropped
  `raw_provider_metadata`).
- `fallbackConfigKey` — deferred, not rejected: no failure-handling
  requirement exists yet in Phase 1 to justify it.
- `routedVia` (native/gateway audit tag) — deferred alongside the rest of
  the gateway path (ADR-002, Phase 5) — nothing to tag while no gateway
  provider is registered.

**Consequence:** `HarnessResult.routedVia` (from 1.2) has no config-level
source yet — fine for now since every entry is native-only regardless.

**Open item, unchanged:** the LiteLLM-gateway provider still needs a real
`ProviderAuth` whenever it does get registered (`createProvider()`
requires one) — not decided, not urgent, deferred to Phase 5 with
everything else gateway-related.

**Still research-stage** — no code written. The "prove it" step is
blocked on the same live-verification gap flagged in 1.3 (needs real API
keys to actually run).

### Task 1.5 — ConversationManager → **Designed (see `1.5-conversation-manager-design.md`)**

Unlike 1.2–1.4, not reframed/shrunk by adopting `pi-ai` — `Context` is
plain data with no behavior, so this is genuinely harness-owned design
work. Researched precedent before designing:

- **`pi-coding-agent`** (sibling package to `pi-ai`) has a full working
  implementation ("compaction"): triggers at `contextWindow -
  reserveTokens` (default reserve 16,384), keeps the newest
  `keepRecentTokens` (default 20,000) verbatim, LLM-summarizes the rest,
  chars/4 token estimate (no tokenizer dependency), never cuts a tool
  result away from its tool call.
- **Arize cross-harness survey** (Pi, OpenClaw, Claude Code, Letta)
  confirmed those numbers are the converged/median approach, not an
  outlier, and surfaced something not in the original plan: all four
  harnesses cap **tool-result size** separately from, and before, whole-
  conversation compaction, because tool results (file reads, search, bash
  output) are consistently the single biggest contributor to context
  bloat — bigger than the conversation itself. Also: every harness keeps
  a dumb, guaranteed-to-work fallback under its smart compaction.

**Four decisions locked in with the user (not defaulted into):**
1. Tool-result capping (`maxToolResultChars`, applied on append) is in
   scope for 1.5, not deferred to later — cheap, and addresses the actual
   biggest contributor per the research above.
2. Truncation is a pluggable `TruncationStrategy` interface shipping with
   drop-oldest as the Phase 1 default, not hardcoded sliding-window-only —
   leaves room for summarization (LLM-based, or n-gram-based extractive
   summarization per the earlier throwaway-question tangent) to be swapped
   in later without redesigning the manager.
3. `ConversationManager` is a stateful class wrapping one `Context`, not
   pure functions — matches how `pi-ai` itself treats `Context` as
   serializable state.
4. Truncation runs on every `append()`, not lazily before a call.

**Still research-stage** — shape decided, not the actual drop-oldest
algorithm or default numbers (`reserveTokens`, `maxToolResultChars`). No
code written.

### Task 1.6 — Provider-agnostic tool-calling → **Designed (see `1.6-tool-calling-design.md`)**

Same shape of finding as 1.3: two of the original spec's three steps
already solved by `pi-ai`. `Tool` (name/description/TypeBox `parameters`)
already is the `ToolDefinition`. Per-provider tool-schema translation
happens inside `pi-ai`'s own `stream()`/`complete()` — not harness code.
Argument validation is built in (`validateToolCall`), with the right
failure mode already documented (`isError` result, model can retry).

**What's actually left, decided with the user:**
1. A `ToolRegistry` (toolName → `{ definition, handler }`) — `pi-ai`'s
   `Tool` is schema-only, has no execution function, so this mapping is
   genuinely new.
2. `dispatchToolCall` auto-wraps thrown handler errors into `isError`
   results — same failure shape as `pi-ai`'s own validation errors, one
   consistent behavior instead of two.
3. Multiple tool calls in one turn run in parallel via
   `Promise.allSettled` (not `Promise.all`) — one failing doesn't lose
   the others' results.
4. `dispatchToolCall` stays decoupled from 1.5's `ConversationManager` —
   returns `ToolResultMessage[]`, doesn't append them itself. A not-yet-
   designed orchestration loop wires dispatch output into `append()`,
   which is also where 1.5's `maxToolResultChars` cap actually applies —
   confirmed the decoupling doesn't lose that enforcement, just relocates
   it to the loop instead of inside dispatch.

Test tool unchanged from the original spec: Tavily search.

**Still research-stage** — shape decided, `ToolRegistry`/
`dispatchToolCall` not implemented, no code written.

### Task 1.7 → **Not started**

---

## Implementation pass — 1.2/1.4/1.5/1.6 built, 2026-07-30

First code in the repo. Everything above this line was research; this
section is what changed once the designs were actually run. Code lives in
`src/` (+ `scripts/`), separated from the design docs, in a real git repo
with `node_modules` gitignored. `pi-ai` pinned at 0.82.1.

### Correction: `builtinModels` is not a root export

`1.4-config-routing-design.md` shows `import { builtinModels } from
"@earendil-works/pi-ai"`. That import fails — the package's `exports` map
only publishes `.`, `./compat`, `./providers/*`, `./api/*`, `./oauth`,
`./bedrock-provider` and `./bun-oauth`. The real path is
`@earendil-works/pi-ai/providers/all`.

Same family of gotcha as the deprecated flat `getModel()` already recorded
under 1.4 — the docs describe the right *function*, just not a path that
resolves. Worth noting the pattern: every `pi-ai` import in the ADRs is
worth resolving against the installed package before trusting it, because
two of them have now been wrong in the same way.

### The rest of the ADRs' type assumptions held

Checked `Context` / `Message` / `AssistantMessage` / `ToolResultMessage` /
`Tool` / `Usage` against `dist/types.d.ts` rather than assuming. 1.2's
descriptions are accurate. Three additions it didn't mention, all of which
matter when *constructing* a message rather than consuming one:

- `AssistantMessage` also requires `api`, `provider`, `model` and
  `timestamp`. This bites on the harness-level error path, where the whole
  point is that no provider was ever resolved — so there's nothing truthful
  to put in those fields. Filled with the config's intended
  provider/modelId where known and a `"harness"` / `"harness-preflight"`
  marker where not, rather than left blank.
- `StopReason` includes `"pending"`, which 1.2 didn't list.
- `UserMessage.content` is `string | (TextContent | ImageContent)[]`, not
  just an array — the token estimator has to handle both.

### `fauxProvider` — the harness is verifiable without any credentials

`pi-ai` ships `@earendil-works/pi-ai/providers/faux`: a provider whose
responses are scripted (`setResponses([fauxAssistantMessage(...)])`),
designed for exactly this. This changes the "blocked on API keys" framing
that runs through 1.3/1.4/1.5's definitions of done.

What it *does* prove, run and passing: config → `loadModel()` resolution,
the full request → tool-call → dispatch → tool-result → response cycle,
provider swap via configKey with byte-identical calling code, parallel
tool dispatch surviving one failing sibling, and tool-result capping
before the next call. 70 tests, `tsc --noEmit` clean.

What it does **not** prove: that a real provider returns the shape `pi-ai`
promises. That is the only part still genuinely credential-gated, and it's
a narrower gap than "nothing is verified."

### Verification leg: `openai-codex`, because there are no API keys

Neither `ANTHROPIC_API_KEY` nor `OPENAI_API_KEY` is available in this
environment. The user has a Codex subscription via ChatGPT OAuth.

Initial read was that this couldn't drive the harness — that using the
subscription would mean lifting the token out of `~/.codex/auth.json`.
That was wrong. `pi-ai` ships a first-party `openai-codex` provider
(`dist/providers/openai-codex.js`), registered in `builtinModels()`,
`baseUrl: https://chatgpt.com/backend-api`, with `oauth` as its only auth
strategy and 7 models (`gpt-5.4`, `gpt-5.5`, `gpt-5.6-luna/sol/terra`,
`gpt-5.4-mini`, `gpt-5.3-codex-spark`) on the `openai-codex-responses`
API. Driving it is `models.login('openai-codex')` — the library's own
flow, not credential extraction.

Two things this does not give us:

- It is **not** the OpenAI Platform leg. `openai-codex-responses` is a
  distinct API surface, so this cannot close 1.3's
  Anthropic-vs-OpenAI-Platform structural diff. That specific comparison
  still needs both vendors' endpoints.
- `pi-ai` does **not** read the Codex CLI's credentials. Its store is
  separate and app-injected, so this is its own one-time login even when
  Codex CLI is already signed in.

Decision with the user: use `openai-codex` as the live leg now, add
locally-hosted models later as the second leg. `model.config.json` carries
a `codex-default` entry alongside the `claude-default` / `gpt-default`
entries from the ADR.

### Two pieces of infrastructure no ADR called for

Both found necessary while wiring the above, both flagged here rather than
slipped in silently:

- **`FileCredentialStore`** (`src/credential-store.ts`). `pi-ai`'s default
  `InMemoryCredentialStore` is documented as "Apps inject persistent
  stores" — without a persistent one, an OAuth login is discarded when the
  process exits. It's a plain 0600 JSON file, gitignored, explicitly not a
  secure secret store; a real deployment should use the OS keychain.
- **`terminalAuthInteraction`** (`src/terminal-auth.ts`). `pi-ai` leaves
  login orchestration to the app, so the `AuthInteraction` contract
  (`prompt` / `notify`) needs a terminal implementation to render auth
  URLs and device codes and read answers back.

### Defaults picked for 1.5 (the ADR left these open)

- `reserveTokens` = 16,384 — `pi-coding-agent`'s value, kept because it's
  the one surveyed number with a directly comparable meaning.
- `maxToolResultChars` = 16,000 — no precedent was directly copyable
  (Claude Code 50k/tool, OpenClaw 16k, Letta 5k under pressure, and
  `pi-coding-agent` caps at summarization time so has no equivalent at
  all). 16,000 sits at the conservative end: ~4,000 tokens, roughly a
  quarter of the reserve.

Both marked `TUNABLE` in code, per the ADR's instruction that these are
reference points rather than settled numbers.

**`dropOldestStrategy`'s cut-point algorithm**, which 1.5 left unwritten:
walk backwards from the newest message accumulating a chars/4 estimate,
cut at the oldest message that still fits, then push the cut *forward*
past any `toolResult` whose originating `toolCall` fell outside the kept
window. Two edge cases the contract didn't specify, decided here: the
newest message is kept even when it alone exceeds the budget (an empty
context is strictly worse than an over-budget one), and truncation never
returns an empty list.

### Config validation rejects the deferred fields loudly

`fallbackConfigKey`, `routedVia`, `apiKeyEnv` and `api_key_env` are all
rejected with an error pointing at the ADR, rather than ignored. Silently
accepting a `fallbackConfigKey` that nothing reads would let a caller
believe retry behaviour exists when it doesn't — a worse failure than a
loud one.

### Status against each task's definition of done

- **1.2** — `HarnessResult`, `validateContext()` and the harness-level
  error path implemented and tested. The ADR's un-itemized checks are now
  itemized (empty messages, malformed tool schema, unknown configKey, plus
  two additions: `required` naming an undefined property, and duplicate
  tool names).
- **1.4** — config + `loadModel()` implemented and tested. "Run a script
  twice, editing only the config between runs" is proven against the faux
  provider; against a real provider it is pending the OAuth login.
- **1.5** — implemented and tested, including the two open items (cut-point
  algorithm, default values).
- **1.6** — implemented and tested, including a real parallelism assertion
  (three handlers in flight at once) rather than just asserting the
  results.
- **Live leg** — `scripts/verify-live.ts` runs end to end and stops
  correctly at the credential gate. **Implemented but not yet run against
  a real model** — needs `node scripts/login.ts openai-codex`, which is an
  interactive browser authorization the user has to perform.

---

## Task 1.7 — target investigated, framing retired, 2026-07-30

Full write-up in `1.7-integration-and-comparison.md`. The short version and
the things that only belong here:

### `local-pi` has nothing to refactor — measured, not assumed

`CLAUDE.md` flagged this as a risk; checking settled it. `local-pi`
(`~/Documents/local-pi`) depends on `@earendil-works/pi-coding-agent`
^0.80.2 and no provider SDK. Grep across `src/`, `apps/`, `test/` for
`api.anthropic.com`, `api.openai.com`, `from "openai"`,
`from "@anthropic-ai/..."`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`: zero
hits. Two files import from `@earendil-works` at all.

So "lines of provider-specific code removed" = **0**. Worth recording as a
number rather than a hedge, because the original 1.7 spec treated it as the
headline metric.

Worse for the original framing: `local-pi` uses `createAgentSession` +
`SessionManager` + `ModelRegistry` + `AuthStorage`, which is a strictly
higher abstraction than this harness. And its model choice is already a
one-line config edit (`agent-home/settings.json` →
`"defaultModel": "gpt-5.5"`). A refactor would remove nothing, replace
working components with simpler ones, and re-demonstrate a capability the
target already has. Decision with the user: don't do it; 1.7 becomes the
live swap proof plus an honest comparison of where each layer fits.

This is the **fourth** Phase 1 task to shrink on contact with what `pi-ai`
already provides (1.2, 1.3, 1.6, now 1.7). That is no longer a series of
coincidences — it's the actual shape of this project, and worth carrying
into Phase 2 as a prior: check what the library already does before
scoping the task, not after.

### Credential reuse from `local-pi` — right idea, dead token

`local-pi/agent-home/auth.json` holds an `openai-codex` credential whose
shape matches `pi-ai`'s `OAuthCredential` field for field (`type`,
`access`, `refresh`, `expires`, `accountId`) — unsurprising once you notice
`pi-ai`'s own type doc describes it as "the shape of today's auth.json".
So `FileCredentialStore` can read a pi agent's auth file directly, and
`HARNESS_CREDENTIALS_PATH` was added to point at one.

It reads fine — `list()` returns the `openai-codex` entry, `read()` returns
a well-formed oauth credential. The refresh then fails:

```
OAuth refresh failed for openai-codex: OpenAI Codex token refresh failed
(401): { "code": "refresh_token_invalidated",
         "message": "Your session has ended. Please log in again." }
```

So the mechanism is proven and the credential is expired. Re-authorization
is a browser flow the user has to run; nothing in the harness can work
around it. **The real-provider leg remains implemented-but-unrun.**

### A bug this found in `scripts/verify-live.ts`

The script's auth pre-flight was `models.getAuth(...).catch(() =>
undefined)`, which collapsed two different failures — "no credential
stored" and "credential stored but unusable" — into one misleading message
("No credential… run login"). With an expired token that sends you looking
in the wrong place entirely.

Fixed: `checkAuth()` decides whether anything is stored, then `getAuth()`
runs uncaught so the real reason surfaces, with expiry detected and named.
Worth logging because it's the first bug found by running the harness for
real rather than by testing it, and the cause is generic — a `.catch()`
that discards the error is how a clear failure becomes a confusing one.

### Swap proof: what it can and cannot show yet

`scripts/verify-swap.ts` implements 1.4's outstanding DoD — same prompt,
two config keys, byte-identical calling code, structural diff of the two
`AssistantMessage`s (field presence and types, never wording).

With only `openai-codex` reachable, the first live run will be a **model**
swap (`gpt-5.6-luna` ↔ `gpt-5.5`), not a provider swap. The script reports
which of the two it actually performed rather than letting a model swap
read as a provider swap. A genuine cross-provider run needs the
locally-hosted second leg, deferred by the user to later.

---

## Live verification — first real-model run, 2026-08-03

The harness has now been run against a real model. Everything below was
found by running it, not by reading docs — and every item changed the code.

### `openai-codex` rejects `temperature` outright

```
Codex error: Unsupported parameter: temperature
```

1.4 decided the config schema is `provider`/`modelId`/`maxTokens`/
`temperature`, treating temperature as always present. That doesn't hold.
The codex API forwards the value verbatim (`openai-codex-responses.js:391`)
and ChatGPT's backend refuses it. There is no compat flag for it — unlike
LiteLLM's `supportsStore`, this isn't something pi-ai auto-detects.

**Correction to 1.4:** `temperature` is now optional in `ConfigEntry`, and
omitted from the request entirely when absent (`temperature: undefined` is
not the same as not sending the key).

Considered and rejected: inferring it from `model.reasoning === true`. All
7 codex models set that flag, so it would work here — but Anthropic's
reasoning models *do* accept temperature (constrained to 1), so the
inference would be wrong there. An absent config field is unambiguous;
a derived one would silently do the wrong thing on the next provider.

### WebSocket transport is blocked here; SSE works

`openai-codex` defaults to `transport: "auto"`, which tries WebSocket first
and falls back to SSE only after a 15s connect timeout
(`DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS`). On this network, WebSocket to
`chatgpt.com` never connects, so every call burned the timeout and then
reported a bare `fetch failed`. The 11-second latency on a "failed" call
was the tell.

Added `HARNESS_TRANSPORT` (env, unset by default). Deliberately **not** a
config-file field: transport is a property of the network you're on, not
of the model you're routing to, and putting it in `model.config.json`
would tie a per-environment fact to a per-model record. This is the same
reasoning that kept `apiKeyEnv` out in 1.4.

Note the fallback is cached per-process (`isWebSocketSseFallbackActive`),
which is why an early ad-hoc test with `auto` appeared to work — it had
already fallen back within that process. A fresh process pays the timeout
again. Worth knowing before concluding `auto` is fine.

### A false pass in the verification scripts

`verify-live.ts` printed `✓ AssistantMessage shape conforms` on a call that
had failed with `stopReason: "error"`. The shape check only tested field
presence and types — and an error message carries every required field, so
a network failure passed as a conforming response.

This is the worst class of bug in a verification tool: it reports success
for something never verified. Both scripts now check `stopReason` **first**,
before any field-presence check. Found only because a real call failed;
the faux-provider tests never produced an error message to trip over.

### Results

Live, `openai-codex` / `gpt-5.6-luna`, full cycle exercised:

```
turn 1: stopReason=toolUse  blocks=toolCall  usage in=82 out=18   1882ms
        get_weather -> isError=false
turn 2: stopReason=stop     blocks=text      usage in=117 out=14  1762ms
        "It's 18°C and sunny in Paris."
✓ AssistantMessage shape conforms
```

Swap proof (`verify-swap.ts codex-default codex-alt`), 22 fields compared:

```
codex-default -> gpt-5.6-luna  stop  in=30 out=44
codex-alt     -> gpt-5.5       stop  in=30 out=55
NOTE: both resolved to provider "openai-codex" — MODEL swap, not provider swap.
differences (1):
  content[].types: codex-default=text  codex-alt=text|thinking
✓ every required field present with matching types
✓ swap performed with zero code changes — only the configKey differed
```

The one structural difference is real and correctly not treated as a
failure: `gpt-5.5` returned a `thinking` block, `gpt-5.6-luna` didn't.
Optional content-block types legitimately vary between models — that is
what the required-core check exists to separate out.

**This closes 1.4's outstanding DoD**, with the caveat the script prints
itself: it is a model swap, not a provider swap. A genuine cross-provider
run still needs the second leg.

### Intermittent `fetch failed`, and what measuring it revealed

Calls fail intermittently with a bare `fetch failed` — a connection-level
error, not an API rejection. Initially misread twice, both times by
reasoning from too few samples:

1. First guess was "systematic, specific to `verify-swap`" — because
   `verify-live` passed while `verify-swap` failed twice running. Tested
   the obvious difference (a Context with no `tools`): four variants, all
   passed. Hypothesis dead.
2. Second guess was model-specific, after `gpt-5.6-luna` failed where
   `gpt-5.5` succeeded on the same prompt. Running each 6 times: 6/6 and
   5/6. Also dead — just variance.

Actual rate: **~8% of individual calls**. The lesson is the method, not the
number — two consecutive failures felt like a pattern and were not, and
both wrong hypotheses came from treating a handful of runs as evidence.

**Retry added** (`src/complete.ts`), using pi-ai's own `retryAssistantCall`
+ `isRetryableAssistantError` rather than a hand-rolled loop, so
deterministic errors still fail fast. Confirmed `fetch failed` classifies
as retryable and `Unsupported parameter: temperature` does not — retrying
the latter would just slow down a real error.

This is **not** the `fallbackConfigKey` 1.4 deferred. That is retry against
a *different* configKey — a routing policy. This retries the *same* call
after a transport error. The deferral stands.

**The measurement that mattered:** retry should have made a two-call run
near-certain (0.92 → ~0.999 per call). Measured run-level success went from
~85% to only ~87% over 15 runs. That gap says the failures are **bursty,
not independent** — when connectivity drops, every attempt inside the retry
window fails together, so extra attempts in a short window buy almost
nothing. Widening the window is what helps; base delay went 500ms → 1000ms.

Not tuned beyond that on purpose: past a few seconds, retry stops absorbing
a flaky connection and starts hiding an outage, and a verification script
should fail visibly when the network is genuinely down.

Environmental, not a harness defect — the same script passes unchanged
minutes later. Recording it so a future failed run isn't mistaken for a
regression: **re-run before investigating.**

Incidental gap spotted in pi-ai while checking this: `ECONNRESET` is *not*
matched by `RETRYABLE_PROVIDER_ERROR_PATTERN`, though it is exactly the
kind of transient error the pattern is for. Not hit here, not worked
around, noted in case it bites later.

### Default paths were cwd-coupled

Running any script from outside the repo failed with
`Cannot find module .../scripts/verify-swap.ts`, and fixing *that* by
passing an absolute script path would only have moved the failure later:
`model.config.json` and `.harness-credentials.json` both resolved against
`process.cwd()`, so the script would then have failed with a confusing
"could not read config" instead.

The nastier variant never triggered but was available: a `model.config.json`
in whatever directory you happened to be standing in would have been picked
up silently, in preference to the repo's.

Fixed in `src/paths.ts` — `REPO_ROOT` is found by walking up from the
module's own location to the directory holding `package.json`, and the two
defaults anchor to it. Only *defaults* are anchored; an explicit path a
caller passes still resolves against the cwd, which is what anyone typing a
relative path expects.

Verified by running `verify-swap.ts` from `~/Desktop/ai` — a full pass,
credential store included. Guarded by tests, one of which spawns a child
process with `cwd: tmpdir()` so the regression can't return quietly.

---

## Adversarial QA pass, 2026-08-04

Ran an independent QA agent over the implementation with no steer toward
suspected problem areas — deliberately, since a hinted reviewer mostly
confirms the author's existing priors. It found six real defects, all
reproduced before reporting. Two were verified again by hand here before
fixing, because a reviewer's confidence isn't evidence.

The uncomfortable part: **93 tests were passing the whole time.** Every bug
below sat in a code path the suite covered. Tests encode the author's
assumptions, so they cluster exactly where the author was already right.

### 1. Truncation could emit a lone orphaned tool result (HIGH)

`dropOldestStrategy`'s orphan-skip loop advanced *forward* past tool
results whose `toolCall` had been dropped. When the history *ended* in such
results, the loop ran off the end and the `slice(length - 1)` fallback
returned the very orphan it was trying to skip — violating 1.5's explicit
"never separate a ToolCall from its ToolResultMessage" rule and producing a
context every provider rejects.

Not exotic: it fires on harness defaults. A 20k-context model
(reserve 16,384 → budget 3,616) plus one `read_file` result capped at the
default 16,000 chars ≈ 4,004 tokens, which alone exceeds budget. A 5,000-case
fuzz hit it ~20% of the time.

The existing test for exactly this invariant missed it because its final
message was a `user` message, so the fallback branch never ran.

Fixed by searching for a *valid* cut boundary in both directions: forward
first (drop orphans, stay near budget), and backward when no forward
boundary exists (pull the originating tool call back in). Index 0 is always
valid, so it terminates. Going over budget is the deliberate lesser evil —
an oversized context still runs, an invalid one is rejected outright.

### 2. Tool arguments were never validated — ADR 1.6 is wrong (MEDIUM)

1.6 states argument validation is already handled: "`validateToolCall` is
built in. Its documented failure mode is already the right one." It is not
built in. `validateToolCall` is *defined* in pi-ai and **called from
nowhere inside it** — verified by grep: two hits, both the declaration and
the definition. It's a utility for applications to invoke, not part of
`complete()`/`stream()`.

So the harness passed raw model-supplied arguments straight to handlers. A
missing required field surfaced as whatever the handler happened to throw
(`Cannot read properties of undefined`), and a handler that didn't crash
just proceeded on garbage — extra arguments passed through with
`isError: false`.

Fixed by calling `validateToolArguments` in `dispatchToolCall` before
execution. This is the same class of error as the `builtinModels` import
and the deprecated `getModel()`: **the ADRs' claims about what pi-ai does
for you have now been wrong three times.** Treat any remaining
"pi-ai already handles X" claim as unverified until executed.

Note this tightened real behaviour: three existing tests passed invalid
arguments and only passed because nothing checked. They were fixed, not
the validation loosened.

### 3. Images counted as zero tokens (MEDIUM)

`estimateTokens` summed only text/thinking/toolCall characters; image
blocks contributed 0 in every branch. The module claims the heuristic
"overestimates, so the budget is never blown by an underestimate", and 1.5
promises the context is always within budget. Neither held: 60 screenshots
against a 100-token budget reported `100/100, within budget` while holding
12.5 MB of base64.

Fixed by charging the base64 payload length. That far overstates what
providers *bill* for an image (~1–2k tokens) but is honest about what is
being carried, and matches the stated contract of erring high. Marked
TUNABLE — a flat per-image constant is the alternative if this evicts too
aggressively.

### 4. Credential store serialized writes per provider, not per file (MEDIUM)

`enqueue` chained writes per `providerId`, copied from
`InMemoryCredentialStore` — where that is correct, because each write
touches its own `Map` key. Here every write is a whole-file
read-modify-write, so two providers refreshing concurrently interleaved and
one silently clobbered the other's rotated token, while still reporting
success. A `delete` racing a slow `modify` also resurrected the deleted
credential.

This is a genuine copy-the-shape-without-the-reason bug: the interface was
matched, the invariant behind it wasn't. Fixed with a single chain — one
file, one writer.

### 5. Swap script's fingerprint hardcoded `"number"` (LOW)

`shape[\`usage.cost.${key}\`] = "number"` recorded the *expected* type
rather than the actual one, so a `cost.total` of `"n/a"` compared equal to
a real number and the diff passed clean. Same false-pass class as the
`stopReason` bug fixed a day earlier — twice now in the same file, which
suggests verification code needs the same scrutiny as the code it verifies,
not less.

### 6. `capToolResult` claimed truncation that never happened (LOW)

The `budget <= 0` branch set `didTruncate` unconditionally, including for
zero-length blocks that lost nothing. The model was told its result was cut
short when it wasn't — actively worse than no marker, since the marker
exists so the model can re-request a narrower range.

### Minor items, also fixed

- Unknown config fields were silently dropped, so a typo (`temperture`)
  defeated the whole point of the deferred-field rejection. Now rejected.
- `collectContextIssues` threw a raw `TypeError` on `tools: [null]` or a
  null context — a validator crashing instead of reporting.
- `HARNESS_TRANSPORT` was cast to `Transport` unchecked, so a typo was
  passed to the provider verbatim. Now validated against the union.

### What QA could not cover

No live provider calls (by instruction), so findings 1 and 4 are argued
against pi-ai's own conversion code rather than observed against a live
API. `verify-live.ts`/`verify-swap.ts` were read, not executed. The OAuth
login flow and `models.stream()` were untested — the latter because the
harness doesn't use it.

Suite is now 96 tests; every fix above has a regression test named
`REGRESSION:` so none of them can quietly come back.

---

## Live QA pass, 2026-08-04 (35 real calls)

Second QA pass with the live-call restriction lifted, aimed squarely at what
the offline pass couldn't reach. Four new defects, plus the first hard
evidence for the offline pass's headline finding.

### Finding 1 confirmed against a real provider

The orphaned-tool-result case was previously argued from pi-ai's conversion
code. It is now observed. Sending the pre-fix shape to codex:

```
B: [toolResult] alone   -> error: "No tool call found for function call
                            output with call_id call_ArbEmZ..."
C: [user, toolResult]   -> same rejection
D: post-fix output [assistant(toolCall), toolResult]
                        -> stop, "Paris is currently 18°C and sunny."
```

So the bug produced a hard provider rejection, and the fix's deliberate
go-over-budget choice produces a context the provider accepts. Re-running
the 5,000-case fuzz against the fixed strategy: **orphanFails 0** (was 997).

Worth noting the QA agent also retired its own earlier assertion:
`budgetFails 1058` in that fuzz is not a defect, it is the fix's documented
trade-off, so the old invariant was simply the wrong thing to assert.
Worst observed overshoot was 272 tokens against a 58-token budget, bounded
by the size of a single tool-call group.

### New: `maxTokens` is a silent no-op on `openai-codex` (MEDIUM)

`callOptions()` forwards `maxTokens` correctly, but pi-ai's
`openai-codex-responses` API never puts it on the wire. Verified by grep —
that module contains **zero** references to any max-tokens field name,
against 3 in `openai-responses` and 8 in `anthropic-messages`.

Measured live: `maxTokens: 40` returned a **736-token** response costing
$0.0044. The field is validated as required and positive, and both codex
entries in `model.config.json` carry a value that does nothing.

This directly contradicts this project's own stated rule — `config.ts`
rejects `fallbackConfigKey`/`routedVia`/`apiKeyEnv` precisely because
"silently accepting a field that nothing reads is worse than saying it
isn't wired up yet." For codex, `maxTokens` is that field.

It can't simply be rejected: it is real and honoured for every other
provider. `loadModel()` now warns once per configKey instead, so the field
stays usable without letting anyone believe their spend is bounded when it
isn't.

### New: the chars/4 estimator underestimates the content it matters most for (MEDIUM)

The heuristic claimed it "overestimates, so the budget is never blown by an
underestimate". Measured against the real tokenizer, that was false for
exactly the content this harness carries most:

```
English prose   0.88x  (overestimates — fine)
JSON / code     1.83x  UNDERESTIMATES
Chinese (CJK)   2.63x  UNDERESTIMATES
```

Tool results are mostly JSON and code, and 1.5's own research names them
the single biggest source of context bloat — so the estimator was weakest
precisely where it was load-bearing. Demonstrated end to end: a manager
sized for a 20,000-token model reported `3052 / 3616 — within budget` while
the provider counted **4,121** input tokens, already over its own budget.

Same class as the image finding: the budget invariant was unsound for a
content type the harness is expected to carry.

Divisor moved 4 → 3, and the false claim removed from the comment. **This
is a mitigation, not a fix, and the residual is an open decision:** at 3,
code still underestimates ~1.37x. Genuinely guaranteeing "never
underestimates" needs ~1.5 chars/token, which would overestimate English by
3x and waste most of the window. Having both requires a real tokenizer
dependency — deliberately not taken unilaterally, since 1.5 chose the
no-tokenizer approach on purpose.

### New: pre-flight guard accepted tool names providers reject (LOW)

`validateToolSchema` checked only that `name` was a non-empty string.
Providers enforce `^[a-zA-Z0-9_-]+$`. A name with a space passed pre-flight
and was rejected by codex: *"Invalid 'tools[0].name': string does not match
pattern."* The guard exists so misconfiguration surfaces locally instead of
as a confusing provider error — this was a paid round trip to learn
something checkable for free. Now validated. (Long names and empty
descriptions were accepted by the provider, so only the character class is
a real rule.)

### New: the finding-2 fix introduced a regression (LOW)

Wiring in argument validation dropped the old `?? {}` fallback, so a
`ToolCall` with absent `arguments` began failing validation with "must be
object" instead of running — breaking zero-argument tools. Not reachable
from a real provider (pi-ai's `parseStreamingJson` returns `{}` on every
failure path), so it only bites a hand-built or replayed ToolCall.

Recording it because the lesson generalises: **the fix for a validation gap
introduced a new validation bug**, and it took a second adversarial pass to
notice. Arguments are now normalised before validation.

### Live probes that held up

Negative results, all against `openai-codex`:

- **Parallel tool calls** — the model emitted two `toolCall` blocks in one
  turn; dispatch ran both, `appendAll` stored both, follow-up accepted. The
  composite codex id format (`call_xxx|fc_xxx`) round-trips intact through
  `toolCallId`.
- **Oversized tool result** — 44,000 chars capped to 16,071 with the
  truncation marker, accepted, and the model answered correctly from the
  truncated content.
- **Empty tool output** — accepted; no normalisation needed.
- **Truncation mid-conversation** — drop-oldest evicted the head at turn 3
  and every later call succeeded. Notably a context whose *first* message is
  an assistant message carrying a `thinking` block was accepted, so
  re-sending reasoning after truncation does not break the codex Responses
  API.
- **Retry against a real failure** — a genuine `upstream connect error or
  disconnect/reset before headers` was classified retryable and succeeded on
  retry 1/3. The policy works against real transport failures, not just
  simulated ones.
- **`usage.cost`** is fully populated on a subscription account, so
  verify-swap's required-field check is meaningful rather than vacuous.
- **`temperature` omission** — no `Unsupported parameter` error in 35 calls.
  The 1.4 correction is sound.

### Still not covered

- The credential-store race needs two providers refreshing concurrently;
  only one is reachable, and proving it live would mean writing to the real
  credential file. Verified offline against a temp-file store instead.
- True context-window overflow (~1.1M chars in one call) was judged outside
  the spend budget, so the estimator finding is measured by ratio and a
  scaled-down manager rather than an actual overflow rejection.
- Anthropic-specific paths remain inference; the live confirmation is
  codex's equivalent rejection, not Anthropic's.
- `models.stream()` is never called by the harness, so it stays unexercised.

---

## Phase 2 — local inference, and a model-agnosticism audit, 2026-08-04

### The harness had drifted toward provider-specific special-casing

Prompted by the user asking to check the harness was still model-agnostic.
An audit found one genuine violation, and my in-progress 2.5 design was
about to add three more:

- `load-model.ts:31` held `PROVIDERS_IGNORING_MAX_TOKENS = new Set(["openai-codex"])`
  — a provider name in harness *control flow*, meaning every new provider
  with the same quirk would require editing the harness.
- `HARNESS_TRANSPORT` was global, so one provider's workaround applied to
  every provider in the config.
- The 2.5 draft hardcoded Ollama's `maxTokensField` and `contextWindow`.

**Principle applied: provider quirks are data, not code.** All of it moved
into the config entry as optional declarations (`transport`,
`maxTokensHonored`, `contextWindow`), and self-hosted providers are now
declared in `local-providers.json` and registered generically by
`openai-compatible.ts`. Adding vLLM, llama.cpp or LM Studio is a JSON edit.

Post-refactor audit: **zero provider names remain in harness control flow.**

### Two silent-failure bugs caught by the verified design pass, before any code

Both are the same class as codex's `maxTokens` — accepted and ignored.

1. **`maxTokensField`.** pi-ai's `detectCompat()` branches on hostname
   substrings and has no case for localhost, so a self-hosted server gets
   the hosted-OpenAI default `max_completion_tokens`. Measured against
   Ollama at a limit of 16: `max_tokens` -> 16 tokens, `finish=length`;
   `max_completion_tokens` -> 156 tokens, `finish=stop`. Without the
   override `maxTokens` is a no-op.
2. **`contextWindow`.** `qwen3:4b` advertises 262144 and `ollama show`
   agrees, but `/api/ps` reports `context served: 4096` — a 64x
   overstatement. Trusting it would have `ConversationManager` fill a ~245k
   budget while the server silently discarded everything past 4096: a model
   that "forgets" while the harness insists nothing was dropped.

**The generalisable lesson:** I probed six compat flags and every one
returned `ok`, including `max_completion_tokens`, which does nothing.
*Tolerance is not support.* Testing whether a parameter is accepted proves
nothing; only testing whether it is honoured does. That is now the first
check for any new provider.

Worth recording a failed prediction too: I expected several compat flags to
need overrides (`store`, `developer` role, `reasoning_effort`). Ollama
tolerated all of them. Only `maxTokensField` mattered.

### A hidden large-context assumption in 1.5

Wiring the local model surfaced a real design flaw the cloud providers had
concealed: `ConversationManager` refused to construct at all.

```
Error: contextWindow (8192) must exceed reserveTokens (16384)
```

`DEFAULT_RESERVE_TOKENS = 16384` came from pi-coding-agent, which targets
200k-context hosted models — there it is ~6% of the window. On an
8192-token local model it exceeds the entire context. Every model tested
until now had a large window, so the assumption was invisible.

Fixed generically: the reserve is now `min(requested, contextWindow * 0.25)`.
Large windows are unaffected (272k still reserves 16384); small ones scale
down. This is exactly the class of bug the agnosticism audit was looking
for, found by running rather than reading.

### Phase 1's last gap is closed

```
providers: openai-codex vs ollama — genuine provider swap.
✓ Both responses carry every required AssistantMessage field with matching types.
✓ Swap performed with zero code changes — only the configKey differed.
```

Cloud API to self-hosted model, across different API surfaces
(`openai-codex-responses` vs `openai-completions`), same code. That is the
roadmap's Phase 1 project goal, and it needed Phase 2's local model to
demonstrate.

Full local round trip also verified: `stopReason: toolUse` with a
`thinking` block, `get_weather` dispatched, `stop` with the answer used.
`qwen3:4b` tool calling works cleanly — the Qwen3.5 renderer bug (2.1) does
not affect it.

101 tests, typecheck clean.

---

## Conceptual framework

Applied a structural-vs-dynamic lens across the roadmap (full breakdown in
`roadmap-concept-map.md`):

- **Ontology** (structure — what things are and how they relate): 1.2's
  schema, Phase 3's containers, Phase 4's access-control model, Phase 5's
  multi-tenant template.
- **Kinetics / dynamics** (how things change over time): 1.5's conversation
  state, Phase 3's orchestration, Phase 4's event-sourced audit log.

Recurring check: if a task feels tangled, it's often mixing structure and
dynamics in one place (a schema field that's secretly stateful, an
orchestration rule that's secretly a permission) — splitting the two
usually resolves the design.

---

## Files produced so far

- `phase1-model-agnostic-harness-expanded.md` — task-by-task breakdown of
  Phase 1 with steps, time estimates, and definition-of-done per task.
- `ADR-001-litellm-vs-custom-shim.md` — original 1.1 decision (superseded).
- `1.1-spike-pi-ai-vs-litellm.md` — head-to-head spike results.
- `ADR-002-hybrid-pi-ai-litellm-gateway.md` — final 1.1 decision (current).
- `1.2-schema-ontology-mapping.md` — 1.2 decision: `pi-ai` types adopted
  as-is, `HarnessResult` wrapper and `validateContext()` gap identified.
- `1.3-provider-coverage-scope.md` — 1.3 decision: native providers need no
  adapter code, OpenAI leg still needs live verification, gateway `Model`
  documented but re-verification deferred to Phase 5.
- `1.4-config-routing-design.md` — 1.4 decision: `loadModel()` resolves
  through `pi-ai`'s `Models` registry (`builtinModels()` +  a registered
  gateway provider), config schema drops `api_key_env`, gateway auth
  strategy flagged as open.
- `1.5-conversation-manager-design.md` — 1.5 decision: stateful class
  wrapping a `Context`, pluggable truncation strategy (drop-oldest
  default), tool-result size cap in scope, truncate on every append.
  Grounded in `pi-coding-agent`'s compaction implementation and a
  cross-harness survey (Pi/OpenClaw/Claude Code/Letta).
- `1.6-tool-calling-design.md` — 1.6 decision: separate `ToolRegistry`,
  auto-wrapped dispatch errors, parallel execution via
  `Promise.allSettled`, dispatch decoupled from `ConversationManager`.
- `roadmap-concept-map.md` — concept mapping across all five phases.
- `findings-log.md` — this file.
- `src/` — Phase 1 harness implementation (1.2/1.4/1.5/1.6) plus tests.
  `types.ts` + `harness-result.ts` + `validate-context.ts` (1.2),
  `config.ts` + `load-model.ts` (1.4), `conversation-manager.ts` +
  `truncation.ts` (1.5), `tool-registry.ts` (1.6), and two pieces no ADR
  called for: `credential-store.ts` + `terminal-auth.ts`.
- `model.config.json` — the 1.4 config file.
- `scripts/login.ts` — one-time provider OAuth login.
- `scripts/verify-live.ts` — end-to-end live verification against a real
  provider (implemented, not yet run — blocked on OAuth re-authorization).
- `scripts/verify-swap.ts` — 1.4's swap DoD: same prompt through two config
  keys, structural diff (implemented, not yet run — same blocker).
- `1.7-integration-and-comparison.md` — 1.7 reframed: `local-pi` has no
  provider code to remove and sits above this harness, so the refactor was
  retired in favour of the swap proof plus a comparison of where each layer
  fits.
