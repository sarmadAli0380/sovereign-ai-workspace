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

## 2.4 — sizing math, measured rather than extrapolated, 2026-08-05

The last unverified assumption in shipped work. 2.5 shipped a KV-cache
table marked `[UNVERIFIED]` that extrapolated linearly from one data point.
Measured properly: `phase2/adrs/2.4-gpu-sizing-math.md`, implemented in
`src/sizing.ts` with the measurements pinned as regression fixtures.

### Memory is *exactly* linear in context — until it isn't

Sweeping `num_ctx` on `qwen3:4b` and reading `/api/ps`, every consecutive
interval had an identical slope of **148,480 B/token**. Not approximately
linear — identically, across six points from 1024 to 12288.

The interesting part is where it stops. At 14336 `size_vram < size`: layers
spilled to CPU, and total allocation jumped *above* the linear prediction,
because a split allocates on both sides. So the useful output of a sizing
calculation is not a number, it is **a number plus whether it fits** —
which is why `sizing.ts` ships `fitsIn()` next to `estimateMemory()`.

### The formula, and the field that makes it wrong

```
kvPerToken = layers × kvHeads × (keyDim + valueDim) × kvCacheBytes
```

`kvHeads`, **not** `heads`. `qwen3:4b` has 32 query heads and 8 KV heads;
grouped-query attention caches only the latter, so using `head_count`
overstates the cache 4×. Nearly every modern model is GQA, so this is the
default way the calculation goes wrong. There is a test asserting the 4×
gap so nobody "fixes" it later.

Verified against llama.cpp's own allocation log rather than inferred from
the slope:

```
llama_kv_cache: size = 1152.00 MiB (4096 cells, 36 layers, 2/2 seqs),
                K (f16): 576.00 MiB, V (f16): 576.00 MiB
```

1152 MiB ÷ 2 seqs ÷ 4096 = 147,456 B/token = `36 × 8 × 256 × 2`, exactly.

### Validating against a second family, not just a second point

A formula fitted to one model is a curve fit. Pulled `llama3.2:3b`
(28 layers, `llama` architecture) as a genuine generalisation test, with
the prediction written down first: KV of 114,688 B/token, and — since qwen
showed a 1024 B/token gap above the formula — a measured slope of 115,712
if that gap is per-token, or 115,484 if it is per-layer-per-token.

Measured: **115,712 on all three intervals.** Per-token, architecture
independent. Worst-case total error across both models, 0.41%.

### Three things the measurements corrected

1. **2.5's KV table ran ~15% high** throughout, because dividing a single
   data point folds the fixed overhead into the per-token rate. Corrected in
   place. Every *conclusion* survived — the errors were in the constant, not
   the reasoning. It also called 16384 "tight" when it is in fact past the
   spill boundary on this machine.
2. **`Q4_K_M` is ~5.0 bits/weight, not the ~4.8 usually quoted.** Measured
   from two real files: 4.97 and 5.03. K-quants keep embedding and output
   tensors at higher precision, so the effective rate climbs as vocabulary
   grows relative to parameters — which is exactly the small-model case. The
   quoted figure is closer to right on a 70B.
3. **`/api/ps` `size` is a projection, not a measurement.** It is the same
   number llama.cpp prints *before* allocating. Checked once against the OS:
   `llama-server` RSS 3530 MiB against a 3606 MiB projection, so it runs
   2.1% high. Fine to predict — admission decisions are made on the
   projection — but it should not be quoted as resident memory.

### Concurrency is the term clients will miss

Tested by starting a *second* Ollama on port 11435 with
`OLLAMA_NUM_PARALLEL=2`, leaving the primary server alone. 2 sequences ×
4096 came out within 0.1% of 1 sequence × 8192. Total cells is what costs
memory; how they split between concurrency and window length is free.

This is invisible in single-user testing. A box that comfortably serves one
8k session serves eight of them at 8× the cache.

### The ceiling is not a property of the machine

llama.cpp logs its own admission rule:

```
projected to use 3606 MiB of device memory vs 5460 MiB of free device memory
will leave 1854 >= 1024 MiB of free device memory, no changes needed
```

The budget is **free** memory, not installed memory, **minus a 1 GiB
reserve the runtime will not spend**. On unified memory every other process
draws from the same pool, so the 12288-fits/14336-spills boundary measured
here is where it fell with that desktop open — not a constant. Sizing
against installed memory overstates capacity twice over.

### Failed predictions

- **Wrong:** expected the measured slope to sit a few percent off the
  architectural formula with noise, requiring a fitted coefficient. It came
  out exact and integral, which is a stronger result than expected — the
  formula needed no fitting at all.
- **Wrong:** expected `Q4_K_M` to measure near 4.8 bits/weight. Both models
  came in at ~5.0, for a reason that only shows up on small models.
- **Right:** the 1024 B/token overhead is fixed per token, not per layer.

---

## Token budgeting — two defects, and a redesigned fix, 2026-08-05

Investigating the "Codex hybrid" the handoff described as *transcription,
not design*. It was neither. Full write-up in
`phase1/adrs/1.8-token-budgeting.md`; the findings are below.

Prompted by the user pointing at `odysseus-dev/odysseus` (84.8k stars,
Python, multi-provider) as a possible source of answers. It supplied two,
and the live probes supplied the rest.

### The budget never counted the system prompt or the tool schemas

`ConversationManager.getEstimatedTokens()` and `dropOldestStrategy` both
walk `context.messages`. But the constructor stores `systemPrompt` and
`tools` as *sibling fields* on the `Context`, and both are sent on every
request. Neither has ever been counted.

Measured on `verify-live`, whose whole message list at turn 1 is one
23-token user string:

| | estimator | provider |
|---|---|---|
| codex turn-1 input | 23 | **82** |
| ollama turn-1 input | 23 | **153** |

Decomposing codex: ~21 tokens of system prompt, ~38 for one trivial tool
schema. A no-tools probe closed to within 8 tokens of the reported input.

**So the chars/3 estimator is roughly right on prose — the bug is coverage,
not arithmetic.** One toy tool costs ~38 invisible tokens; a real agent
carries fifteen. And turn 1 is exactly the turn a usage anchor can never
help with, because no response has arrived. This fix is independent of the
anchor and should land first.

**Fixed and verified live the same day.** `estimateOverheadTokens()` charges
the system prompt and tool schemas as a *fixed floor* off the budget rather
than passing them to truncation — no strategy can drop a tool the caller
registered, so handing them to one would be theatre. The same `verify-live`
conversation that estimated 66 tokens against codex's reported ~131 now
estimates 151: from 2.0× under to 1.15× over, which is the direction this
module's contract asks for. A window whose reserve plus overhead leaves no
room for messages now throws at construction — a caller registering that
many tools has nothing to send, and that is a config error, not a runtime
condition.

### An assistant turn's replay cost is not what the harness holds

Two three-turn probes, identical prompts, written to force heavy reasoning
behind a one-word answer so any large `output` must be reasoning.

| | codex `gpt-5.6-luna` | qwen3:4b |
|---|---|---|
| turn 1 | in 74, out 58 | in 75, out **1261** |
| turn 2 | in 172, out 50 | in 125, out **1880** |
| turn 3 | in 248, out 23 | in 160, out **1164** |
| thinking block | **0 chars** | 3106 / 4930 / 3403 chars |

The harness's record of an assistant turn is wrong on both, in **opposite
directions**:

- **Codex** hands back an empty `thinking` block. The harness records ~3
  tokens; the provider's input grows ~37/turn more than that content
  explains. It is replaying reasoning we cannot see. We **understate**.
- **Qwen** hands back 3106 characters of thinking, which `estimateTokens`
  dutifully counts as ≈1039 tokens — and the next input went 75 → 125. It
  was not replayed at all. We **overstate**, by ~9×.

Reasoning tokens *are* counted in `usage.output` on both (58 output tokens
for an 8-character answer). That closes the open question about codex, and
simultaneously makes `output` useless as a predictor: the tokens are real,
their replay is not.

**The generalisable lesson, and it is the same shape as *tolerance is not
support*: a token you were billed for is not a token that will be resent.**
Accounting for generation and accounting for context are different
questions, and only the second sizes a budget.

Replay also appears to depend on message *shape* — the earlier
tool-calling run on the same qwen model showed turn-2 input of 396 against
a turn-1 total of 376, i.e. the whole turn including thinking replayed,
the opposite of this probe. Likely reasoning survives a tool-call
continuation and is dropped once a user message closes the turn. Observed,
not characterised.

Recording a wrong call: I inferred from that single tool-calling data point
that qwen replays thinking, while flagging that it rested on an arithmetic
coincidence. The probe disproved it. The flag was worth more than the
inference.

### The obvious fix was measured and rejected

Anchoring on `prev.in + prev.out` — the literal reading of the codex-hybrid
design — is safe on codex (+11 to +17 tokens) and unusable on qwen
(+1268, +1882, i.e. 11–13×). On an 8192 window it would truncate a
conversation the server sees as 160 tokens.

What ships instead: anchor on **`prev.in`** — the one number that measures
what was actually sent — and estimate only the messages appended since. It
is still visibly wrong per turn (−38 on codex, +1046 on qwen), but it has
the property neither alternative has: **the error cannot compound**, because
every turn re-anchors on freshly measured truth.

That reframed the whole change. Today's code estimates the whole history, so
on the qwen probe it would report ≈2838 tokens at turn 3 against a real 160,
and the gap widens forever. **The defect is unbounded drift, not per-turn
inaccuracy** — and per-turn accuracy stays mediocre after the fix, which is
fine.

**Both stages shipped the same day.** The anchor is applied without touching
1.5's `TruncationStrategy` contract, which was the part that looked like it
would need redesigning. A strategy measures the whole message list with the
heuristic and always has; rather than teach every strategy about anchors,
the *budget handed to it* is shifted by the difference:

```
allowed = budget − anchor.tokens + heuristic(anchored prefix)
```

which reduces exactly to `heuristic(suffix) <= budget − anchor.tokens` for
as long as the strategy keeps the prefix intact — and if it drops into the
prefix, the anchor is invalidated anyway. One line of arithmetic in place of
an interface change.

Verified live on the same `verify-live` conversation:

| | anchored | pure heuristic | provider truth |
|---|---|---|---|
| codex | **131** | 151 | 131 |
| ollama | **730** | 748 | 611 |

Codex lands exactly on the reported number. Both stay on the overestimating
side, which is the side this module's contract asks for.

One thing worth noting for whoever reads the tests: the only failure during
implementation was a *test fixture* whose messages never came close to the
budget it claimed to overrun, so it asserted that truncation had cleared the
anchor when no truncation had occurred. The code was right and the test was
wrong — a reminder that a red test is a hypothesis about two things, not one.

### Two things odysseus contributed

1. **They never made this change.** `trim_for_context()` gates purely on
   their chars×0.3 heuristic; reported usage is streamed to the UI as
   telemetry and never enters a trimming decision. Even their agent log line
   labelled `prompt_tokens=` is the estimate. A large multi-provider harness
   runs in production on the heuristic alone — which demotes this from
   "known-wrong code" to "a real improvement on something that works".
2. **Usage absence is per-response, not per-provider.** Their
   `test_llm_core_usage_finish_delta.py` documents a shipped bug where usage
   riding on a non-empty finish delta was dropped, so those providers'
   accounting read zero; sibling cases cover null usage and null heartbeat
   chunks. That decided Decision A on its own: a `usageReported: false`
   config flag would encode a transient transport failure as a permanent
   provider property. Config should declare what the response *cannot* tell
   you; this is not that.

Also worth noting what not to copy: their `max_completion_tokens` routing is
a hardcoded model-name set (`o1`, `o3`, `o4`, `gpt-4.5`, `gpt-5`) — exactly
the provider-name-in-control-flow pattern the 2026-08-04 audit removed here.

### Failed predictions

- **Wrong:** that the reported-usage anchor was mechanical. Measuring it
  changed the anchor quantity, surfaced a second unrelated defect, and made
  the ordering of the work matter.
