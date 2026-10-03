# Session handoff — Sovereign AI Roadmap

**Last updated:** 2026-08-24
**Repo:** `~/Downloads/sovereign-ai-roadmap`
**State:** Phases 1, 2, A, and B complete; live evidence is recorded per gate.

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
| A0.2 event transport | Done — ordered async stream, sink semantics, checkpoints, SSE mapping |
| A0.3 product messages | Done — versioned envelope, runtime codec, compatibility fixture |
| A0-P.1 context compiler | Done — deterministic prompt layout, bounded projection, allocations, fingerprints |
| A0-P.2 cache conformance | Done — live Codex cache proof; Qwen metrics honestly unverified |
| A0-P.3 truncation decision | Done — drop-oldest retained as default after deterministic and live comparison |
| A0-M.1 capability records | Done — declared/observed values, provenance, freshness and route gate |
| A0-M.2 local admission | Done — generic controller, Ollama adapter, memory/residency/concurrency gates |
| A0-M.3 performance baseline | Done — 30 warm samples/profile plus 30 Qwen loads; no SLO yet |
| A1.1 streaming step | Done — one provider stream, optional ordered sink, same-stream final result |
| A1.2 bounded run | Done — required turn/deadline bounds, canonical events, terminal state machine |
| A2.1 capability policy | Done — required declarations, deterministic fail-closed decisions, approval batch suspension |
| A2.2 execution controls | Done — timeout/output/concurrency enforcement, confinement, shell/HTTP policy, idempotency |
| A2.3 built-in tools | Done — opt-in confined file/list/search/write, no-shell process, policy-bound HTTP |
| A3 approval resume | Done — bound expiring requests, authenticated resolution, idempotent resume, journal gate |
| A4 MCP integration | Done — official SDK, pinned atomic discovery, shared gateway, confined stdio, health |
| B0 persistence prerequisites | Done — versions, storage, encryption, recovery, tenancy, local embeddings frozen |
| B1 schema/codecs/repositories | Done — dbmate schema, explicit SQL repositories, append-only history, live PG18/pgvector proof |
| B2 complete history/provider projection | Done — complete in-memory reload, bounded provider view, full/partial anchor provenance |
| B3 durable journal/outbox | Done — atomic journal/audit/outbox SQL, required sink, encrypted bounded spool, replay checkpoints, live process-kill proof |
| B4 attachments and ingestion | Done — content-bound IDs, quarantine, local/S3 stores, read authorization, bounded processors, outbox deletion |
| B5 local embeddings and search | Done — local nomic digest/availability proof, source-linked chunks, pgvector/HNSW plus lexical index, access-filtered retrieval, citations, quality fixtures, live PG proof |
| B6 retention and verified erasure | Done — transactional tombstones, deferred late-write guards, seven-store adapter gate, reconciliation, live conversation/message/user negative proof |
| B7 residency, recovery, operational proof | Done — machine-readable inventory, metadata-only log canaries, live backup/restore and migration recovery, air-gap/outage/erasure/interruption drills |
| P3.1 single-node deployment | Done — frozen topology, digest-pinned images, internal Compose data plane, file secrets, persistent volumes, migrations/bootstrap/readiness/backup; live Docker Desktop proof passed, target Linux host remains a release gate |
| C1 authenticated HTTP/SSE ingress | Done — strict bearer-session registry, RBAC plus PostgreSQL ownership checks, bounded run command, durable per-run SSE replay, and post-ack live broker |
| C2 durable run gateway/service | Done — caller-key idempotent command/message/run ownership, complete-history reload, local admission lease, bounded runtime, journal/projector-before-SSE order, and one hardened loopback Compose ingress |
| C3 durable identity/approvals | Done — PostgreSQL sessions/current grants, one-time registry bootstrap, admin issuance/revocation, authenticated ownership-filtered approval batches through `ApprovalResumeController`, and bearer-only origin/cookie denial |
| C4 controls/product reads | Done — durable idempotent concurrency/rate/token/spend reservations, measured/conservative settlement, provider-accountability gate, and bounded ownership-filtered message/attachment/run/audit reads |

**The headline result:** the harness swaps between a cloud API
(`openai-codex`) and a self-hosted model (`ollama`/`qwen3:4b`) with zero
code changes — different API surfaces, same code, only the configKey
differs. That was Phase 1's project goal and it needed Phase 2's local
model to demonstrate.

500 tests discovered. Without a database URL, 491 pass and 9 storage/process
integration tests skip. With a disposable PostgreSQL 18.6 + pgvector 0.8.6
database, the four B1-B6 storage integrations passed, including B5 embedding
manifest registration and B6 conversation/message/user erasure, concurrent
late-write rejection, audit survival, and public retrieval absence. The B3
process-kill integration also passed on a separately clean migrated database.
The B7 verifier additionally passed a real custom-format backup/restore,
ordered message/schema-version checks, pinned dbmate down/up recovery,
metadata-only log canaries, database-outage spool/replay,
search-after-erasure, air-gapped egress denial, and interrupted-stream terminal
projection. Evidence is in
`conformance/2026-08-21-residency-recovery.json`.
The C3 live integration separately passed one-time identity bootstrap, current
grant administration, digest-only session issuance/authentication, approval
resolution/result durability and replay, and revocation on a fresh four-
migration PostgreSQL 18/pgvector 0.8.6 database. Pinned dbmate then applied the
fifth C4 migration to a fresh database; the C4 control/read integration and the
existing B1-B6/C2-C3 storage integrations all passed serially on that clean
schema. The disposable container was removed after proof.
`npm run verify:embeddings`
passed against local Ollama 0.32.5 and `nomic-embed-text:v1.5`.

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

