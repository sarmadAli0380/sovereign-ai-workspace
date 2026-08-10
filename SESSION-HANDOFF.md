# Session handoff — Sovereign AI Roadmap

**Last updated:** 2026-08-10
**Repo:** `~/Downloads/sovereign-ai-roadmap`
**State:** Phase 1 complete and verified live. Phase 2 complete.

Read `CLAUDE.md` first, then this, then `findings-log.md`. The findings log
is long but it is the "why" behind every decision, including several that
were reversed.

Read `lessons.md` before writing any code. It is short, and it is the list
of mistakes that have actually shipped here — with the check that catches
each one.

---

## Where things stand

| Phase | State |
|---|---|
| 1.1–1.7 | **Done.** Built, tested, verified against two live providers. |
| 1.7 `step()` | **Done.** One transition, not a loop — caller owns iteration. |
| 1.8 token budgeting | **Done.** `1.8-token-budgeting.md`, both stages, verified live. |
| 2.1 model families | Done — `phase2/adrs/2.1-model-families.md` |
| 2.2 inference engines | Done — `2.2-inference-engines.md` |
| 2.3 quantization | Done — `2.3-quantization.md` |
| 2.4 sizing math | Done — `2.4-gpu-sizing-math.md`, measured, shipped as code |
| 2.5 local integration | Done — `2.5-local-provider-integration.md`, running |
| A0.1 run events | Done — versioned union, runtime parser, run invariants, audience projections |

**The headline result:** the harness swaps between a cloud API
(`openai-codex`) and a self-hosted model (`ollama`/`qwen3:4b`) with zero
code changes — different API surfaces, same code, only the configKey
differs. That was Phase 1's project goal and it needed Phase 2's local
model to demonstrate.

229 tests, `tsc --noEmit` clean.

Latest baseline evidence is machine-readable at
`conformance/2026-08-10-remediation-baseline.json`. Deterministic checks,
Codex and local-Qwen tool conformance, and the cross-provider swap passed.
The verifier also demonstrated that it fails when Ollama's actually served
context does not match the configured budget, before passing after the
service was restarted at 8192.

---

## Running it

```bash
cd ~/Downloads/sovereign-ai-roadmap

npm test                                            # 229 tests
npx tsc --noEmit                                    # typecheck

node scripts/verify-live.ts codex-default           # cloud, full tool round trip
node scripts/verify-live.ts local-qwen              # local model
node scripts/verify-swap.ts codex-default local-qwen  # cross-provider swap

node scripts/size-model.ts --model qwen3:4b --budget 5.7   # 2.4 sizing
```

`HARNESS_TRANSPORT=sse` is **no longer needed** — transport moved into
per-entry config. Verified 2026-08-04.

**Ollama must be running at the configured context** for `local-qwen`:
`OLLAMA_CONTEXT_LENGTH=8192 ollama serve` (model `qwen3:4b` already pulled,
2.5 GB). The desktop app's default 4096 context is not conformant;
`verify-live.ts` checks `/api/ps` and rejects that mismatch.

**Codex credential** lives in `.harness-credentials.json` (gitignored,
0600). It is OAuth and **will expire** — symptom is
`refresh_token_invalidated`. Fix: `node scripts/login.ts openai-codex`,
which needs the user at a browser. It is a device-code flow; relay the URL
and code to them.

---

## Architecture in one paragraph

Built on `@earendil-works/pi-ai` (ADR-002). `src/types.ts` re-exports
pi-ai's ontology unchanged and adds `HarnessResult`. `config.ts` +
`load-model.ts` resolve a configKey to a model in one lookup.
`conversation-manager.ts` + `truncation.ts` own conversation state.
`tool-registry.ts` owns tool dispatch. `step.ts` composes them into one
transition — validate, call, dispatch, append, return — and is the single
place a failure becomes a `HarnessResult` instead of a throw. `openai-compatible.ts` registers any
`/v1`-speaking server generically. `complete.ts` wraps calls with retry.
`events.ts` owns the versioned product run-event contract and complete-run
invariants; `event-projections.ts` creates content-bearing UI/persistence
views and redacted audit/operational views. Neither is wired into `step()`
yet; that belongs to A1.

---

## Hard-won facts — do not re-derive these

### The ADRs' claims about pi-ai have been wrong five times

Every one was "pi-ai does X" when it didn't, found at implementation cost:

1. `builtinModels` is **not** a root export → `@earendil-works/pi-ai/providers/all`
2. flat `getModel()` is deprecated, `/compat` only
3. pi-ai **never calls** `validateToolCall` — the harness must, and now does
4. `detectCompat()` has **no localhost case**, so self-hosted servers get
   hosted-OpenAI defaults
5. 1.8 claimed codex's replayed reasoning was invisible to the harness. It
   is in `ThinkingContent.thinkingSignature`, a documented field — 1146
   chars of it on one turn — and `estimateTokens` simply wasn't counting it

**Treat any remaining "pi-ai already handles X" claim as unverified until
executed.** A grep would have caught most of these.

### A billed token is not a resent token

The 2026-08-05 sibling of the rule below. `usage.output` counts reasoning
tokens on both providers — but codex replays its reasoning (as an opaque
`thinkingSignature`) while qwen discards 3106 characters of thinking the
harness had dutifully counted. The same message record was an underestimate
on one provider and a 9× overestimate on the other. **Accounting for
generation and accounting for context are different questions**, and only
the second sizes a budget.