- **Wrong:** that qwen replays thinking (see above).
- **Right:** that codex's usage would turn out trustworthy despite it
  ignoring `maxTokens`, and that the two are unrelated failure modes.
- **Right:** that the risk worth probing was reasoning tokens. It was the
  probe that produced everything else.

---

## Adversarial QA pass #2 — ten defects under a green suite, 2026-08-05

An unprimed QA agent was pointed at the repo with no steer about which
files were recent or which decisions were settled, and told explicitly that
a passing suite is not evidence. It found **ten defects while 142 tests
passed and `tsc` was clean** — the second time this has happened on this
project, and a stronger result than the first, because this time the newest
and most carefully reviewed code was among the worst offenders.

All ten are fixed; the suite is now 173 tests. What follows is what
generalises, not a changelog.

### The same defect class keeps recurring: real payload measured as free

`estimateTokens` counted `thinkingSignature` and `textSignature` as zero.
Measured against codex: `thinking: 0 chars, thinkingSignature: 1146 chars,
textSignature: 92` — and the estimator scored that message at **5 tokens**.
pi-ai sends both fields back to the provider (`anthropic-messages.js:894`,
`:921`; `openai-responses-shared.js:139`).

This is the *third* instance of exactly one mistake: measure the field you
were thinking about, score the sibling field at zero. Images were the first
(fixed 2026-08-04), tool-call arguments the second, signatures the third.
**When a type is a union of block shapes, the estimator must enumerate the
union, not the cases the author had in mind.**

It also corrects 1.8. That ADR said codex "is replaying reasoning the
harness cannot see and cannot measure." Wrong: the harness could see it all
along, in a field it was not counting. The ~37 tokens/turn of unexplained
input growth had a mundane explanation the whole time.

Nuance that shaped the fix: 1238 characters of signature cost roughly 37
tokens on the wire, so charging ciphertext at chars/3 overestimates by
about an order of magnitude. Accepted anyway — it is the direction this
module's contract asks for, signatures only appear on hosted reasoning
models with very large windows, and the anchored path prices everything
before the last turn from a measured count. Recorded as tunable rather than
pretending one provider's single measurement justifies a second constant.

### `NaN` defeats every `<= 0` guard, silently and in the worst direction

One typo — `"contextWindows"` with a stray `s` in `local-providers.json` —
produced `contextWindow: undefined`, then `budget = NaN`. Both of
`ConversationManager`'s "this window is unusable" guards are written
`<= 0`, and `NaN <= 0` is `false`, so both passed. Result: 500 messages,
669k tokens, **truncation never fired**, no error anywhere, against a
server serving 4096.

That is precisely the silent-overflow failure the `contextWindow` override
was introduced to prevent (2.5) — reintroduced through the one input path
that had no validation. `model.config.json` had been validated field by
field since 1.4, with a regression test proving a typo is rejected;
`local-providers.json` fed the same machinery with a bare `JSON.parse`.

**Two lessons.** Validate every input path to a value, not the one you were
thinking about when you wrote the validator. And write numeric guards as
`Number.isFinite(x) && x > 0`, never `x > 0` — the truthiness form fails
open.

### Swallowing an error to be forgiving can destroy what it was protecting

`FileCredentialStore.readAll()` caught everything and returned `{}` as "the
normal first-run state". But `modify()` and `delete()` are whole-file
read-modify-writes built on it, so **any** unreadable file made the next
write overwrite it — one `modify()` on any provider destroyed every other
provider's credential and reported success. The file's own header comment
claims write-then-rename protects against exactly this; it protects the
write path, and the read path defeated it.

The distinction that matters is **absent vs unreadable**, not *succeeded vs
failed*. Absent and empty have nothing to lose, so `{}` is true and safe.
Unreadable may hold a live OAuth token whose recovery needs a human at a
browser, so the only safe move is to refuse.

### A check that can never fire is worse than no check

`validate-context.ts` catches duplicate tool names, with a comment
explaining that `ToolRegistry` is keyed by name so a duplicate "silently
overwrites". It did — and because `register()` was a bare `Map.set`,
`getToolDefinitions()` came out deduplicated, so the check could never see
a duplicate on the intended path. It guarded only hand-built arrays, while
the overwrite it was written to catch went uncaught at its source. The fix
belonged in `register()`, where the ambiguity originates.

**A guard placed downstream of the thing that removes the evidence is
decoration.**

### Other findings, briefly

- `getModels()` assigned the registry before registering local providers,
  so a registration failure left the broken registry cached — every later
  call succeeded with local providers silently missing, and `loadModel()`
  blamed the model config for a parse error elsewhere.
- `dispatchToolCall` copied the handler's return unchecked; `{}` yielded
  `content: undefined` with **`isError: false`** — success-shaped — that
  crashed a step later, away from the tool responsible.
- `sizing.ts` answered `sequences: 0` with "max context: Infinity", a
  negative context with "−12.28 GB, ✓ fits", and `sequences: -2` with "the
  weights alone do not fit", which is simply false. For a tool whose output
  is *advice*, a confident wrong number is worse than an error.
- `config[configKey]` truthiness matched inherited prototype members, so
  `loadModel("constructor")` — reachable from `process.argv` — reported
  `No model "undefined"`. A `"__proto__"` key set the config's prototype
  instead of an own property. Fixed with `Object.hasOwn` and a
  null-prototype config. Note `validateContext` already got this right with
  a `Set`, so two unknown-key checks in one codebase disagreed.
- `getHistory()` handed out the live array that `append()` later replaces,
  and `tools` was stored by reference despite a doc comment promising it
  was fixed for the manager's lifetime.

### On the anchor, and on my own fix being wrong twice

Both 1.8 defects were mine, written the same day and reviewed carefully:

1. `append()` could exit **over budget**. When an anchor exists, truncation
   runs against a widened budget; if that pass cuts into the anchored
   prefix the anchor is invalidated — and the kept set was never re-checked
   against the now-unwidened budget. Measured at 4013 tokens against a 3000
   budget, self-healing one turn too late, at the exact moment 1.5's
   decision 4 exists to prevent ("nothing can build up and then blow the
   window right as a call goes out").
2. The anchor gate tested `usage.input <= 0` while the value taken was
   `input + cacheRead + cacheWrite`. pi-ai normalises OpenAI usage as
   `input = max(0, prompt_tokens − cacheRead − cacheWrite)`, so a fully
   cached prefix arrives as `input: 0, cacheRead: 8000` — and the
   measurement was discarded **precisely when caching works**. The comment
   justifying it ("a non-empty request cannot cost nothing") is true of the
   sum and false of `input` alone. I wrote the sum and then guarded the
   part.

Both are the same authorial failure: a guard written against an earlier
draft of the value it guards. Neither would have been caught by more tests
of the kind I was writing, because I was testing the behaviour I intended.

### On test fixtures

Three of my new tests failed on first run, and **all three were wrong
fixtures, not wrong code**: messages that never approached the budget they
claimed to overrun, a simulated truncation that deleted the token it then
asserted had survived, a `maxContextFor` call missing a required field. A
red test is a hypothesis about two things. Worth remembering before
"fixing" the code it points at.

### What the QA agent checked and could not break

Recorded because a clean result is evidence too: `dropOldestStrategy`
against 5000 randomised tool-call histories (no orphaned results, always a
true suffix); the 2.4 sizing constants against llama.cpp's own allocation
log; the `maxContextFor` → `fitsIn` round trip; the credential store's
write serialisation; and the compat-merge claim in `openai-compatible.ts`.
The `input + cacheRead + cacheWrite` sum itself was confirmed correct
against both providers' normalisation — only the gate in front of it was
wrong.

### Still open

The Phase 2 local-provider path — `openai-compatible.ts`,
`registerLocalProviders`, `complete.ts`/retry, the `contextWindow` override
— had **no unit tests at all**, and `harness.integration.test.ts` routes
around it by calling `models.complete()` directly. `openai-compatible.ts`
now has its own test file; the retry layer and the override still do not.
That is the "headline result" of this project running untested.

---

## Prompt caching: a floor, a derivation, and a tension, 2026-08-05

Read OpenAI's prompt-caching guide against our design. Three things came
out of it, none of which required writing code.

### The zero cache fields were never a gap

`SESSION-HANDOFF.md` listed "the anchor's `cacheRead`/`cacheWrite`
arithmetic has never been exercised" as an open item, phrased as though a
capability were missing. It isn't: **caching engages only at ≥1,024
tokens**, and every conversation this repo runs measures 131 (codex) to 950
(ollama). The fields read zero because they had to.

Worth correcting rather than leaving, because "unexercised arithmetic"
invites the next person to go hunting for a bug that does not exist. An
open item should say what would change the answer — here, a prompt above
the floor.

### The anchor sum is derivable, not just defensive

The cache fields were added to the anchor on a safety argument: omitting
them would understate the context if a provider reported cached input
outside `input`, and understating is the dangerous direction. The docs turn
that into arithmetic. Cached tokens are a **subset of the prompt**, and
pi-ai normalises `input = max(0, prompt_tokens − cacheRead − cacheWrite)`.
So:

```
input + cacheRead + cacheWrite  =  prompt_tokens
```

which is exactly the quantity the anchor wants. It also confirms the QA
finding was a live defect rather than a theoretical one: gating on `input`
alone discards the measurement precisely when a prompt crosses 1,024 tokens
and starts hitting cache — the point at which the anchor matters most.

### Drop-oldest truncation is the strategy most hostile to caching

The one genuinely new consequence, now recorded in `1.5`. Caching keys on
an **identical prefix**; `dropOldestStrategy` removes from the front of the
message list. Every eviction invalidates the cached prefix past the point
where messages begin.

It survives only because of a structural accident worth naming:
`systemPrompt` and `tools` sit on the `Context` as sibling fields rather
than in `messages`, so they are untruncatable and stay byte-identical.
Providers hash roughly the first 256 tokens for routing, so routing keeps
hitting; what is lost is the cached *extent*.

This does not change the default — at our prompt sizes caching never
engages, so there is nothing to lose. It changes how a *replacement*
strategy should be judged. Summarise-and-keep-prefix is not merely "keeps
more meaning"; it is the one that keeps the cache alive.

### Where this fits a sovereignty project at all

Prompt caching is a hosted-provider optimisation, and everything from Phase
2 on is about not depending on hosted providers. But llama.cpp logged this
during the 2.4 measurements, unprompted and on by default:

```
srv load_model: prompt cache is enabled, size limit: 8192 MiB
```

Different mechanism, identical structuring rule: stable prefix, reusable
cache. Same shape as 2.3's portable lesson (GGUF↔llama.cpp,
AWQ/GPTQ↔vLLM) — **the vendor mechanism does not transfer, the ordering
principle does.**

### What was checked rather than assumed

Per `lessons.md` #2, I grepped pi-ai instead of asserting it lacked
support. It has the lot, as compat flags: `cacheControl` (Anthropic-style
markers on system prompt, last tool definition, last content block),
`promptCacheOptions` (GPT-5.6+ explicit breakpoints, which older models
*reject*), `promptCacheRetention`, and `prompt_cache_key` driven by
`sessionId`. So enabling any of it remains a config edit — no provider
names in control flow.

Two cautions recorded with it. GPT-5.6+ bills cache **writes** at 1.25×
uncached rate, so enabling explicit caching below the 1,024-token floor is
strictly a loss. And this is *platform* API documentation, while our
`openai-codex` entry uses the ChatGPT subscription endpoint — the same
surface that rejects `max_output_tokens` outright where the platform
accepts it. Probe before believing any of it applies there.

---

## 1.7 was already finished, and the docs said otherwise, 2026-08-05

Asked whether 1.7 could be addressed, I said it was unbuilt with an open
question outstanding. Both wrong, and the way they were wrong is the
lesson.