npm test                                            # 491 deterministic + 9 isolated storage/process integrations
npx tsc --noEmit                                    # typecheck

node scripts/verify-live.ts codex-default           # cloud, full tool round trip
node scripts/verify-live.ts local-qwen              # local model
node scripts/verify-swap.ts codex-default local-qwen  # cross-provider swap
node scripts/verify-cache.ts codex-default local-qwen # cold/warm cache evidence
node scripts/verify-truncation.ts codex-default local-qwen # A0-P.3 strategy comparison
OLLAMA_ADMISSION_FREE_BYTES=<measured> node scripts/verify-admission.ts qwen3:4b 8192
node scripts/verify-model-load.ts local-qwen --samples 30 --output conformance/model-load.json
node scripts/verify-performance.ts codex-default --samples 30 --model-load-ms 0 --model-load-source hosted-provider-not-applicable
node scripts/verify-performance.ts local-qwen --samples 30 --model-load-ms <measured> --model-load-source <source>

# Destructive only to two databases whose names start sovereign_b7_.
B7_CONFIRM_DISPOSABLE=1 \
B7_SOURCE_DATABASE_URL=<disposable-migrated-url> \
B7_RESTORE_DATABASE_URL=<distinct-empty-url> \
npm run verify:residency -- --output conformance/<date>-residency-recovery.json

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
`tool-registry.ts` owns the two-phase tool gateway: required control
declarations, whole-batch policy decisions, then parallel dispatch.
`tool-execution.ts` enforces the registered timeout/output/concurrency and
caller-key idempotency controls and provides the confined filesystem, shell,
and DNS-pinned HTTP policy primitives A2.3 uses to compose built-in tools.
`src/tools/` now composes those primitives into opt-in read/list/search/write,
process, and HTTP handlers; it performs no implicit registration.
`policy.ts` evaluates deployment/role/workspace/capability/normalized-argument
rules without conversation input and fails closed when policy is absent,
unmatched, or ambiguous. `step.ts` composes them into one
transition — validate, stream, dispatch, append, return — and is the single
place a failure becomes a `HarnessResult` instead of a throw. It forwards
ordered raw provider events through an optional acknowledgement sink and gets
the completed message from that same stream; only a validated successful
message is appended. `openai-compatible.ts` registers any
`/v1`-speaking server generically. `complete.ts` wraps calls with retry.
`events.ts` owns the versioned product run-event contract and complete-run
invariants; `event-projections.ts` creates content-bearing UI/persistence
views and redacted audit/operational views. `event-transport.ts` owns ordered
in-process delivery, acknowledgement-boundary and optional-observer sink
semantics, reconnect checkpoints, and the pure SSE mapping. The canonical
run-event transport is wired at the bounded `run()` boundary: A1.1 exposes raw
single-call provider events, while `run.ts` maps deltas, validated completed
messages, tool requests/decisions/lifecycles, per-turn usage, and the final logical outcome into
one canonical lifecycle; `turn.completed` also carries the current
anchored/estimated context budget. It requires a turn cap, absolute deadline, stable
conversation/causation identity, and an acknowledged sink. Tool handlers now
receive an optional signal/deadline execution context. `messages/envelope.ts`
is the durable
product message contract, and `messages/codec.ts` validates and maps the
current `pi-ai` runtime union without coupling stored history to it.
`context/context-compiler.ts` owns deterministic provider projection:
versioned prompt layout, stable tool ordering, explicit allocations,
untrusted-content delimiters, final-context validation, and content-free
fingerprints. `ConversationManager` now keeps complete loaded history,
projects a bounded provider view per call, reloads current messages through
`MessageRepository`, and reports anchored versus estimated budget provenance
only when the measured prefix is available. `context/prefix-preserving-compaction.ts` is a
measured, opt-in candidate; drop-oldest remains the runtime default.
`model-control/capabilities.ts` owns the versioned model capability record:
configured claims and live observations have distinct provenance, while a
deterministic route gate makes missing, stale, unhealthy, unready, or
insufficient observations explicitly non-routable. Model loading and
admission are layered on it through A0-M.2.
`mcp/adapter.ts` admits only deployment-configured remote tools after bounded
paginated discovery, server identity and input/output-schema fingerprint
checks, and a per-server capability ceiling; it publishes the complete set
atomically into the existing registry. `mcp/official-client.ts` is the narrow
official-SDK v1 boundary and exposes finite request deadlines and connection
health. Its stdio connector reuses the A2 shell/workspace policy with no
ambient environment inheritance. Remote instructions and descriptions never
enter the model prompt, and non-text/image MCP blocks are retained only as
explicit untrusted JSON tool-result data.
`model-control/admission.ts` now owns that admission boundary, with the first
runtime adapter in `model-control/ollama.ts`. It serializes load decisions,
applies capability freshness and memory/headroom policy, limits resident
models and sequences, re-inspects after loading, and exposes cold/loading/
ready/busy/degraded states. Live evidence is in
`conformance/2026-08-11-admission.json`.
`performance-baseline.ts` owns A0-M.3's deterministic minimum-sample and
nearest-rank aggregation. `scripts/verify-performance.ts` records a fixed
two-call tool workload with separate queue, model-load, provider, and tool
timings. Final evidence is in
`conformance/2026-08-11-performance-qwen.json` and
`conformance/2026-08-11-performance-codex-final.json`; thresholds remain
explicitly unestablished. `scripts/verify-model-load.ts` unloads before every
sample and records the separate warm-process cold-load distribution in
`conformance/2026-08-11-model-load-qwen.json`.
`src/storage/migrations/20260819000100_initial_storage.sql` is the first dbmate
migration and `20260821000200_verified_erasure.sql` is the B6 follow-on, with
`src/storage/schema.sql` as the checked-in PostgreSQL snapshot and
`src/storage/migrations/checksums.json` preventing edits to either applied file.
`src/storage/repositories/` contains explicit parameterized SQL for identities,
history, runs/turns, tools/decisions, approvals, attachments, the atomic
journal/audit pair, outbox/checkpoints, and erasure jobs. `storage/pg.ts` is
the narrow node-postgres adapter. Live integration evidence used PostgreSQL
18.6, pgvector 0.8.6, and dbmate 2.35.0; the pinned dbmate CLI was verified not
to support the previously documented `--strict` option.
`src/storage/attachments.ts` owns B4's quarantine and attachment lifecycle.
It provides content-bound identities, strict MIME/size checks, immutable local
disk and S3-compatible object-store adapters, access-controlled reads,
bounded maintained-library processor adapters, and outbox-driven idempotent
deletion. Object keys contain the content digest and a record-specific suffix,
so deletion does not create shared-object reference races.
`src/storage/erasure.ts` owns B6's convergent deletion coordinator. The B6
migration snapshots stable subject scope, hides tombstoned content through the
message/journal/search paths immediately, and installs deferred database guards
that reject a content write whose transaction predates the tombstone. The
coordinator requires one adapter for each of attachments, embeddings, search,
cache, temporary derivatives, provider payloads, and PostgreSQL; runs
PostgreSQL last; and marks completion only after every adapter passes both its
first retrieval check and a second reconciliation pass. SQL/object-store paths
were verified live; cache/temp/provider adapters were verified deterministically
because this repository does not implement those stores.
`phaseB/residency-inventory.v1.json` is B7's checked inventory for database,
objects, embeddings, indexes, logs, caches, temp files, backups, and telemetry.
`src/residency.ts` validates it, emits metadata-only operational log records,
and supplies the exact-origin/no-redirect air-gap fetch boundary.
`src/storage/run-history-projector.ts` consumes at-least-once journal delivery
into idempotent run, turn, completed-message, and terminal projections.
`scripts/verify-residency.ts` runs the guarded backup/restore, migration
recovery, outage, erasure, air-gap, log-canary, and interruption proof suite.

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