Signatures are counted since the QA pass, so the codex half is now measured
rather than missing — but the asymmetry itself is the durable point: what a
provider *replays* is not derivable from what it *billed*.

### Tolerance is not support

The single most useful rule this project produced. Probing six compat flags
against Ollama returned `ok` for all six — including
`max_completion_tokens`, which does nothing. Testing whether a parameter is
*accepted* proves nothing; only testing whether it is *honoured* does.

Confirmed instances of accepted-and-ignored:
- `openai-codex` silently drops `maxTokens` (measured: limit 40 → 736 tokens)
- Ollama silently ignores `max_completion_tokens`; it needs `max_tokens`

### Providers lie about their context window

`qwen3:4b` advertises 262144, `ollama show` agrees, Ollama serves **4096**
(`curl localhost:11434/api/ps`). Trusting the advertised number would let
`ConversationManager` fill a ~245k budget while the server silently
discarded everything past 4096 — a model that "forgets" while the harness
insists nothing was dropped. Always check what is *served*.

### Provider quirks are data, not code

There are **zero provider names in harness control flow**, and it must stay
that way. An audit found `PROVIDERS_IGNORING_MAX_TOKENS = new Set([...])`
and it was removed. Quirks are declared per config entry:
`transport`, `maxTokensHonored`, `contextWindow`. Self-hosted servers go in
`local-providers.json`.

Adding a provider should be a JSON edit. If you find yourself writing
`if (provider === ...)`, stop.

### Network is flaky here

~8% of calls fail with a bare `fetch failed`. Failures are **bursty, not
independent** — measured, which is why retry uses a 1000ms base rather than
500ms. This is environment, not a harness defect. Retry before concluding
anything is broken.

### Hardware ceiling

Apple M3, **8 GB**. This invalidates the roadmap's "7–13B" target — 4B is
the honest ceiling. vLLM is unavailable entirely (CUDA-only). Document
larger deployments as math rather than running them.

And the ceiling is not fixed: 2.4 measured `qwen3:4b` fitting fully at
12288 context and spilling to CPU at 14336, with the boundary set by *free*
memory at load time, not installed memory. The runtime also reserves 1 GiB
it will not spend. `node scripts/size-model.ts --model <tag> --budget <free
GB>` answers this rather than guessing — memory is exactly linear in
context (148,480 B/token on qwen3:4b) right up until it isn't.

---

## What to work on next, in order

### 1. Smaller open items

- **1.8's cache arithmetic — not a gap, a floor.** The anchor adds
  `input + cacheRead + cacheWrite`, and every measurement here has reported
  both cache fields as 0. That is *expected*, not missing: OpenAI prompt
  caching only engages at **≥1,024 tokens**, and the conversations this repo
  runs measure 131 (codex) to 950 (ollama). Nothing to hunt for.

  The sum itself is now derived rather than guessed — the docs confirm
  cached tokens are a subset of the prompt, and pi-ai reports
  `input = max(0, prompt_tokens − cacheRead − cacheWrite)`, so the three
  add back to exactly `prompt_tokens`. Still unobserved above the floor.

  pi-ai already carries the knobs as compat flags — `cacheControl`,
  `promptCacheOptions`, `promptCacheRetention`, and `prompt_cache_key` via
  `sessionId` — so enabling any of it stays a config edit. Note GPT-5.6+
  bills cache *writes* at 1.25× uncached, so turning it on below the floor
  is strictly a loss. And this is platform-API documentation: our
  `openai-codex` entry uses the ChatGPT subscription endpoint, which is
  known to reject parameters the platform accepts. Probe before believing.
- Reasoning **replay** is shape-dependent and uncharacterised: qwen dropped
  3106 chars of thinking on a plain turn and appears to replay it across a
  tool-call continuation. The `prev.in` anchor is deliberately built not to
  care, but it is worth knowing.
- `thinkingFormat` — `qwen3:4b` reports a `thinking` capability; pi-ai's
  compat offers `"qwen"` / `"qwen-chat-template"` against a default of
  `"openai"`. We may be leaving capability unused. Not blocking.
- A short docs paragraph on adding a provider: verify `contextWindow`
  against `/api/ps`, and test that `maxTokens` actually bounds output.
- Cross-provider swap is proven; **Anthropic-vs-OpenAI-Platform structural
  diff (1.3) never ran** and needs vendor API keys. May stay closed.
- KV cache quantization (`OLLAMA_KV_CACHE_TYPE=q8_0`) halves the cache term
  and 2.4's calculator already takes `kvCacheBits`, but it needs a server
  restart to test and its quality cost is unmeasured.

### 2. Phase 3 — infra & deployment

Docker, compose, on-prem vs private cloud. The roadmap says this is where
most of the real time goes.

---

## Working agreements from this session

- **Verify before asserting.** Phase 1's churn was under-verification, not
  bad design — the architecture decisions all survived. Mark claims
  `[VERIFIED]` / `[UNVERIFIED]` and separate decisions from facts.
- **Log to `findings-log.md`**, not new standalone summary files.
- **Don't re-litigate decided ADRs** — flag and explain if one seems wrong.
- Record failed predictions too. Several of mine were wrong (I expected
  multiple compat flags to need overrides; only one did) and that is worth
  keeping.
- An adversarial QA pass found **six bugs while 93 tests were green**, then
  a live pass found four more. Passing tests are not evidence of
  correctness — they cluster where the author was already right.