**The open question was answered on 2026-07-30.** `CLAUDE.md` said "ask the
user which project to refactor, don't guess" — but the 1.7 ADR that
supersedes it already recorded the investigation (`local-pi` has zero
direct provider calls to remove) and the decision (don't refactor it). I
read the navigation instead of the document it points at, and repeated a
retired question back to the user as if it were live.

**Four of five DoD items were ticked; the fifth was satisfied this
session.** It read "genuine cross-provider swap — waiting on a second
reachable provider, not on code." Phase 2 supplied that provider weeks
later and `verify-swap.ts codex-default local-qwen` has been passing since.
Nobody went back to tick the box, so the ADR read as incomplete.

**The generalisable point:** a checkbox whose blocker is resolved elsewhere
does not untick itself. When one document's open item depends on another
document's work, finishing the second silently invalidates the first. Worth
a grep for "waiting on" / "outstanding" / "deferred" whenever a phase
closes.

### What was actually missing: `step()`

One real gap sat underneath the paperwork. Everything needed to drive a
request → tool-call → response cycle existed after 1.6 *except the piece
that composes them*, so both verify scripts hand-rolled it inline,
hardcoded to two turns. Nobody could use the library without copying from
a test script.

Built as **one transition, not a loop**, after asking the user directly
whether the error contract could be fixed without adding an agent loop. It
can, and the line is sharper than it first looks: `step()` performs exactly
one model call, dispatches any requested tools, appends results, and
returns. Iteration is four visible lines in the caller.

**The distinction is who decides when to stop.** An agent loop decides;
this does not. Stopping rule, turn cap and failure policy stay in
application code rather than becoming library defaults nobody reads — which
is what 1.7's own "the harness's value is subtraction" argument requires.
It also cannot reach for anything it was not handed: dispatch goes through
the caller's registry, and the harness ships no built-in tools.

### The error contract had been fiction in three files

`types.ts`, `harness-result.ts` and `validate-context.ts` all describe one
rule: a failure comes back as a `HarnessResult` with `stopReason: "error"`,
so callers check one place. `validate-context.ts` even names "the
orchestration loop" as the component that converts the throw.

No such component existed. `validateContext` threw uncaught in both
scripts, and `errorResult` had no caller outside its own test — the QA pass
flagged it. `step()` is now that component, and the division of labour is
deliberate: `validateContext` still throws, because a caller must not be
able to proceed past it by accident, and `step()` is the single place that
catches. A property test drives four failure shapes (Error, bare string,
`null`, rejected promise) and asserts none escape.

### Fixture mistakes, again

Two of the new tests failed first: I guessed `createModels({ providers })`
without checking the existing working usage two files away, and assumed the
faux provider returns a default response when it requires a queued script
(`setResponses`). Both are `lessons.md` #5 — and the second turned out
useful, because switching to real queued responses removed most of the
hand-rolled stubs and exercised the genuine provider path instead.

### Doc drift, at scale

Closing 1.7 meant `CLAUDE.md` still opened with **"this repo is currently
100% design, zero code"** — untrue since 2026-08-03 — plus a
"verification requires real API keys, none of this has been executed"
section and a note to go pick a code location. The file loaded into every
session was describing a repo that stopped existing weeks ago.

`lessons.md` #11 said a number written twice will disagree with itself.
The stronger version: **a status written once, at the top of the file
everyone reads first, will be believed long after it stops being true.**

---

## The docs described a library; the goal was a product, 2026-08-05

The most consequential correction on this project, and it took asking the
user what they were actually building. Their words:

> a sovereign harness layer like Claude is, which is fully built by us and
> has the model agnostic capability — imagine the Claude desktop app but all
> the data is retained on enterprise servers, not in foreign databases.

Every design doc here describes **a component** — "an abstraction layer that
swaps between hosted APIs and self-hosted models." 1.7 went further and
argued the harness's value was *subtraction*, explicitly declining an agent
loop or a tool suite. All of it internally consistent, all of it building
the engine and calling it the car.

Nothing in the code was wrong. The *frame* was, and a wrong frame is more
expensive than a wrong function, because every decision underneath it
inherits the error. 1.7's "don't build an agent loop" was correct reasoning
from a false premise.

**Worth generalising:** the docs were never checked against the goal, only
against each other. Internal consistency is not evidence of correctness —
it is exactly what a well-maintained misunderstanding looks like.

### The licence survey is worth keeping regardless

Researched forking an existing workspace before the build-from-scratch
decision:

| project | licence | white-label to a client? |
|---|---|---|
| LibreChat | MIT | yes |
| AnythingLLM | MIT | yes |
| Jan | Apache-2.0 (GitHub reports NOASSERTION; the file is plain Apache) | yes |
| Open WebUI | modified BSD-3 | **no** — branding must remain in any deployment |
| LobeChat | Apache + conditions | **no** — commercial licence to distribute a derivative |
| Dify | Apache + conditions | **no** — logo cannot be removed from the frontend |
| odysseus | AGPL-3.0 | source rights pass to the client |

**The three largest by stars — Dify 151k, Open WebUI 148k, odysseus 85k —
are all unusable for white-labelled client delivery.** Popularity and
licence suitability are unrelated, and the licence is the first thing to
check, not the last.

Also measured: AnythingLLM ships **thirty-plus** hand-written provider
adapters (cerebras, groq, novita, nvidiaNim, koboldCPP …). That is the
pattern this project has spent weeks proving generates silent failure —
breadth by adapter count is breadth by places to be quietly wrong.

### The decision, and the reasoning that was rejected

I recommended forking LibreChat: MIT, TypeScript, MERN-shaped, and it
already carries audit logging (`packages/api/src/admin/auditLog.ts`), RBAC,
MCP, file upload and pgvector — two of the roadmap's later phases already
built.

**Rejected by the user, and the reasoning holds:** the differentiator has to
be ours. A fork means either living with someone else's model layer — the
exact layer this project exists to be better at — or replacing it and
diverging from upstream forever.

Build from scratch. Other projects become reference material: take the
*feature* and the *fix for a specific bug*, never the code or its structure.
Prefer MIT/Apache for close reading; for AGPL take the observation only.
Precedent already set — the odysseus usage-delta finding in 1.8 was a fact
about provider behaviour, cited, with no code moved.

### The differentiator, restated

"Any LLM without flakiness" is not a feature. It is a conformance program,
and this project already holds its specification: the catalogue of ways
providers lie, every entry measured. The claim to be able to make is not
"we support many models" but **"these models are verified, on this date,
against these checks."**

Recorded in `ADR-003-sovereign-workspace-product.md` and
`product-roadmap.md`.

---

## Designing Phase A: what pi-ai already does, 2026-08-05

Checked `pi-ai` before designing the agent runtime rather than after, per
`lessons.md` #2 and the standing rule that this project's ADRs have been
wrong about `pi-ai` five times. Four findings, each of which changed the
design.

**`complete()` is literally `stream().result()`** (`dist/models.js:270`).
That collapses the biggest structural question in Phase A. A streaming path
and a non-streaming path would have been two routes through identical
provider behaviour — and both adversarial QA passes found defects
concentrated exactly where two paths were meant to behave the same. `step()`
moves to `stream()` with an optional event sink; there is no `streamStep()`
twin.

**`AssistantMessageEventStream` is async-iterable *and* has `.result()`**
(`utils/event-stream.d.ts`). One call gives streaming events for the UI and
the final `AssistantMessage` for persistence. No buffering layer needed.

**The event protocol is already rich** (`types.d.ts:365`) — separate
start/delta/end triples for text, thinking and tool calls, every event
carrying `partial: AssistantMessage`. Our runtime protocol wraps it with
run/turn/tool events rather than replacing it.

**There is no MCP client.** The only `mcp` in the whole package is an OAuth
*scope string* — `user:mcp_servers` in Anthropic's auth flow. Worth
recording precisely because a careless `grep -l` reports four matching
files and reads like support. That is the shape of the mistake in
`lessons.md` #2, caught this time by looking at what actually matched.

### The design decision I expect to be glad about

Approval **suspends** the run rather than blocking it: `run()` ends with
`reason: "needsApproval"` and the pending calls visible, and the caller
resumes with decisions. Stateless per HTTP request, survives a dropped
connection, and makes the approval a persisted record rather than an
in-memory promise.

It costs almost nothing because `step()` already has that shape — when
tools are requested and no registry can run them, it returns `done: true`
with `toolCalls` populated rather than swallowing them. Approval-required
is the same case with a different reason. A design property built for one
reason turning out to be exactly what a later requirement needs is rare
enough to note.

### The security principle Phase A turns on

**The model proposes, the policy disposes** — the model may request any
tool; whether it runs is decided by code and configuration the model cannot
influence.

Its corollary is the part that is easy to get wrong: **tool results are
untrusted input.** A document the agent reads, a page it fetches, or an MCP
server's own tool *description* can carry text aimed at the model. So
nothing in a tool result may widen permissions or approve an action.

That last case is the sharp one. MCP servers supply their own tool names and
descriptions, which go straight into the prompt — untrusted text in a
privileged position. Flagged `[UNVERIFIED]` in A.1 and needs design before
MCP ships rather than after.

### Something the QA pass found that Phase A must fix

`dispatchToolCall` has **no timeout**. A handler that never resolves wedges
`Promise.allSettled` and the turn forever. Harmless while every tool is a
test stub returning a fixed string; not harmless once tools do shell and
network I/O on a client's server.

---

## Designing Phase B: persistence forces a change to 1.5, 2026-08-05

Two findings from reading our own code before designing the storage layer.

### Truncation currently deletes, and a product cannot do that

**[VERIFIED]** `ConversationManager.append()` ends with
`this.context.messages = kept`. Messages evicted to fit the context window
are gone from the object.

Correct for a library where the caller owned the transcript. Wrong for a
product: a user scrolling back must see the whole conversation while the
model sees a window, and today those are the same array.

So B.1 revises 1.5's decision 4 — **the stored conversation is complete and
the model's context is a projection of it.** The guarantee survives (what
reaches the provider is still always within budget); it is produced by
projecting rather than discarding. Recorded as a revision rather than a
quiet change, per the standing rule about not re-deciding ADRs silently.

Worth noting *why* the original was reasonable: at the time, the transcript
and the context genuinely were the same thing, because there was no storage
and no user. The decision was right for the system that existed. It became
wrong when the product framing changed (ADR-003) — which is the same class
of problem as the docs describing a library, just expressed in code.

### The 1.8 anchor needs no table of its own

**[VERIFIED]** inventory of `ConversationManager`'s state: only
`context.messages` is genuinely persistent. `systemPrompt`, `tools`,
`maxToolResultChars` and `strategy` are configuration; `budget`,
`overheadTokens` and `messageBudget` are arithmetic over model config.

And the anchor is *derivable*. It is `{ tokens, messageIndex }` where
`tokens = input + cacheRead + cacheWrite` on an assistant message — so if
usage is stored per message, which audit and spend control need anyway, the
anchor rebuilds on load from the most recent assistant message with usable
usage.

With the same condition 1.8 already applies to truncation: rebuild only if
the whole anchored prefix is loaded. A windowed load that starts after the
anchored message must report `estimated`, because the anchor's count covers
messages that are not in memory. The `BudgetSource` field added in 1.8
already expresses this — no new API, only the discipline to use it.

A design property built for one reason turning out to fit a later
requirement exactly, for the second time this week (the first was `step()`
already having the shape that approval-suspension needed). Both times the
cause was the same: the earlier decision modelled *what was actually true*
rather than what was convenient.

### The residency leak that is invisible in a schema

The sovereignty claim is only as strong as the leakiest place data touches,
and most of that risk is not in the chat table — it is in embeddings,
search indexes, logs, caches, temp files and telemetry.

The one most easily missed: **the embedding model has to be local too.** A
deployment storing embeddings in the client's pgvector while calling a
hosted embedding API has shipped every document out of the building. The
vector is local; the document was not. It is invisible in the schema
because the leak is in a code path, not a table.

Hence a residency *inventory* as a deliverable rather than a paragraph:
every place client data lands, enumerated, each one inside the boundary.
Anything not on the list is a leak nobody has thought about yet.

### Erasure versus audit, and a familiar trap

GDPR-style erasure and audit immutability genuinely conflict. Resolved by
having audit records reference identifiers and metadata, never content:
erasure destroys what was said, the audit trail retains that something was
said and by whom. It has to be designed in from the start, because an audit
log that copied prompt text cannot later be made erasable.