### A0-M.3 result to carry forward

The measurement process is complete, but it did not establish an SLO. Qwen
passed 30/30; Codex failed closed at 27/30 with 40 retries. Treat the Codex
failure rate and Qwen's 83.279 s p95 round trip as baseline evidence, not as
acceptable targets. The benchmark is sequential, so its near-zero queue time
does not characterize contention. Event-derived generation throughput is not
provider-internal throughput. Qwen's warm-process cold-load p50/p95 is
1.932/3.007 s; its excluded first post-service-start load was 15.687 s, so do
not substitute one load state for the other.

### 1. Phase D — web UI

P3.0-P3.2 are implemented and passed on Docker Desktop's Linux ARM64 engine;
evidence is in `conformance/2026-08-24-single-node-deployment.json`. Repeat the
same gate on the target client-owned Linux host before production, but do not
block the product critical path on buying a second host.

C4 completes the current Phase C plan: PostgreSQL now owns idempotent expiring
concurrency/rate/token/spend reservations; controlled routes fail before
command ownership when output limits or usage/cost reporting are not
accountable; measured product usage settles reservations; and exact bounded
message, available-attachment metadata, run-status, and admin audit reads are
exposed under existing ownership/RBAC rules. The next product phase in
`product-roadmap.md` is Phase D: a web UI for chat streaming, history,
attachments, model capability display, and administration. Freeze a Phase D
implementation plan and UI authority model before adding browser cookies or
cross-origin credentials; C4 remains bearer-only.

### 2. Smaller open items

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