Related, and the same shape as `lessons.md` #6: a deleted message still
retrievable by semantic search is a compliance failure that stays invisible
until an auditor goes looking. So deletion spans every derived store and is
verified **by searching for the erased content** — from the retrieval side,
not the storage side. Checking the table you just deleted from proves
nothing.

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
  provider. Local Qwen passed on 2026-08-06; current cloud reruns are blocked
  on provider authentication.
- `scripts/verify-swap.ts` — 1.4's swap DoD: same prompt through two config
  keys and a fail-closed structural diff. A current rerun needs a second
  authenticated provider.
- `phase1/adrs/1.8-token-budgeting.md` — token budgeting: the two defects
  above, why the `prev.in + prev.out` anchor was measured and rejected, and
  Decisions A (per-response stale anchor, not a config flag) and B (codex
  usage verified, reasoning tokens included).
- `phase2/adrs/2.4-gpu-sizing-math.md` — 2.4: the memory formula, measured
  across two model families, with the fit boundary and concurrency term.
- `src/sizing.ts` + `src/sizing.test.ts` — the formula as code, with every
  measurement pinned as a regression fixture so the numbers cannot rot.
- `scripts/size-model.ts` — sizing CLI. Reads geometry from a live Ollama,
  or takes it as flags for hardware nobody here owns.
- `1.7-integration-and-comparison.md` — 1.7 reframed: `local-pi` has no
  provider code to remove and sits above this harness, so the refactor was
  retired in favour of the swap proof plus a comparison of where each layer
  fits.

---

## Ownership audit: the foundation was strong, but four product assumptions were unsafe, 2026-08-06

The project changed ownership and was audited as a system rather than as a
sequence of completed tasks. The test suite was green, but several public
claims were wider than the checks underneath them.

### A dependency type cannot be the permanent product schema

Phase 1 deliberately adopted `pi-ai`'s message types unchanged. That was a
good library decision and a dangerous persistence decision: B.1 proposed
storing those blocks verbatim, which would let a package update redefine
historical data and the public API together. B.1 now stores a versioned
product envelope and treats provider-specific content as an extension. The
runtime can still use `pi-ai`; the database no longer belongs to it.

### Durability cannot silently degrade when completeness is a promise

A.1 said a database outage should degrade recording without killing the
conversation. B.1 promised complete history and audit. With no durable
buffer those cannot both be true. The revised design keeps the runtime free
of database handles but makes the server journal transitions before
acknowledging them. An outage means encrypted in-boundary spool or a
suspended run, never successful work with missing history.

### Cross-store erasure is a saga, not one transaction

The earlier B.1 text required one transaction across Postgres, disk/object
storage, pgvector and search. No such transaction exists. The replacement is
a tombstone plus transactional outbox, idempotent deletion workers,
reconciliation, and retrieval-side proof. The user-visible guarantee is
convergence with visible failure, not fictional atomicity.

### One event protocol still needs different audience projections

`tool_start.arguments` is user content. Sending the same serialized payload
unchanged to UI, persistence, audit and logs would violate B.1's own rule
that audit records contain metadata only. A.1 now defines schema-driven
projections: authorized UI/persistence may carry content; audit and logs may
not.

### Concrete runtime defects fixed in the same pass

- Cancellation reached retry sleeps but not the active provider request.
- Provider/transport errors were appended as assistant conversation turns.
- `getContext()` exposed mutable internal state, allowing callers to bypass
  token budgets; negative reserves widened the window.
- The live verifier could exit successfully without exercising a tool, and
  the swap verifier could pass two identically malformed response types.
- Tracked local-provider JSON allowed inline API keys and under-validated
  optional fields.
- A secret terminal prompt echoed long-lived values.
- Any local-provider config read error was treated as "file absent".

Each code defect now has a regression test where it can be tested without a
live provider. Live conformance remains a separate, dated proof.

---

## Live performance and deployment conformance, 2026-08-06

`local-qwen` completed the real two-turn path twice on the running default
Ollama service: `toolUse` with one successful `get_weather` result, followed
by a non-empty final answer. Runtime `AssistantMessage` validation, usage
reporting, thinking blocks, and anchored budgeting all passed.

The first observed 4096-context run took 57,170 ms end to end; the warm run
took 19,902 ms. These are measurements, not an SLO pass: the product has no
latency threshold yet.

The deployment check found that the service was actually serving 4096 while
the repository budgeted for 8192. An isolated instance started with
`OLLAMA_CONTEXT_LENGTH=8192` then passed the same tool conformance twice, in
29,655 ms and 43,880 ms. Ollama reported 3,777,935,441 bytes resident and
100% GPU execution. Generation ranged from 15.71 to 19.31 tokens per second
across those turns; the spread is exactly why a dated sample is evidence,
not yet a performance SLO.

Running duplicate 4096 and 8192 Qwen instances simultaneously exhausted
Metal memory on this 8 GB M3 host. The 8192 instance passed after the
duplicate runner was unloaded, so 8192 is viable for one resident Qwen but
not for two copies. This operational constraint now belongs in deployment
capacity policy rather than remaining an assumption in sizing math.

The verifier now queries Ollama `/api/ps` and fails closed when served and
configured contexts differ. Full dated evidence is stored in
`conformance/2026-08-06-local-qwen.json`.

After fresh browser OAuth, `openai-codex/gpt-5.6-luna` also passed the live
tool round trip in 3,782 ms. The current cross-provider swap then passed:
identical calling code and prompt reached Codex and Qwen in 1,963 ms and
41,231 ms respectively, with every required runtime field valid. The only
content-shape difference was expected and explicit: Qwen returned
`text|thinking`, while Codex returned `text`. Codex still warns that its
ChatGPT-backed API ignores `maxTokens`, so structural conformance does not
remove that spend-control limitation.

---

## A0.1: the run-event contract is now executable, 2026-08-10

The first post-audit implementation slice added a product-owned version-1
`RunEvent` union without adding a run loop or transport. Runtime parsing
rejects unknown versions, undeclared fields, invalid JSON values, weakened
sensitivity labels, and content events falsely labelled for audit/log use.
Complete-run validation enforces stable identity, strictly increasing unique
sequences, non-decreasing turns, one terminal event, and no event after a
terminal outcome.

Audience projection is schema-driven. UI and persistence receive owned
content snapshots. Audit receives selected metadata plus deterministic
content hashes and sizes where evidence requires them. Operational records
receive metadata and sizes but no content hashes. Tool arguments/results,
message content, free-form decision/failure details, and extension payloads
cannot reach audit or operational projections through object spreading.

Streaming deltas are explicitly ephemeral: full delta content may target
only the live UI, operational telemetry may receive its byte count, and both
persistence and audit projections omit the event. Completed messages remain
the canonical record. A0.3 subsequently replaced the temporary
`message.completed.content` JSON value with the versioned product message
envelope described below.

---

## A0.2: transport roles are explicit before runtime wiring, 2026-08-10

The transport contract now exposes one ordered, typed in-process
`AsyncIterable<RunEvent>`. Concurrent publishers are serialized, event/run
invariants are checked at publication, and the event is snapshotted at the
call boundary so later caller or sink mutation cannot change another
consumer's view.

Two sink roles are deliberately different. A required sink is awaited before
live delivery and a rejection fails publication without exposing the event;
this is the future Phase B journal acknowledgement boundary. Optional
observers use isolated bounded queues, report overflow or sink failure, and
never block model/tool execution. The implementation therefore does not
encode telemetry as durability or allow a slow metric exporter to suspend a
run.

Reconnect checkpoints bind `runId`, `eventId`, and `sequence` and reject
missing, inconsistent, cross-run, or out-of-order journal slices. The Phase C
SSE mapping uses the stable event id as the SSE `id`, retains the canonical
JSON event as `data`, and rejects line-break injection in control fields. It
is a pure codec only: authenticated HTTP commands/approvals, server wiring,
Postgres outbox delivery, and MCP registration remain deferred rather than
being mocked in A0.2.

---

## A0.3: durable messages no longer inherit the runtime type, 2026-08-10

The version-1 product message envelope now represents user text/images,
assistant text/thinking/tool calls, and tool results without storing a
`pi-ai` type directly. The mapper covers the installed 0.82.1 union's opaque
text, thinking, and tool-call signatures; redacted thinking; tool-result
details and deferred tool names; response model/id and diagnostics; reasoning
and one-hour cache-write token breakdowns; and all USD cost fields. Optional
runtime fields are copied when present and then validated, rather than using
truthiness in a way that could silently turn malformed empty values into
absence.

Unknown provider data has one explicit content-bearing extension location.
Nothing captures raw payloads by default. UI and persistence projections may
receive an authorized copy; audit fingerprints it together with message
content, and operational projection retains only sizes. Regression canaries
prove provider-extension content cannot enter audit or logs.

`stopReason: error` and `aborted` are not messages. Their mapper returns
validated failed/cancelled run metadata, including provider identity and any
reported usage/cost, while discarding partial or synthetic assistant content.
The completed-message mapper rejects those outcomes so callers cannot persist
them accidentally as conversation history.

The checked-in version-1 JSON fixture is decoded without reference to the
runtime message type, alongside a deliberately incompatible simulated future
runtime shape. This proves the compatibility boundary that matters here: a
dependency type change does not redefine historical JSON. It does not yet
prove database migration or reload behavior; those remain Phase B gates.

---

## A0-P.1: complete history and provider context are separate inputs, 2026-08-10

The context compiler now accepts an immutable complete-history input and
returns one validated, bounded provider context. That boundary exists before
durable history does: `ConversationManager` delegates outbound projection to
the compiler but still applies its existing in-memory truncation on append.
Phase B remains responsible for making the input genuinely complete across
process restarts and long conversations.

Prompt layout is deterministic. Independently versioned system instructions
and tool definitions are sorted by stable identifiers; a single legacy system
prompt keeps its exact wire shape. The result reports allocations for fixed
system/tool overhead, history, retrieved context, current input, unused input,
and output reserve. If fixed content, the current input, or the newest atomic
tool-call/result group cannot fit, compilation fails rather than silently
overrunning the configured window or breaking tool linkage.

Retrieved material and tool results are wrapped as explicitly untrusted data
before provider delivery. This is a model-facing warning, not an authorization
boundary: deterministic policy still owns permissions and approvals. The
compiler never mutates the stored/source messages while adding those markers.

The prompt fingerprint contains layout/template/instruction versions and
SHA-256 hashes only. Regression canaries cover system, history, retrieval, and
current-input content so neither client text nor secret values can enter the
fingerprint object. Tool reordering produces the same provider context and
fingerprint; changing one content byte changes the digest. These deterministic
properties are the prerequisite for A0-P.2's live cache probes, not proof that
either provider caches the prompt.

---

## A0-P.2: Codex reports cache truth; Qwen does not, 2026-08-10

`scripts/verify-cache.ts` now drives nine content-safe probes per target: one
cold request, five identical-prefix/changing-suffix requests, a one-byte
system-prompt change, source tool reordering, and a forced drop-oldest
projection. The machine report records reconstructed provider prompt tokens,
cache fields, cost, conformance, retry count, and explicit streaming timing
semantics. It stores hashes and structural issue codes, never prompts,
responses, or provider error text.

Codex gave direct cache evidence. Its prompt measured 5,122 tokens. Four of
five warm requests reported 4,608 cache-read tokens; one reported zero. Tool
source order was reversed, the compiler produced the same provider layout,
and the live request still reported 4,608 cache-read tokens. The one-byte
system change reported zero, and the large truncated projection retained a
4,608-token cache read. Cache writes remained zero. Those conclusions come
from usage fields, not from latency.

Qwen measured a 7,906-token prompt against a live `/api/ps` context of 8,192.
All nine responses were structurally valid, and drop-oldest removed seven
source messages while keeping the stable system/tool prefix. Every cache field
was zero. Because pi-ai normalizes an absent field to zero, that cannot
distinguish unsupported, unreported, disabled, or a real miss. The cold prompt
phase was about 67 seconds and warm phases about 1–5 seconds; the byte-changed
prompt took about 108 seconds. Those timings are observations only. Qwen cache
retention and invalidation remain explicitly unverified.

### The probe found a runtime defect before it found cache evidence

The first Qwen attempts showed only ~193 input tokens no matter how large the
system prompt became. The self-hosted provider inherited hosted OpenAI's
`supportsDeveloperRole: true`; pi-ai therefore serialized the prompt as a
`developer` message, which Ollama accepted but did not evaluate. That was a
silent system-prompt loss, not a cache miss. Self-hosted compatibility now
defaults to `supportsDeveloperRole: false`, using the portable `system` role,
while an explicit provider override can opt back in. After the fix, the same
probe measured 7,906 input tokens. A regression test locks the default and the
override.

Evidence is in `conformance/2026-08-10-cache-codex.json` and
`conformance/2026-08-10-cache-qwen.json`. The earlier failed sandbox and
probe-design attempts were superseded rather than presented as provider
conformance.

---

## A0-P.3: prefix preservation improves retained facts, but not enough to replace the baseline, 2026-08-10

The second strategy is deterministic prefix-preserving compaction, not
generated summarization. It treats every span crossed by a tool-call/result
link as one atomic unit, reserves a bounded old prefix, retains the newest
suffix, and inserts one versioned omission manifest between them. The manifest
stores the source indexes, source message count, and SHA-256 source hash. It
contains no omitted message content, explicitly asserts no omitted facts, and
declares `summaryGenerated: false` and `rebuildable: true`. This avoids turning
model-generated prose into invisible historical truth while still making the
projection gap explicit and auditable.

The fixed corpus measures exact fact availability in the provider projection,
not subjective answer grading. After an appended turn, drop-oldest retained
two of six selected early/middle/recent facts; the candidate retained four.
The common stable prefix increased from an estimated 620 tokens (system/tools
only) to 1,220 (system/tools plus old source messages). Both strategies passed
budget, source-immutability, response-shape, and tool-integrity gates on Codex
and Qwen. Qwen `/api/ps` independently confirmed the configured 8,192-token
served context.

That improvement did not satisfy the selection rule. Both providers reported
zero cache-read/write fields in this two-call append comparison, so the
candidate's larger estimated cacheable prefix is not provider cache proof.
Codex cost was essentially unchanged (candidate/baseline 0.979), but candidate
aggregate prompt latency was 2.165x baseline; Qwen prompt latency was 1.240x
and local USD cost remained zero. The rule required at least one observed
provider cache gain, no cache regression, cost within 1.25x, and prompt latency
within 2x. Therefore drop-oldest remains the default and the candidate stays
available for future evaluation rather than being silently promoted.

Machine-readable evidence is in
`conformance/2026-08-10-truncation.json`. The report stores fingerprints,
counts, usage, cost, timing, and structural issue codes, never model response
content or provider error text.

---

## A0-M.1: a declaration is not a live capability, 2026-08-11

The first model-control slice makes the distinction this project has already
learned through failures executable: configured metadata says what a
deployment is intended to provide; a dated live probe says what it was
actually observed providing. They now occupy separate sections of a
product-owned version-1 capability record and carry different provenance
kinds, so provider metadata cannot be relabelled as verification.

The record covers provider/model identity (including optional digest and
quantization), API/transport, declared and served context, output-limit
behavior, tool/image/thinking/structured-output/streaming support,
usage/cache reporting, health, readiness, evidence source, and verification
time. Unknown support remains a first-class value rather than being coerced
to false or inferred from latency. This is particularly important for Qwen
cache reporting: the existing zero fields remain `unknown`, not proof of no
cache.

`assessModelRoute()` is deliberately a fail-closed gate rather than an
automatic selector. Missing observations are `missing`; expired observations
are `stale`; future-dated evidence is rejected as stale clock/evidence state;
unhealthy, unready, unsupported/unknown required capabilities, an unhonored
output limit, or insufficient served context all produce explicit reason
codes and `routable: false`. Tests include the negative control so a freshness
check that quietly does nothing cannot pass.

The existing `loadModel(configKey)` path remains unchanged. It is an explicit
caller selection, not capability-based routing, and silently making every
current config unroutable before capability artifacts exist would conflate
the record contract with A0-M.2 deployment admission. Live runner inspection,
memory/headroom policy, load state, concurrency limits, and controller wiring
were subsequently implemented in A0-M.2 below.

---

## A0-M.2: admission needs runtime memory truth, not the nearest host metric, 2026-08-11

The local control plane now serializes admission and model-load decisions,
which prevents two concurrent cold requests from loading the same model
twice. It inspects the runtime before and after loading, applies the A0-M.1
capability/freshness gate, sizes at the configured maximum sequence count,
reserves deployment headroom in addition to llama.cpp's measured 1 GiB
reserve, and enforces resident-model and active-sequence limits. Capacity
pressure is explicit: policy chooses a rejected result or a caller-owned
queued result; the controller does not hide an unbounded queue.

The first live attempt produced the important finding. `node:os.freemem`
reported only 187,351,040 bytes free on this Mac while Ollama's Metal
discovery, in the same minute, reported 5.3 GiB available. The former excludes
reclaimable unified memory and is not the quantity llama.cpp uses for model
admission. The gate correctly rejected the load, but a permanently false
negative is still a broken control plane. The Ollama adapter therefore has no
implicit memory authority: deployments must inject a current measurement and
name its source. Missing authority becomes degraded rather than guessed.

With the current 5.3 GiB Metal-available measurement injected, the live proof
started from no resident model, described the pulled Qwen artifact through
`/api/show` and `/api/tags`, and loaded it through `/api/generate` with
`num_ctx: 8192`. The existing sizing formula predicted 3,777,642,091 bytes;
`/api/ps` observed 3,777,935,441 bytes, a 293,350-byte difference (0.008%),
with `size_vram == size` and the full 8,192 context served. One sequence was
admitted and the controller lease was released. Evidence is content-safe at
`conformance/2026-08-11-admission.json`.

The controller exposes cold, loading, ready, busy, and degraded states.
Malformed runtime data, context mismatch, duplicate identity, load failure,
missing post-load evidence, stale capability evidence, and partial accelerator
residency all fail closed. Process-local leases are intentionally not a
distributed concurrency primitive; Phase C/B deployment ownership must place
one authoritative controller per runtime or persist/coordinate leases before
multi-process serving.

---

## A0-M.3: a baseline can pass while a deployment profile fails, 2026-08-11

`scripts/verify-performance.ts` now runs one excluded warm-up followed by 30
measured warm tool round trips for one configured deployment profile. The
fixed workload makes a required weather-tool call and a tool-disabled final
answer, requests at most 512 tokens per provider call, and records when the
deployment does not honor that request. Every sample retains queue, first
event, prompt phase, generation phase, provider, tool-dispatch, and complete
round-trip timing; usage-derived prompt/generation throughput; retries; and
structural conformance. Model load is a separate pre-warm measurement.

The Qwen/Ollama profile passed all 30 samples at served context 8,192. Full
tool round trip was 52.113 s p50 and 83.279 s p95; first event was 1.988 s
p50 and 16.134 s p95; prompt throughput was 77.120 tokens/s p50 and 141.481
p95; generation throughput was 12.074 tokens/s p50 and 15.321 p95. Provider
time was 51.771 s p50 and 82.478 s p95. The fresh admission/preload observation
measured model load separately at 19.155 s. Sequential queue time was near
zero; this says nothing about contended queue behavior. Two provider retries
occurred across the 30 samples.

Model load has its own 30-sample distribution rather than borrowing the one
fresh-service observation. Every sample first unloaded Qwen and verified it
absent from `/api/ps`, then timed `/api/generate` preload and rechecked context
and accelerator residency. With the Ollama process and OS file cache warm,
30/30 loads passed at 1.932 s p50 and 3.007 s p95. The excluded first load
after service start was 15.687 s. These are deliberately different profiles:
warm-process cold model load is not a machine/service cold start.

The finalized Codex profile failed closed at 27/30 conformant, with 40 total
retries. Its conformant population measured 11.687 s p50 and 26.200 s p95
full tool round trip; 4.681/5.606 s first event; 21.019/23.529 tokens/s prompt
throughput; and 11.687/26.200 s provider time. The three failures remain in
the artifact and in the 90% conformance rate but do not inject zero values
into performance percentiles. Hosted model load is explicitly not applicable,
and Codex's declared unbounded output behavior is recorded as
`maxTokensHonored: false`.

Generation throughput is an end-to-end stream-event estimate, not a provider
kernel metric. Codex sometimes delivered the terminal output only a few
milliseconds after the first visible output event, producing implausibly high
derived rates (701.684 tokens/s p95 and 7,724 max). Those values describe the
observable event boundary and must not become a generation SLO. A provider-
internal throughput claim requires provider timing telemetry instead.

The first Codex attempt is preserved at
`conformance/2026-08-11-performance-codex.json`; it used the earlier synthetic
prompt and also failed (24/30). Its raw samples were not changed when an
aggregation defect was found: only the summary was recomputed so failed
zero-valued samples no longer contaminated percentiles. The finalized common
workload is in `conformance/2026-08-11-performance-codex-final.json`; Qwen is
in `conformance/2026-08-11-performance-qwen.json`, with its separate load
distribution in `conformance/2026-08-11-model-load-qwen.json`.

This completes the measurement process, not an SLO decision. All final artifacts
have `thresholds: null` and `thresholdStatus: not-established`. Thirty warm
samples are enough to expose the distributions and current conformance risk;
they are not authorization to invent production targets without an actual
workload, contention profile, and service objective.

---

## A1.1: provider attempt terminals are not run terminals, 2026-08-11

`step()` now uses `Models.stream()` as its only model path and returns the
completed message from that same stream's `.result()`. Its optional `onEvent`
sink receives pi-ai's raw `AssistantMessageEvent` sequence in order and is
awaited before successful output can enter conversation history. A failed sink
therefore fails closed rather than acknowledging an output whose event record
was not accepted. Each sink delivery is an owned snapshot: the terminal event
and `.result()` share the provider's message object, so forwarding that object
directly would let a sink mutate the response before validation and append.
Successful completed messages also cross an explicit runtime shape check
before append; provider `error` and `aborted` messages are terminal
operational state and are never appended as assistant content.

The existing bounded retry policy creates an important protocol distinction.
A transient attempt can emit `start` then `error`, after which a recovered
attempt emits another `start` then `done`. Those are truthful provider-attempt
events, but they cannot each become a canonical run terminal: the A0 run
contract permits exactly one terminal event. A1.2 must preserve attempt
visibility while mapping only the final logical outcome to `run.completed`,
`run.failed`, or `run.cancelled`. A deterministic regression fixes this
boundary by requiring `start, error, start, done` while appending only the
recovered final message.

---

## A1.2: the journal boundary is part of control flow, 2026-08-12

`run()` now wraps the streaming `step()` with required positive `maxTurns`, a
finite absolute deadline, stable conversation/causation identity, aggregate
usage and provider latency, and an acknowledged canonical `RunEvent` sink.
Raw retry attempts contribute only ephemeral text/thinking deltas. A validated
successful runtime message becomes one versioned `message.completed`; tool
requests, actual starts, and actual completions cross the same acknowledgement
boundary; only the final logical result becomes `run.completed`, `run.failed`,
or `run.cancelled`. Each `turn.completed` carries both provider usage and the
current anchored/estimated context budget. A direct integration test publishes the generated sequence
through `RunEventTransport` and revalidates it as a complete run.

Approval suspension exposed a mismatch between two already-decided contracts.
The A1 ADR required `reason: needsApproval`, while A0's `run.completed` payload
validator allowed only `stop|maxTurns`. Since these remediation changes are
still one uncommitted pre-release stack, version 1 was corrected to include
`needsApproval` and a runtime validation test locks it. A tool request with no
execution gateway now ends with that reason and returns an owned snapshot of
the pending calls; it is not mislabeled as provider failure.

Required-sink failure is the exceptional terminal case. If the acknowledgement
boundary rejects, including by rejecting with `undefined`, the runtime aborts
active work and returns `persistenceUnavailable`. It cannot truthfully emit a
terminal event to the same failed sink, so it emits nothing further rather
than fabricating durability. Every publishable run still has exactly one
terminal event. A rejection at `message.completed` is tested to leave the
assistant turn out of in-memory history.

Cancellation now reaches both halves of a turn. The combined caller/deadline
signal is forwarded into the active provider stream and into an optional tool
execution context. Dispatch races each handler against the signal, which
bounds the runtime even if a handler ignores cancellation; only a cooperative
handler can guarantee its underlying external operation stops. Lifecycle sink
failure also aborts the shared signal so parallel tool work cannot keep the run
wedged. Per-tool timeout, output, concurrency, and confinement enforcement
remain A2.2 work; capability decisions are now implemented in A2.1 below.

---

## A2.1: decide the complete batch before executing any sibling, 2026-08-12

A capability decision cannot safely be bolted onto each parallel handler at
the moment it starts. If one model turn requests an allowed read and an
approval-required write, independently dispatching both lets the read cross
the side-effect boundary before the runtime knows the batch must suspend.
`dispatchToolCalls()` now has a two-phase boundary: find and schema-normalize
every registered call, evaluate and acknowledge every capability decision in
request order, then start handlers only when no call requires approval. A
mixed allow/approval regression proves that neither sibling executes.

Every tool registration now carries a validated, snapshotted control
declaration: one or more stable capabilities, risk, timeout, output limit,
concurrency cost, side-effect class, and idempotency strategy. The last three
execution limits are declarations in A2.1, not claimed enforcement; A2.2 is
still responsible for per-tool timers, output truncation/rejection,
concurrency accounting, workspace confinement, and protocol-specific shell
and HTTP controls.

The policy itself is data rather than an authorization callback that receives
arbitrary runtime state. Its input shape contains deployment, authenticated
role, workspace, the registered tool controls, and schema-normalized JSON
arguments. Unknown fields are rejected, leaving conversation text, model
output, and tool results no field through which to grant permission. Missing
policy/context, no matching rule, and equally specific conflicting rules deny
with stable codes. Multi-capability tools combine conservatively: any deny
wins, then approval, and only an all-allow decision executes.

The canonical sequence is now `tool.requested` → `tool.decision` → optionally
`tool.started` → optionally `tool.completed`. A denial never starts the
handler and becomes an error result the model can react to. Approval emits no
fabricated completion and ends the bounded run as `needsApproval`, with the
pending call preserved and no tool result appended. The decision event carries
both the governing capability and the sorted complete capability declaration,
so audit projection does not have to infer authorization from a tool name or
redacted detail.

---

## A2.2: a timeout must not release capacity while work still runs, 2026-08-12

The dispatcher now enforces the controls A2.1 only declared. Each allowed call
gets the earlier of its registered timeout and the enclosing run deadline, an
owned abort signal, a pre-exposure output-size gate, and a lease from one
shared global/per-capability capacity controller. Capacity pressure rejects
explicitly rather than entering a hidden unbounded queue.

The sharp concurrency case is an uncooperative timeout. Returning an error and
immediately releasing the lease would make the counter say the slot is free
while the original handler can still be writing or issuing network requests.
The runtime response is therefore bounded by the timer, but the lease is held
until the handler promise actually settles. Only handler cooperation can stop
the underlying side effect; the accounting does not pretend otherwise.

Caller-key idempotency is supplied by trusted application state indexed by the
tool-call id, never by model arguments. Repeated or concurrent calls within the
same deployment/workspace/tool/key scope share a snapshotted result, while a
side-effecting declaration that requires a caller key fails before start when
none is present. Natural idempotency remains handler-owned.

Filesystem, shell, and HTTP enforcement are reusable primitives for A2.3, not
enabled tools. Workspace checks use `realpath` on the canonical root and target
(or the canonical parent for creation), closing both lexical traversal and
symlink escape. Shell validation allows only explicit executables, a confined
cwd, bounded argument vectors, and allowlisted environment values without
ambient inheritance. HTTP checks every initial and redirected destination,
blocks private addresses by default, pins the validated DNS address into the
actual socket connection, rejects URL credentials, and limits both declared
and streamed response bytes. The DNS pin matters: validating one lookup and
then letting the HTTP client perform a second lookup would leave a rebinding
window while appearing SSRF-safe.

Operational redaction remains schema-owned in `event-projections.ts`: tool
arguments and results become sizes only, while audit receives a hash and size.
A2.2 does not add a second best-effort logging filter. Deterministic negative
tests cover timeout, capacity, oversized output, missing/replayed idempotency
keys, symlink escape, shell policy, redirect-to-private DNS, and streamed size.

---

## A2.3: a built-in tool is a factory, not ambient authority, 2026-08-12

The first tool suite is implemented without registering anything globally.
Deployments construct the file, search, write, process, and HTTP handlers they
intend to expose and then register them through the same A2.1 capability policy
and A2.2 execution controller as every external tool. A fresh `ToolRegistry`
still contains zero capabilities.

File read and listing require canonical existing workspace paths. Literal text
search recursively skips symlinks and bounds file count, per-file bytes,
matches, and returned line width. File replacement writes a private staged
file in the canonical target directory and renames it atomically; it requires
a trusted caller idempotency key and can require the current content SHA-256,
so a stale writer fails as `fs.write-conflict` rather than overwriting a newer
value silently.

The process tool does not accept a shell command. It passes an allowlisted
executable and string argument vector to `spawn` with `shell: false`, a
realpath-confined cwd, no ambient environment inheritance, cooperative kill,
and a streaming stdout/stderr bound. A regression passes shell metacharacters
as one argument and proves no file is created. The HTTP tool is GET-only and
reuses A2.2's scheme, destination, redirect, DNS pin, and streamed response
limits.

Prompt-injection strings returned by file and HTTP fixtures remain visible to
the model as untrusted tool-result data. They have no route into policy input,
which remains deployment, authenticated role, workspace, registered controls,
and schema-normalized arguments only. This is a boundary test, not a claim
that model-facing delimiters can make hostile content harmless.

---

## A3: approval is a bound authorization record, not another model turn, 2026-08-12

Policy suspension now produces a versioned request containing the stable run
and conversation identities, normalized tool call, canonical argument hash,
governing and complete capability set, reason code, and finite expiry. The
request is acknowledged as `approval.requested` before the run terminates as
`needsApproval`; it is returned as an owned persistence-ready value rather
than kept in an in-memory promise.

Resume accepts a deliberately narrow structured submission: approval id,
approved/denied decision, and opaque authorization proof. An injected authority
verifies that proof and supplies the authenticated actor identity. Unknown
fields—including conversation-shaped text—are rejected. The submitted run and
conversation must match the request; the stored argument hash is recomputed;
expiry is checked; and `approval.resolved` acknowledgement happens before any
handler start. A journal failure therefore leaves both execution and model
history untouched.

Approval does not create a privileged dispatch twin. Approved calls re-enter
the current registry's schema validator and full capability declaration, with
a narrow exact-argument allow rule only for the capabilities recorded in the
approval. If registration changes to require another capability while a user
is deciding, that capability is unmatched and denies. A trusted approval-id
idempotency key crosses the existing A2.2 side-effect boundary. Duplicate
identical resume returns owned prior results without a second execution or
append, while a conflicting second decision fails explicitly.

The implementation is process-local because no Phase B repository exists yet.
That is an explicit durability limit rather than an implied durable claim; the
request/resolution contracts and acknowledgement callbacks are the boundary a
later repository must implement.

---

## A4: MCP is an adapter into the gateway, not a second tool runtime, 2026-08-12

The official MCP SDK is confined to a narrow client port under `src/mcp/`.
Discovery does not automatically grant authority: the server identity is
pinned, pagination is bounded, extra tools are ignored, and every configured
tool must match a deployment-owned fingerprint over its remote name,
description, input schema, and output schema. Only deployment-owned local
names and descriptions enter the model prompt. Remote server instructions are
never consumed by the harness.

Registration is a two-phase publication boundary. Every candidate handler is
validated in an isolated registry and all live-name conflicts are checked
before any handler becomes visible. This matters because a simple loop that
registers while validating can fail on a later schema or control declaration
after already activating an earlier remote tool.

An admitted MCP call is an ordinary registered handler. Schema validation,
capability policy, approval suspension/resume, timeouts, concurrency,
idempotency, lifecycle acknowledgement, and output-size rejection remain
owned by the existing A2/A3 path. MCP text and images map to the provider
boundary; other valid content blocks are preserved as explicitly tagged
untrusted JSON instead of being silently dropped or promoted into control
input.

The official SDK wrapper applies finite connect/discovery/call deadlines and
reports ready/degraded/closed health. Its stdio transport can launch only a
deployment-allowlisted executable with bounded arguments, a realpath-confined
working directory, a finite protocol buffer, and an explicit environment.
Both an in-memory malicious SDK server and a real stdio child prove the path;
tests also cover identity and input/output-schema drift, cursor cycles,
duplicates, disconnects, oversized results, and atomic failure.

---

## B0: deployment defaults are schema inputs, 2026-08-12

B1 previously said migrations, local embeddings, attachment abstraction, and
single tenancy were decisions while still leaving their concrete versions and
defaults open. That is enough for design prose but not enough to create the
first migration: database major, vector dimension, encryption boundary, and
tenant model all become expensive data-shape commitments.

`phaseB/adrs/B0-persistence-prerequisites.md` now freezes PostgreSQL 18.x with
pgvector 0.8.6, dbmate v2.35.0 plain SQL, local encrypted disk as the default
attachment store, deployment-owned key management, a 15-minute RPO and 4-hour
RTO with quarterly restore proof, and one legal/security tenant per database.
The multi-tenant trigger is objective: stop before two independent legal,
residency, or mutually untrusted administrative domains share a database or
control plane.

The embedding contract is Ollama v0.32.5 with
`nomic-embed-text:v1.5`, 768 dimensions, and distinct document/query prefixes.
The published tag and identifier are not substituted for local proof: the
Ollama server was unavailable during B0, so B5 must capture the full local
manifest digest and deterministic output probe before creating production
vectors. A model change creates a new embedding generation and rebuild rather
than mixing incompatible vectors.

---

## B1: the first durable schema must preserve product identities, 2026-08-19

The A0 contracts intentionally model event, run, conversation, and message
identities as stable non-empty strings. Production defaults create UUIDs, but
the runtime also exposes deterministic factories for replay and verification.
Narrowing the database columns to `uuid` would make a valid product event
unpersistable and couple storage to one factory implementation, so the B1
schema stores opaque checked text identifiers while production continues to
emit UUIDs by default.

The initial migration now covers users, conversations, runs/turns, messages,
tool calls/decisions, approvals, attachments, event journal, metadata-only
audit events, outbox/checkpoints, and erasure jobs/targets. Message envelopes
are validated before SQL, denormalized query columns are extracted from the
validated envelope, `(conversation_id, seq)` is unique, and database triggers
reject in-place updates plus invalid or branching supersession. One SQL CTE
writes the canonical journal row and schema-derived audit projection together;
streaming deltas remain ephemeral.

**[VERIFIED]** dbmate 2.35.0 applied the migration to a fresh PostgreSQL 18.6
database with pgvector 0.8.6, then the TypeScript repositories passed their
live integration test. The complete suite passed 387/387 with that integration
database enabled, and typecheck passed.

The live CLI check also disproved one B0 assumption: dbmate 2.35.0 has no
`--strict` option and reports `flag provided but not defined: -strict`.
Applied-migration immutability is now enforced by a checked-in SHA-256 manifest
and the test suite instead of attributing that behavior to dbmate.

---

## B2: complete history is no longer the provider window, 2026-08-21

`ConversationManager.append()` no longer deletes old messages to fit the
model context. It owns a complete loaded transcript, still caps tool-result
content before storage in memory, and computes the provider-facing context as
a projection for `getContext()`/`compileContext()`. Callers that need to
inspect the outbound slice can use `getProviderHistory()`; callers that need
the transcript keep using `getHistory()`.

The 1.8 usage anchor survives only when its measured prefix is actually
available. A full current-history load through `MessageRepository` rebuilds
the latest usable assistant usage anchor from stored product envelopes. A
partial load falls back to `estimated`, because an anchor whose prefix was not
loaded would price a conversation the manager cannot see. If an anchored
projection cuts away the measured prefix, the kept slice is re-checked against
the unanchored message budget before delivery.

The product envelope now has a reverse mapper back to the current runtime
message union for reload. That is deliberately a codec boundary, not a
database type leak: historical JSON remains validated as the product contract,
then mapped into the runtime shape needed for provider calls.

**[VERIFIED]** deterministic tests cover long-history reload, partial-load
anchor provenance, current-message/supersession semantics, anchor tightening
and loosening, provider budget invariants, product-envelope reverse mapping,
bounded repository paging, and tool-call/result integrity. `npm test`
discovered 393 tests: 392 passed and the live storage integration skipped
without `STORAGE_TEST_DATABASE_URL`. The integration then passed separately
against PostgreSQL 18.6 + pgvector 0.8.6 after dbmate 2.35.0 applied the
checked-in migration; it proved the real `current_messages` view excludes the
superseded row during `ConversationManager` reload. `npm run typecheck` and
`git diff --check` passed. The disposable database container was removed.

The final full-suite run also exposed a same-deadline timer race outside the
history path: under scheduler load, a tool timeout could settle just before
the run deadline callback and permit another turn. `run()` now re-checks the
absolute wall-clock deadline immediately after each step. The isolated test
and two consecutive full-suite runs passed after that boundary was tightened.

---

## B3: persistence acknowledgement needs a second durable path, 2026-08-21

The required event sink already made journal acceptance part of the runtime
acknowledgement boundary. A repository call alone did not define what happens
after an uncertain commit or during a database outage. B3 now gives that
boundary two explicit outcomes: the journal, audit projection, and outbox job
commit together, or the canonical event is synced to a bounded encrypted
spool. If neither path accepts the event, publication fails and the run uses
the existing `persistenceUnavailable` result.

The durable outbox job contains only the event ID and journal sequence. It
does not copy message or tool content. The spool uses AES-256-GCM with a
deployment-owned 32-byte key, authenticated envelope metadata, directory mode
0700, file mode 0600, atomic rename, file and directory sync, and explicit
entry and byte limits. A database integrity error is not an outage and cannot
enter the spool.

Replay is at least once. If the database committed before the connection was
lost, the same event can also exist in the spool. The journal event ID makes
the replay a no-op. The spool entry is then removed. A consumer gets the event
ID as its delivery ID and advances a monotonic journal checkpoint only after
its handler succeeds. A process loss after the side effect and before the
checkpoint repeats delivery. The consumer must make its side effect
idempotent by delivery ID.

**[VERIFIED]** deterministic tests inject database outage, ambiguous commit,
commit before spool deletion, spool exhaustion, integrity failure, duplicate
replay, and failure between consumer handling and checkpoint commit. Pinned
dbmate 2.35.0 then applied the migration to a disposable PostgreSQL 18.6
database with pgvector 0.8.6. The live integration proves the journal, audit,
and outbox rows commit together and duplicate replay creates no second row.

The process-kill integration terminates the PostgreSQL backend while the
outbox trigger is active and proves that the complete statement rolls back.
It also kills worker processes after the journal commit but before event
acknowledgement, after replay commit but before spool deletion, after a
consumer side effect, and before checkpoint commit. Each restart produced one
durable side effect and a monotonic checkpoint. The complete live suite passed
404/404. `npx tsc --noEmit` and `git diff --check` passed.

---

## B4: object identity and attachment authority are different, 2026-08-21

An attachment needs a stable content identity, but authorization and deletion
belong to the attachment record. Reusing one physical object key across
conversations would require reference locking and reconciliation before any
record could delete it. B4 therefore uses IDs and immutable object keys that
carry the SHA-256 digest plus a record-specific suffix. This preserves
content addressing and integrity without making one conversation depend on
another conversation's object reference.

Uploads enter a private 0700 quarantine directory and a 0600 file first. The
stream is bounded while it is written, then MIME content is checked before an
object store or parser can receive it. Every later validation step is inside
the cleanup scope. Local publication is an atomic no-clobber hard link on the
same filesystem. The S3-compatible port requires an immutable-create
precondition and SHA-256 checksum metadata. Both backends verify byte count
and digest on read.

The service resolves attachment metadata, checks conversation access, rejects
non-available states, and only then calls the object backend. Processing is an
adapter boundary rather than a handwritten archive/document/image parser:
adapters declare a maintained library/version, while the harness validates
relative output paths, entry counts, output counts and bytes, and expansion
ratio. Unsupported formats remain rejected by default.

Deletion changes `available` to `tombstoned` and inserts the metadata-only
`attachment.delete.requested` outbox job in the same PostgreSQL statement.
Reads reject the tombstoned row immediately. The worker can delete the object
more than once and marks the row `deleted` only after object deletion succeeds.

**[VERIFIED]** adversarial tests cover streaming overflow, MIME mismatch,
invalid content IDs, cleanup after post-stage failure, message/conversation
binding, denied reads, digest tampering, traversal, symlink substitution, S3
checksum/precondition fields, unsafe processor output, and deletion replay.
Pinned dbmate 2.35.0 applied the schema to PostgreSQL 18.6 with pgvector
0.8.6. The complete live suite passed
414/414; typecheck and diff checks passed. The disposable database container
was removed.

---

## B5: local search proves its embedding boundary before indexing, 2026-08-21

B5 has deterministic code for local-only search and a live target-machine
embedding manifest. The embedding manifest parser accepts only local
providers (`ollama`, `local-process`, `local-file`), requires a full
`sha256:` model digest, validates dimensions and finite vectors, and rejects
hosted HTTP/S embedding endpoints. That closes the air-gapped negative path
in code instead of relying on operator discipline.

The storage model separates source identity from searchable chunks:
`embedding_models` pins the model manifest, `knowledge_sources` links chunks
back to message, attachment, or document sources, `knowledge_chunks` stores
content hash, citation ID, ordinal, tombstone marker, generated lexical
vector, and JSON access policy, and `chunk_embeddings` stores the pgvector
embedding keyed by chunk and manifest digest. The database uses pgvector
0.8.6 with a 768-dimension HNSW cosine index and separate GIN indexes for
lexical and access-policy lookups.

Retrieval is deliberately filtered before model exposure. The repository's
search SQL joins chunk embeddings to chunks and sources, excludes tombstoned
chunks, checks public/user/group access in the `WHERE` clause, then orders
the already-authorized candidate set by a vector/lexical score and returns
bounded chunks with citations and source identifiers.

**[VERIFIED]** deterministic tests cover full local digest enforcement,
hosted-endpoint rejection, vector dimension and `NaN` rejection, retrieval
quality metrics (`hit@k`, MRR), source-linked chunk writes, parameterized
content handling, access-filtered search SQL, migration declarations, vector
index presence, and the migration checksum. `npm run typecheck` passed.
`npm test` discovered 422 tests: 420 passed and 2 live storage tests skipped
without `STORAGE_TEST_DATABASE_URL`.

**[VERIFIED]** `npm run verify:embeddings -- --output
conformance/2026-08-21-embedding-nomic-local.json` pulled/verified local
Ollama 0.32.5 with `nomic-embed-text:v1.5`, digest
`sha256:0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f`,
embedding capability, F16 quantization, 768 dimensions, and a real
`search_query:` probe that returned a 768-dimensional vector. The report
stores a vector hash rather than the full vector.

**[VERIFIED]** pinned dbmate 2.35.0 applied the checked-in migration to a
fresh disposable PostgreSQL 18.6 + pgvector 0.8.6 container. The live B1-B5
storage integration passed with embedding manifest registration,
source/chunk/vector insertion, unauthorized search exclusion, authorized
citation return, and the prior history/journal/attachment checks. The B3
process-kill integration passed separately on the clean migrated database;
when it was first run concurrently after another storage test, it failed by
reading a prior journal row, which is test isolation debt rather than a B5
schema failure.

---

## B6: a tombstone must defeat a transaction that started before it, 2026-08-21

B6 first made the application repositories filter a subject tombstone before
writing and the public message, journal, attachment, and search paths filter it
before reading. That closes ordinary post-request writes, but it does not close
the transaction that inserted content before the erasure request and had not
yet committed. The erasure statement cannot see that uncommitted row, so a
scope snapshot alone could have completed and allowed the old transaction to
land hidden-but-still-stored content afterward.

The follow-on migration therefore adds deferred commit-time guards to messages,
attachments, journal events, knowledge sources, and chunks. A write that began
before the tombstone is rechecked at commit and rejected with SQLSTATE 55000.
The live negative control held a message insert open, committed the erasure
tombstone in another connection, and proved the late commit failed and left no
row.

The erasure itself is a convergent seven-store workflow: attachments,
embeddings, search, cache, temporary derivatives, provider payloads, and
PostgreSQL. The coordinator refuses to start unless exactly one adapter exists
for every store, deletes in dependency order with PostgreSQL last, verifies
absence after each deletion, then repeats every retrieval check during
reconciliation. Arbitrary downstream exception text is reduced to a bounded
machine code so an error path cannot copy erased content into job metadata.

Stable scope tables preserve logical message revision chains and affected
identifiers while deletion proceeds. Attachment object keys are retained only
until object-store reconciliation completes and are removed atomically with job
completion; metadata-only audit rows remain after their content-bearing journal
event is deleted. Cache, temporary-derivative, and provider-payload stores do
not exist in this repository, so their exact-adapter/failure behavior is
deterministically verified rather than claimed as a live backend proof.

**[VERIFIED]** pinned dbmate 2.35.0 applied both immutable migrations to a
fresh PostgreSQL 18.6 + pgvector 0.8.6 database. Four live storage integrations
passed: the B1-B5 baseline, conversation erasure with vector/object/journal
negative proof, logical-message revision erasure preserving sibling history,
and user erasure scrubbing the profile plus all owned conversations. The B3
process-kill regression passed separately on a clean database. Logical vector
rows and public HNSW-backed retrieval are absent after erasure; physical dead
page reclamation and backup expiry remain B7 operational-policy work.

---

## B7: recovery evidence is part of residency, 2026-08-21

A residency list alone cannot prove that a restore keeps the same product
semantics. B7 therefore makes the inventory executable: all nine locations
(database, objects, embeddings, indexes, logs, caches, temp files, backups,
and telemetry) are represented in a versioned JSON document, and validation
fails if any is missing or duplicated. Logs and optional telemetry are
metadata-only and external telemetry is disabled by default.

The physical-erasure boundary is now explicit. Active retrieval denial and
logical row/vector deletion are immediate. Autovacuum, post-erasure `VACUUM
(ANALYZE)`, and threshold-triggered vector reindex reclaim reusable space but
are not described as forensic overwrite. Encrypted immutable backups have a
35-day maximum retention baseline. A restore remains isolated until current
erasure records are reapplied and B6 retrieval reconciliation passes; an
emergency forensic-erasure requirement belongs to the deployment-owned key or
volume boundary.

The journal now has an idempotent run-history projector. It uses the durable
journal sequence for completed-message ordering and materializes only a
validated `message.completed`; deltas never enter the projector. Terminal
cancel/failure events persist bounded machine metadata without copying provider
error detail into the run row.

**[VERIFIED]** `npm run verify:residency` used two explicitly prefixed
disposable databases on PostgreSQL 18.6 with pgvector 0.8.6. A real
custom-format backup/restore preserved message order, table schema versions,
envelope schema versions, and the applied migration set. Pinned dbmate 2.35.0
then rolled the latest migration down and forward, after which the restored
history was unchanged. The same verifier passed the metadata-only log canary,
encrypted database-outage spool/replay, search-after-erasure, exact-origin
air-gap denial, and interrupted-stream terminal/no-assistant-message drills.
The content-free report and backup archive digest are recorded in
`conformance/2026-08-21-residency-recovery.json`.

**[VERIFIED]** The final database-free suite discovered 443 tests: 437 passed
and six isolated database/process tests skipped. `npm run typecheck` and `git
diff --check` passed. The live B7 verifier ran the skipped storage and
interrupted-stream gates separately; B3's literal process-kill proof remains
the earlier clean-database evidence and was not recharacterized as a B7 run.

---

## P3.1: deployment topology is a security contract, 2026-08-24

The first supported topology is now frozen in
`phase3/adrs/P3.1-single-node-deployment.md`: one client-owned Docker host,
PostgreSQL 18/pgvector 0.8.6, Ollama 0.32.5 with the already-evidenced Qwen
digest and 8,192 context, four persistent volumes, and one internal Compose
data plane with no host-published ports. There is no placeholder application
server; the stack is honestly a substrate until Phase C supplies authenticated
HTTP/SSE ingress.

## C1: authentication and SSE are one ingress boundary, not two paths, 2026-08-25

**[VERIFIED — deterministic]** `src/server/` now supplies the first Phase C
slice. Bearer sessions are strict, bounded, expiring/revocable records which
store token digests rather than raw tokens. RBAC grants operations while
parameterized PostgreSQL checks separately prove active-user conversation/run
ownership; denied resources are indistinguishable from absent ones. Run
commands reject unknown fields, unbounded content/turns, ungranted config keys,
and unauthenticated callers before command ownership transfers.

SSE reuses the canonical `RunEvent` encoder and durable event journal.
`Last-Event-ID` is resolved inside the same run, stored identity/sequence drift
fails closed, and a process-local broker carries only post-acknowledgement live
events. It is deliberately not replay storage, and subscriber failure cannot
reject an event whose durable acknowledgement already succeeded. Thirty-one
focused server/repository tests pass. The full suite discovers 462 tests (456 pass and
six isolated database/process integrations skip without a disposable
database); typecheck and the eight-check deployment topology verifier pass.

**[UNVERIFIED / deferred]** C1 does not yet claim a deployable chat product.
The C2 command gateway must append the authenticated user message, load complete
history, invoke the existing bounded runtime/policy path, compose durable
journal/spool acknowledgement before fan-out, and then join Compose as the sole
published ingress. The P3 operational artifact remains development-host
evidence; target client-owned Linux certification is still a release gate.

**[VERIFIED — deterministic]** Registry inspection resolved immutable
multi-architecture digests for Node, pgvector, Ollama, and dbmate. Compose's
fully rendered all-profile JSON passes a fail-closed policy covering exact
services/volumes, the internal data network, absence of host ports,
least-privilege file secrets, health/migration dependency conditions, and the
one explicit egress-capable model-bootstrap job. Five focused tests pass,
including a negative control that mutates the manifest to add a database port,
move inference onto egress, use `latest`, and inject a password-like
environment variable; every mutation is rejected.

The runtime readiness job is intentionally stronger than container health. It
requires PostgreSQL major 18, pgvector exactly 0.8.6, both applied migration
versions, Ollama exactly 0.32.5, the full pinned model digest, a real load at
8,192 context, a writable attachment canary, and an authenticated event-spool
open with a 256-bit key. It emits metadata only.

**[VERIFIED — implementation boundary]** Secrets are newline-terminated
regular files mounted per service. Direct password/key environment variables
fail configuration. dbmate and `pg_dump` create a mode-`0600` temporary
`.pgpass`, keeping the password out of process arguments, URLs, Compose
environment, reports, and images. The model-bootstrap profile is the only
egress path; steady Ollama has cloud functions disabled and is attached only
to the internal network.

**[VERIFIED — live development environment]** The complete connected path ran
on Docker Desktop 4.77.0, Linux ARM64 engine 29.5.3, Compose 5.1.4. All three
local images built; Qwen bootstrap resolved to the pinned digest; a fresh
PostgreSQL volume applied both migrations; readiness observed pgvector 0.8.6,
Ollama 0.32.5, and the model loaded at 8,192 context; the attachment/spool
checks passed; and a real mode-`0600` custom-format backup plus SHA-256 was
created. After database/inference restart, migrations reported two applied and
zero pending, volume initialization remained non-destructive, and readiness
passed again. Network inspection found only database/inference on the internal
data plane, no published ports, and no steady container on bootstrap egress.

The live run caught two operational defects that static validation could not.
The first 120-second model-load deadline cancelled Docker Desktop's CPU-only
repack/warmup even though Ollama had allocated the correct 8,192-token context;
the finite deployment deadline is now ten minutes and the unchanged
digest/context gate passed. The backup job initially ran as the host UID on a
root-owned mode-`0700` tmpfs and could not create `.pgpass`; matching tmpfs
UID/GID fixed it, after which the backup passed. Evidence is in
`conformance/2026-08-24-single-node-deployment.json`. This is development
evidence, not a substitute for repeating the gate on the target client-owned
Linux host before production.

**[VERIFIED — final candidate]** The production dependency audit initially
found one moderate advisory in the MCP SDK's transitive Hono 4.12.33. The
compatible lockfile resolution now selects Hono 4.13.3; `npm audit --omit=dev`
reports zero vulnerabilities. The runtime image was rebuilt from that final
lockfile, then migrations, volume initialization, and full runtime readiness
passed again. The final database-free regression discovered 448 tests: 442
passed and six isolated database/process integrations skipped; typecheck,
deployment policy verification, and `git diff --check` passed.

---

## C2: command acceptance is a database ownership transfer, 2026-08-25

**[VERIFIED — deterministic and live PostgreSQL]** C2 requires a caller-owned
idempotency key and binds it to a canonical authenticated command hash. One
parameterized PostgreSQL statement locks the conversation, then atomically
creates command ownership, the user message, and the pre-owned run. Identical
retries return the first run without executing inference twice; different
content under the same user/key fails with a stable 409 conflict. HTTP 202 is
therefore an acknowledgement of durable ownership, not merely an in-memory
background task.

Adding direct user messages exposed a sequencing assumption in the B7
projector: a global journal sequence cannot remain the conversation message
sequence once messages also enter outside the journal. Both direct writes and
projected completed messages now allocate under the locked conversation row.
The projector separately binds the canonical `run.started` time to a pre-owned
run and backfills legacy run starts during migration, preserving idempotent
replay after upgrade.

The concrete gateway reloads complete current history, obtains a current local
model admission lease, passes the authenticated deployment/role/conversation
policy context into bounded `run()`, and composes journal/spool acknowledgement,
idempotent projection, then C1 live broker publication in that order. Compose
adds exactly one loopback server port with file secrets, read-only root, dropped
capabilities, persistent attachment/spool mounts, and only the internal data
plane. PostgreSQL and Ollama remain unpublished.

The live gate used a fresh disposable PostgreSQL 18/pgvector 0.8.6 database and
pinned dbmate 2.35.0. It caught an unused SQL placeholder whose type PostgreSQL
could not infer after the sequencing change; removing that stale parameter made
the same test pass. The final migration and integration then passed from a new
database, and both disposable containers were removed. The full suite discovers
474 tests (467 pass, seven environment-isolated live tests skip); the C2 live
test passes separately. Typecheck, rendered Compose policy, final production
image build, and the image-local production dependency audit pass with zero
reported vulnerabilities.

**[UNVERIFIED / release gates]** This development host does not certify the
target Linux machine, approved TLS ingress, accelerator residency, or a full
client-session inference run. C3 now owns durable session administration and
approval APIs; C4 owns rate/spend controls and product reads.

---

## C3: authorization state must outlive both files and processes, 2026-08-25

**[VERIFIED — deterministic and live PostgreSQL]** C3 makes PostgreSQL the
live authority for token-digested bearer sessions, current roles, and current
model grants. The C1 registry is retained only as a one-time empty-database
bootstrap: later restarts cannot overwrite an administrator's changes or
revive a revoked session. Issuance returns a bounded raw token exactly once in
a no-store response, while SQL receives only its SHA-256 digest. Access changes
take effect on the next request because authentication joins current grants
rather than trusting stale session claims.

Approvals are reconstructed from durable run/tool/policy rows and filtered by
conversation ownership; members can act only on their own conversations and
admins can act tenant-wide. Resolution accepts the complete exact batch, injects
the authenticated session as the A3 authority proof, and uses
`ApprovalResumeController`. One SQL boundary records all decisions with actor,
session, and request fingerprint before an approved handler starts. Structured
unknown fields—including conversational text—are rejected. Tool results are
then appended to durable history, and an identical same-session retry does not
execute again.

The live gate applied all four immutable migrations with pinned dbmate 2.35.0
to a fresh PostgreSQL 18/pgvector 0.8.6 database. It proved bootstrap
non-reapplication, admin authentication, access replacement, one-time session
issuance, current-grant member authentication, approval execution plus durable
decision/result state, idempotent replay, and revocation. The first live run
caught `grant` being used as a PostgreSQL alias; renaming the reserved token and
rerunning from a clean database passed. The existing B1-B6 storage integration
suite also passes on the C3 schema. A focused live B6 erasure proof additionally
removes the user's C2 command, roles, and model grants, revokes their sessions,
destroys the original token digest, and detaches the run from the erased
command.
The full database-free suite discovers 487 tests: 479 pass and eight isolated
database/process integrations skip.

**[VERIFIED — browser authority boundary]** The deployment remains bearer-only:
cookies and every request carrying an `Origin` header fail closed, and no CORS
credential header is emitted. This is an explicit absence of browser-cookie
authority, not a claim that CSRF has been solved for a future cookie mode.

**[UNVERIFIED / release gates]** Target Linux qualification, approved TLS
termination, accelerator-resident inference, and a full client-session model
run remain unverified. C4 owns per-user/model concurrency and rate controls,
enforceable token/spend budgets, and bounded product read APIs.

---

## C4: a budget decision is a reservation before work, not a report after it, 2026-08-25

**[VERIFIED — deterministic and live PostgreSQL]** C4 places one expiring,
caller-idempotent reservation in PostgreSQL before C2 command ownership. Under
transaction advisory locks for the user and provider/model scopes, fresh
statements evaluate active concurrency, accepted-run rate, and rolling
token/spend totals before inserting. An identical retry reuses the first
reservation. A different request under the same caller key conflicts instead
of being charged twice.

Token capacity is reserved conservatively as `contextWindow * maxTurns`; spend
uses a declared per-run maximum. The supported local Ollama route reserves zero
provider spend. Completed assistant messages carry the product-owned required
token and USD-cost usage envelope, so successful work settles to measured
values. Incomplete reporting retains the conservative reservation. Expiry
releases concurrency after a process death but does not erase its budget charge
inside the accounting window.

The route fails before creating a message or run unless it declares an enforced
output limit and token/cost reporting. This is separate from model admission:
memory and runtime readiness do not prove that a provider can enforce or report
a financial/token bound.

C4 also exposes bounded current messages, available attachment metadata, one
run status, and administrator-only audit pages. Member reads reuse the existing
PostgreSQL ownership boundary. Attachment output omits object keys and hashes;
audit output joins only the already-redacted `audit_events` projection, never
the canonical journal payload. Query schemas accept one exact cursor and a page
limit no greater than 100.

Pinned dbmate 2.35.0 applied all five migrations to a fresh disposable
PostgreSQL 18/pgvector 0.8.6 database. The live C4 test proved atomic
concurrency rejection, measured settlement, released capacity, bounded product
reads, and absence of message content from audit output. The existing B1-B6 and
C2-C3 integrations passed serially on the same clean schema. A first combined
rerun caught a non-unique object-key test fixture; making the fixture identity
unique fixed the test. Reusing the already-mutated database then demonstrated
again why stateful storage integrations require a reset disposable database;
the final proof ran once from a new clean container, and the container was
removed afterward.

The full database-free suite discovers 500 tests: 491 pass and nine isolated
database/process integrations skip. Typecheck, rendered Compose topology, and
`git diff --check` pass. `npm audit --omit=dev --offline` reports zero
vulnerabilities from the local advisory cache; three live registry audit
attempts returned an empty endpoint error, so a current network-backed audit is
explicitly unverified rather than reported as a pass.

**[UNVERIFIED / release gates]** The deterministic and disposable-database
proof does not certify the target Linux host, approved TLS ingress,
accelerator-resident inference, or a real authenticated local-Qwen run through
the deployed C4 server. Those remain separate release gates.
