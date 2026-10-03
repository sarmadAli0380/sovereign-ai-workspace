# Implementation plan — harness perimeter through Phase B

**Status:** Completed 2026-08-21. Plan 0, A0, Phase A, and B0-B7 are
implemented and verified. P3.1 infrastructure/deployment is now sequenced in
`implementation-plan-phase3.md`.
**Scope:** The pre-Phase-A contracts and controls, Phase A agent runtime,
and Phase B persistence/residency.
**Baseline:** Phase 1/2 harness is implemented; Codex and local Qwen live
conformance passed on 2026-08-06.
**Supersedes:** No ADR. This sequences the decisions already recorded in
`ADR-003`, `A1-agent-runtime.md`, and `B1-persistence-and-residency.md`.

## Outcome

At the end of this plan, the repository will provide a bounded, policy-
controlled agent runtime whose canonical events can be streamed, replayed,
persisted, audited, searched, retained, and erased inside a client's data
boundary.

The critical path is:

```text
freeze contracts
  -> make prompt/model behaviour observable
  -> implement bounded execution
  -> enforce policy and approvals
  -> journal every acknowledged transition
  -> persist complete history and derived data
  -> prove recovery, residency, and erasure
```

Prompt caching is treated as a measured optimization. Message/event
semantics, cancellation, policy, and durability are correctness contracts.

## Delivery principles

1. **The model proposes; deterministic code owns authority, state, safety,
   and evidence.** Model output and tool results are untrusted input.
2. **One execution path.** Streaming and non-streaming calls must not become
   separate implementations.
3. **Complete history and model context are different views.** Storage is
   complete; the provider receives a bounded projection.
4. **At-least-once delivery, idempotent consumers.** Do not promise exactly
   once across process or storage boundaries.
5. **No silent degradation.** A run is durably recorded, durably spooled,
   or suspended; it is never acknowledged with missing history.
6. **Measured provider truth beats metadata.** Context size, tool support,
   caching, token limits, and usage must be probed live.
7. **Caching never changes correctness.** A cache miss may affect latency or
   cost only.
8. **Security and governance are acceptance gates in every milestone.**

## Current baseline

Already implemented:

- Config-driven provider/model resolution.
- Canonical `pi-ai` runtime messages at the in-memory provider boundary.
- Conversation budgeting, truncation, tool-result capping, and usage anchor.
- One model/tool transition through `step()`.
- A bounded `run()` loop with canonical event emission and terminal reasons.
- Typed tool registration, argument validation, and parallel dispatch.
- Capability policy plus enforced tool timeout, output, concurrency,
  idempotency, workspace, shell, and HTTP controls.
- Provider retry, active cancellation forwarding, and request timeouts.
- Runtime response conformance checks.
- OpenAI-compatible local-provider registration.
- Local-model sizing and live served-context verification.
- Live Codex/Qwen tool and cross-provider conformance.

Known constraints that shape the plan:

- Built-in tools are implemented and adversarially tested but remain opt-in;
  none are enabled implicitly.
- `ConversationManager` keeps complete loaded history and projects a bounded
  provider window without deleting the transcript.
- B1-B7 now provide explicit schema/repositories, durable journal/outbox,
  attachment ingestion, local embeddings/search, and convergent verified
  erasure, plus machine-readable residency and live recovery evidence.
- Codex cache reporting is verified with a deliberate stable prefix; Qwen's
  zero cache fields remain explicitly unverified rather than inferred.
- Codex's ChatGPT-backed API ignores the configured `maxTokens` value.
- A single Qwen 4B runner at 8192 context fits the 8 GB M3 test host; two
  resident copies can exhaust Metal memory.

## Target ownership boundaries

| Layer | Owns | Must not own |
|---|---|---|
| Context/prompt engine | prompt versions, stable prefix, context projection, cache hints | provider transport, permissions, database writes |
| Harness | provider normalization, invocation, usage, errors, cancellation, conformance | business workflow, RBAC, durable history |
| Model control plane | health, served capabilities, local admission, load/warm state | prompt content, tool policy |
| Agent runtime | bounded loop, event emission, stopping, approval suspension | database handles, user authentication |
| Policy/tool gateway | capabilities, decisions, confinement, execution limits | model routing, UI state |
| Persistence | journal, messages, attachments, search, retention, erasure | model calls, tool execution |
| Server/UI | authentication, RBAC, SSE/HTTP, presentation | provider-specific branches |

## Milestone A0 — freeze the runtime contracts

**Goal:** Make the interfaces that Phases A, B, C, D, E, and G will share
explicit before implementations depend on them.

**Estimated effort:** 2–3 weeks for one experienced engineer.

### A0.1 — canonical run/event envelope

**Status:** Implemented and deterministically verified, 2026-08-10. Runtime
emission remains deliberately deferred to A1.

Add a product-owned, versioned event envelope. Every event contains:

- `schemaVersion`
- `eventId`
- `runId`
- `conversationId`
- monotonic `sequence`
- `turn`
- `occurredAt`
- `type`
- `causationId` and optional `correlationId`
- `audience`: UI, persistence, audit, or operational
- `sensitivity`: content, derived-content, or metadata
- typed payload

Initial event types:

- `run.started`
- `turn.started`
- `message.delta`
- `message.completed`
- `tool.requested`
- `tool.decision`
- `tool.started`
- `tool.completed`
- `approval.requested`
- `approval.resolved`
- `turn.completed`
- `run.completed`
- `run.failed`
- `run.cancelled`

Decide and test these semantics:

- Sequence numbers are unique and increasing within a run.
- Event IDs are stable across journal replay.
- Streaming deltas are ephemeral; completed messages are canonical.
- No completed assistant message is emitted after cancellation or failure.
- Tool arguments/results are content-bearing and excluded from audit/log
  projections.
- Unknown future event versions fail explicitly or pass through a declared
  extension field; they are never silently reinterpreted.

**Files:** new `src/events.ts`, `src/event-projections.ts`, and colocated
tests.

**Acceptance gate A0.1: passed.** Property tests generate complete runs and
prove ordering, JSON serializability, terminal-event uniqueness, ephemeral
delta handling, and schema-driven redaction. Unknown versions and undeclared
fields fail explicitly; version-1 extensions have one declared envelope
location.

### A0.2 — message transport mapping

**Status:** Implemented and deterministically verified, 2026-08-10. The
transport contract is not wired into `step()` or an HTTP server; those remain
A1 and Phase C work respectively.

Define transport-independent interfaces:

- In-process: typed `AsyncIterable<RunEvent>` plus optional event sink.
- Browser delivery: SSE mapping, designed now and implemented in Phase C.
- Browser commands/approvals: authenticated HTTP, not SSE in reverse.
- Durable delivery: Postgres journal/outbox in Phase B.
- External tools: MCP through the same tool registry and policy boundary.

Delivery guarantees:

- In-process delivery is ordered.
- Durable consumers receive at least once and must be idempotent.
- Reconnect uses `eventId`/sequence checkpoints.
- Slow optional observers cannot indefinitely block model/tool execution.
- The durable journal is not an optional observer; it is part of the
  acknowledgement boundary once Phase B is enabled.

Do not add Kafka, NATS, Redis Streams, or WebSockets in this milestone.
Introduce one only after a measured deployment requirement cannot be met by
the in-process stream, Postgres outbox, and SSE.

**Files:** new `src/event-transport.ts` and colocated tests; public exports in
`src/index.ts`.

**Acceptance gate A0.2: passed.** Tests prove ordered single-consumer
`AsyncIterable<RunEvent>` delivery, serialized concurrent publication,
snapshot isolation, fail-closed acknowledgement-boundary sinks, bounded
non-blocking optional observers, explicit observer failure reporting,
eventId/sequence checkpoint validation, and injection-safe SSE encoding and
round-trip parsing. Durable storage, authenticated command endpoints, MCP,
and live browser delivery remain explicitly deferred to their planned phases.

### A0.3 — product message envelope

**Status:** Implemented and deterministically verified, 2026-08-10. Database
storage and load paths remain Phase B work.

Define the versioned message type Phase B will store. It must map from the
current `pi-ai` runtime message without making the dependency type the
database or public API contract.

Required fixtures:

- User text.
- Assistant text and thinking metadata.
- Tool call and tool result.
- Usage and cost.
- Provider extension block.
- Cancelled/failed run metadata with no fabricated assistant message.
- A version-1 fixture that remains readable after a simulated runtime-type
  change.

**Files:** new `src/messages/envelope.ts`, `src/messages/codec.ts`, fixtures,
and tests.

**Acceptance gate A0.3: passed.** The version-1 product contract maps every
current `pi-ai` user, assistant, tool-result, content, provider, diagnostic,
usage, and cost field into validated JSON without making the dependency type
durable. Provider extension blocks require explicit opt-in and remain
content-bearing. Failed and aborted assistant results map to validated run
terminal metadata with usage/cost and no fabricated completed message.
Checked-in version-1 JSON remains readable against a deliberately incompatible
simulated future runtime shape. `message.completed` now requires this envelope,
and audit/operational projections fingerprint or omit its content and provider
extensions without leaking them.

## Milestone A0-P — context, prompt, and caching

**Goal:** Make prompt construction deterministic and establish caching facts
before the agent loop increases prompt size and variability.

**Estimated effort:** 1–2 weeks.

### A0-P.1 — context compiler boundary

**Status:** Implemented and deterministically verified, 2026-08-10. Complete
history remains in memory only until Phase B; cache behavior remains A0-P.2.

Create a context compiler that accepts product inputs and returns one
validated provider context. It owns:

- Versioned system-prompt templates.
- Stable ordering of system instructions and tool definitions.
- Token allocations for fixed overhead, history, retrieved context, current
  input, and output reserve.
- A complete-history input and a bounded provider projection.
- Clear delimiters for untrusted retrieved/tool content.
- A prompt fingerprint that contains hashes and versions, never secret or
  client content.

**Files:** new `src/context/context-compiler.ts`,
`src/context/prompt-layout.ts`, and tests; adapt `ConversationManager` to
delegate projection without changing persistence yet.

**Acceptance gate A0-P.1: passed.** The compiler deterministically versions
and orders system instructions and tools, emits explicit allocations for
fixed overhead/history/retrieval/current input/output reserve, projects an
immutable complete-history input into the provider window, delimits retrieved
and tool-result content as untrusted, validates the final `pi-ai` context, and
returns only versions and SHA-256 hashes in its prompt fingerprint. Tests prove
ordering invariance, bounded projection, tool-call/result integrity, caller
immutability, content-free fingerprints, and fail-closed malformed or
oversized inputs. `ConversationManager` delegates its provider projection to
this compiler while retaining its existing in-memory persistence behavior.

### A0-P.2 — caching conformance script

**Status:** Implemented and verified live against authenticated Codex and
local Qwen, 2026-08-10. Codex cache reads and invalidation were observed;
Qwen cache metrics remain unreported/unverified.

Add `scripts/verify-cache.ts` with a machine-readable result. For each
provider:

1. Build a deterministic stable prefix above 1024 tokens.
2. Send one cold request.
3. Repeat at least five times with an identical prefix and changing suffix.
4. Record cache read/write tokens, prompt/generation latency, total latency,
   cost, and response conformance.
5. Change one system-prompt byte and prove expected invalidation.
6. Reorder tools and prove the deterministic compiler prevents accidental
   invalidation.
7. Exercise truncation/compaction and record the retained cache extent.

Caching is provider-specific configuration behind the harness. The runtime
must behave identically when caching is disabled or unsupported.

**Acceptance gate A0-P.2: passed.** `scripts/verify-cache.ts` emits
content-safe, machine-readable evidence for a cold request, five stable-prefix
requests with changing suffixes, one-byte system invalidation, source tool
reordering, and drop-oldest truncation. It records provider-reconstructed
prompt tokens, cache read/write tokens, input/output/cost, response
conformance, request-to-first-output latency, generation latency, total wall
time, retries, prompt fingerprints, and projection counts. Codex reported a
5,122-token prompt and 4,608 cache-read tokens on four of five warm repeats,
the normalized tool-reorder probe, and the truncated projection; the changed
system byte reported zero cache reads. Qwen reported 7,906 prompt tokens and
valid responses at a separately verified served context of 8,192, but zero
cache fields throughout, so cache retention/invalidation is unverified and no
conclusion is inferred from its much shorter warm timing. Evidence:
`conformance/2026-08-10-cache-codex.json` and
`conformance/2026-08-10-cache-qwen.json`.

**Acceptance gate A0-P:** live, dated evidence exists for authenticated
Codex and local Qwen. Unsupported or unreported cache metrics are recorded
as unsupported/unverified, never inferred from latency alone.

**Current gate state:** passed. A0-P.1, A0-P.2, and A0-P.3 all pass.

### A0-P.3 — truncation strategy decision

**Status:** Implemented and verified deterministically and live against
authenticated Codex and local Qwen, 2026-08-10. Drop-oldest remains the
default; prefix-preserving compaction is available as an evaluated opt-in
candidate.

Keep drop-oldest as the safe baseline until measured otherwise, but add a
second strategy evaluation for prefix-preserving compaction. Compare:

- Context safety.
- Tool call/result integrity.
- Retained factual quality on a fixed evaluation set.
- Cache-hit extent.
- Cost and latency.

Do not ship LLM-generated summarization as invisible truth. If selected,
store the source range, summary model/version, prompt version, and allow
rebuilding it.

**Acceptance gate A0-P.3: passed.**
`src/context/prefix-preserving-compaction.ts` preserves atomic tool exchanges,
keeps a bounded old prefix plus the newest suffix, and replaces only the
omitted middle with a versioned manifest containing source indexes, message
count, and a SHA-256 source hash. The manifest explicitly says it is not a
summary, contains no omitted content, and is rebuildable. Projection counts
distinguish retained source messages from derived manifest messages.

`scripts/verify-truncation.ts` evaluates both strategies on the same fixed
synthetic fact/tool corpus before and after an appended turn. Tests prove
budget safety, caller immutability, tool-call/result integrity, literal fact
availability, deterministic manifest rebuilding, and content-safe evidence.
The candidate retained four of six evaluation facts versus two of six for
drop-oldest and preserved an estimated 1,220-token stable prefix versus 620.
Live calls passed on Codex and Qwen, with Qwen's served context independently
verified at 8,192. Neither target reported non-zero cache fields in this
comparison, so cache improvement is unverified. Codex candidate cost was
0.979x baseline, but aggregate prompt latency was 2.165x; Qwen has zero local
USD cost and candidate prompt latency was 1.240x. Under the predeclared rule
requiring an observed provider cache gain and prompt latency no worse than
2x, the candidate is not selected and the safe drop-oldest default remains.
Evidence: `conformance/2026-08-10-truncation.json`.

## Milestone A0-M — model control plane

**Goal:** Ensure the harness invokes what the deployment can actually serve.

**Estimated effort:** 1–2 weeks.

### A0-M.1 — declared and observed capability records

**Status:** Implemented and deterministically verified, 2026-08-11. Local
runtime inspection, loading/admission, and controller integration are
delivered by A0-M.2 below.

Create a capability record containing both configured and observed values:

- Provider/model/digest/quantization.
- API and transport.
- Declared and served context.
- Output-limit behavior.
- Tool, image, thinking, structured-output, and streaming support.
- Usage/cache reporting.
- Health/readiness and last verification time.

Routing may use only capabilities whose provenance is explicit. A stale live
observation must be visible, not silently treated as current.

**Acceptance gate A0-M.1: passed.**
`src/model-control/capabilities.ts` defines a strict product-owned version-1
record with separate declared and observed sections. Provider/model identity,
digest/quantization, API/transport, declared/served context, output-limit
behavior, tool/image/thinking/structured-output/streaming support, usage/cache
reporting, health/readiness, source provenance, and verification time are
represented explicitly. Runtime parsing rejects unknown fields, invalid
numbers/timestamps, provenance-role confusion, and observed identity drift.
`assessModelRoute()` fails closed for missing, stale/future, unhealthy,
unready, unknown/unsupported, or undersized observations. It is a routing
gate, not a selector: `loadModel()` remains explicit config-key resolution,
and local inspection/admission is layered on it in A0-M.2.

### A0-M.2 — local inference admission

**Status:** Implemented and verified deterministically plus live against
Ollama/Qwen on the 8 GB M3 host, 2026-08-11. vLLM remains deferred until a
target deployment requires it.

Before loading a local model:

- Read actual running models and served contexts.
- Estimate required memory using existing sizing code.
- Reserve deployment headroom.
- Enforce maximum resident models and concurrent sequences.
- Reject or queue work that cannot fit.
- Expose cold/loading/ready/busy/degraded states.
- Prevent duplicate loading that violates memory policy.

Start with an Ollama implementation behind a generic interface. Add vLLM
only when a target deployment needs it.

**Files:** new `src/model-control/` and tests; extend conformance artifacts.

**Acceptance gate A0-M.2: passed.** `LocalModelController` serializes
admission/load decisions, applies A0-M.1's fresh capability gate, inspects the
runtime before and after loading, sizes the requested context at the policy's
maximum concurrent sequences, and preserves both llama.cpp's measured 1 GiB
reserve and an additional deployment headroom allocation. Resident-model and
sequence limits return explicit `rejected` or caller-owned `queued` outcomes;
there is no hidden unbounded queue. Status exposes cold, loading, ready, busy,
and degraded states. Context drift, duplicate identity, malformed runtime
data, failed/missing post-load evidence, and accelerator spill fail closed.

`OllamaRuntimeAdapter` parses `/api/ps`, `/api/show`, and `/api/tags`, and
loads through `/api/generate` with an explicit `num_ctx`. It requires an
authoritative injected memory measurement for admission: a live negative
control showed `node:os.freemem` reporting 187 MB while Ollama Metal discovery
reported 5.3 GiB available, so the unsafe implicit default was removed. The
live verifier then loaded `qwen3:4b` cold at 8,192 context, predicted
3,777,642,091 bytes, observed 3,777,935,441 bytes fully accelerator-resident,
and admitted one sequence. Evidence:
`conformance/2026-08-11-admission.json`.

### A0-M.3 — performance baseline and provisional SLO process

**Status:** Implemented and verified against both supported deployment
profiles, 2026-08-11. Qwen passed its 30-sample profile; Codex produced a
valid failed baseline at 27/30 conformant. No SLO thresholds were established.

Run at least 30 warm samples per supported deployment profile before setting
an SLO. Capture p50/p95:

- Time to first event/token.
- Prompt evaluation throughput.
- Generation throughput.
- Full tool round-trip latency.
- Queue time, model-load time, and provider time separately.

The existing single-run Codex/Qwen measurements are smoke evidence, not an
SLO. Establish thresholds only after the distribution is measured.

**Acceptance gate A0-M.3: passed for the measurement process.**
`src/performance-baseline.ts` validates and aggregates a minimum 30-sample
population with nearest-rank p50/p95. Failed samples affect conformance rate
and the fail-closed profile verdict but are excluded from successful-operation
performance distributions; an all-failed population reports `metrics: null`.
The live verifier records one excluded warm-up, a fixed versioned tool
round-trip workload, requested/configured output caps and whether they are
honored, timing semantics, retries, structural issues, and separate model-load
evidence. Thresholds remain explicitly null.

Qwen/Ollama completed 30/30 conformant at context 8,192 with 52.113/83.279 s
p50/p95 full tool round trip. A separate 30/30 model-load distribution measured
1.932/3.007 s p50/p95 after unloading before every sample, with warm process
and OS file cache; the excluded post-service-start load was 15.687 s and the
earlier fresh admission/preload observation was 19.155 s. Codex completed
27/30 conformant with 11.687/26.200 s p50/p95 over its conformant population
and 40 retries; its overall verdict is fail. Generation throughput is labelled
an end-to-end stream-event estimate because coalesced provider events can
inflate it, and sequential queue measurements are not presented as contention
evidence. Evidence:
`conformance/2026-08-11-performance-qwen.json` and
`conformance/2026-08-11-performance-codex-final.json`, plus
`conformance/2026-08-11-model-load-qwen.json` for the load distribution. The
earlier failed Codex workload remains preserved separately.

## Milestone A1 — streaming step and bounded run loop

**Goal:** Turn the harness into a controlled agent runtime without changing
the one-step public contract.

**Estimated effort:** 1–2 weeks.

### A1.1 — one streaming path

**Status:** Implemented and verified deterministically, 2026-08-11. Live
provider streaming remains a later conformance gate rather than a claim of
this slice.

- Move `step()` internally to `Models.stream()`.
- Forward provider deltas through the event sink.
- Obtain the final message from the same stream's `.result()`.
- Preserve no-sink behavior and existing `StepResult` behavior.
- Validate the completed runtime message before appending it.
- Ensure aborted/error calls emit terminal events and never enter assistant
  history.

**Acceptance gate A1.1: passed.** `step()` now opens one `Models.stream()`
per attempt, forwards its ordered `AssistantMessageEvent` sequence through an
optional acknowledgement sink, and obtains the final `AssistantMessage` from
that same stream's `.result()`. With no sink the public `StepResult` and
caller-owned one-transition behavior are unchanged. The shared retry/result
wrapper keeps timeout, cancellation, retry classification, callback, and
latency semantics aligned with `complete()` without invoking it as a second
provider path. A rejected sink acknowledgement fails closed before history
append, and each delivery is an owned snapshot so sink mutation cannot alter
the provider result. Completed successful messages are runtime-validated
before append; provider `error` and `aborted` terminal events remain visible
and their messages never enter assistant history. Retry-attempt events remain
visible as attempt events; A1.2 must map only the final logical outcome to the
canonical run terminal event.

### A1.2 — `run()` state machine

**Status:** Implemented and deterministically verified, 2026-08-12. Live
provider-stream degradation remains the later conformance gate already noted
under A1.1.

Implement:

```text
run(deps, { maxTurns, signal, deadline, onEvent }) -> RunResult
```

Required behavior:

- `maxTurns` and a finite deadline are required.
- Exactly one terminal reason: stop, maxTurns, cancelled, error,
  needsApproval, or persistenceUnavailable.
- Aggregate usage and latency across turns.
- Cancellation reaches active provider and tool work.
- Repeated tool errors cannot create an unbounded loop.
- A caller can still invoke `step()` directly.

**Files:** new `src/run.ts`; update `src/step.ts`; integration/property tests.

**Acceptance gate A1.2: passed.** `run()` requires a positive `maxTurns`, a
finite absolute deadline, stable conversation/causation identity, and an
acknowledged canonical event sink. It maps text/thinking deltas, validated
completed product messages, tool request/start/completion lifecycles, per-turn
usage and anchored/estimated context budget, and exactly one publishable
logical terminal outcome. Successful runs
stop on a final response, suspend as `needsApproval` with pending calls when no
execution gateway exists, or stop at `maxTurns`; provider failures and
cancellation use the distinct failed/cancelled terminal events. Usage and
provider latency aggregate across turns.

The run deadline and caller signal reach active provider requests and every
tool handler through an optional execution context. Dispatch also races tool
completion against that signal, so an uncooperative handler cannot hold the
runtime open, although only a cooperative handler can guarantee its underlying
side effect actually stops. Required-sink rejection aborts active work and
returns `persistenceUnavailable`; no terminal event is fabricated after the
acknowledgement boundary itself has failed. Repeated tool errors remain bounded
by `maxTurns`. `step()` remains independently public and usable.

## Milestone A2 — policy and tool execution gateway

**Goal:** Make tool execution safe enough for client data and systems.

**Estimated effort:** 2–3 weeks.

### A2.1 — capability declarations and decisions

**Status:** Implemented and deterministically verified, 2026-08-12. Declared
timeouts, output limits, and concurrency cost become enforced controls in
A2.2; this slice deliberately does not claim that enforcement.

Extend tool registrations with:

- Required capabilities such as `fs.read`, `fs.write`, `exec`, and `net`.
- Risk level.
- Timeout and output limit.
- Concurrency cost.
- Side-effect classification and idempotency strategy.

Policy inputs are deployment, authenticated role, workspace, tool
capabilities, and normalized arguments. Policy output is `allow`, `deny`, or
`requireApproval`, with a stable reason code. Conversation text cannot
change policy.

**Files:** new `src/policy.ts`; update `src/tool-registry.ts`.

**Acceptance gate A2.1: passed.** Every `ToolHandler` registration now requires
a runtime-validated, snapshotted declaration of capabilities, risk, timeout,
output limit, concurrency cost, side-effect class, and idempotency strategy.
`CapabilityPolicy` is a pure data-rule evaluator whose only call inputs are
deployment, authenticated role, workspace, the registered tool declaration,
and schema-normalized JSON arguments. No rule match, a missing policy/context,
or equally specific conflicting rules all deny with stable reason codes;
multi-capability decisions combine fail closed (`deny` before
`requireApproval` before `allow`). Unknown input fields are rejected, so
conversation text and tool output have no policy-input field through which to
widen permission.

Dispatch is two phase across a complete model-requested batch: all calls are
normalized and decided, with canonical `tool.decision` events carrying the
governing and complete capability set, before any `tool.started` event or
handler execution. Denial becomes a model-visible error result without
starting the handler. If any sibling requires approval, the whole batch
suspends before all handlers, and `run()` ends as `needsApproval` with only the
pending calls. Deterministic tests cover allow, deny, unconfigured policy,
argument-sensitive rules, ambiguity, multi-capability precedence, lifecycle
ordering, and the mixed allow/approval batch boundary.

### A2.2 — execution controls

**Status:** Implemented and deterministically verified, 2026-08-12. The
protocol-specific primitives are ready for A2.3 built-in tools; no built-in
tool is enabled by this slice.

- Per-tool AbortSignal and deadline.
- Global/per-capability concurrency limits.
- Output-size limits before results enter model context.
- Workspace realpath confinement and symlink-escape protection.
- Shell executable/working-directory/environment policy.
- HTTP scheme, destination, redirect, DNS, and response-size policy.
- Structured redaction of tool arguments/results from operational logs.
- Idempotency keys for side-effecting tools where possible.

**Acceptance gate A2.2: passed.** The dispatcher now derives a per-call
deadline from the registered timeout and the enclosing run deadline, gives
each handler its own abort signal, and returns stable model-visible timeout,
cancellation, capacity, idempotency, and output-limit errors. A shared
process-local controller enforces finite global and per-capability capacity
using declared concurrency cost without hiding an unbounded queue. Capacity
remains held after a timeout until an uncooperative handler actually settles.
Caller-key side effects require a trusted key outside model arguments and
replay a snapshotted result without repeating execution.

`WorkspaceConfinement` canonicalizes the root and candidate with `realpath`,
including existing targets and parents of new targets, so symlink escapes fail.
Shell validation permits only declared executables, confined working
directories, bounded argument vectors, and an explicit environment allowlist;
it never inherits ambient environment implicitly. HTTP validation enforces
scheme/host/port policy, rejects credentials and private destinations by
default, resolves every redirect, pins the validated address for the actual
connection, and bounds both declared and streamed response bytes. Existing
schema-owned event projections provide structured tool argument/result
redaction for operational logs. Deterministic negative tests cover every gate.

### A2.3 — built-in tools

**Status:** Implemented and deterministically verified, 2026-08-12. All tools
are opt-in factories; a new registry remains empty.

Implement in this order:

1. File read and directory listing.
2. Search.
3. File write through staged patch/atomic replacement.
4. Shell execution.
5. HTTP fetch.

No built-in tool is enabled by default. Each tool receives adversarial tests
for path escape, malformed arguments, oversized output, timeout, abort, and
prompt injection in returned content.

**Acceptance gate A2.3: passed.** Confined UTF-8 file read, deterministic
directory listing, literal bounded text search, staged same-directory atomic
file replacement, allowlisted no-shell process execution, and policy-bound
HTTP GET are exported as independent factories. Filesystem operations use the
A2.2 canonical workspace boundary; write requires trusted caller-key
idempotency and supports an expected-content hash conflict gate. Search skips
symlinks and bounds files, file sizes, matches, and line width. Shell passes an
argument vector directly to `spawn` with `shell: false`, a confined cwd, an
explicit environment, cooperative cancellation, and a streaming output cap.
HTTP reuses the DNS-pinned redirect/destination/response gate. Tool result
prompt injection remains returned data and cannot enter the deterministic
policy input. Tests cover every filesystem tool against a symlink escape,
write conflict/idempotency, shell metacharacters without shell interpretation,
HTTP scheme denial, malformed arguments through the shared dispatcher, and
the empty-by-default registry.

## Milestone A3 — approval suspend/resume

**Status:** Implemented and deterministically verified, 2026-08-12. The
controller is process-local until Phase B supplies durable request/resolution
repositories; its request and resolution shapes are persistence-ready now.

**Goal:** Make human approval durable and compatible with HTTP request
boundaries.

**Estimated effort:** 1 week.

- A policy decision can end a run as `needsApproval`.
- The result contains normalized pending calls and capability decisions.
- Resume accepts signed/authorized decisions, not conversational text.
- Approval is bound to run ID, tool call ID, arguments hash, capability, and
  expiry.
- Changed arguments invalidate approval.
- Denial returns an untrusted-visible tool result the model can react to.
- Duplicate resume requests are idempotent.

The initial product decision should be approval per call. Conversation-wide
or remembered approvals remain out of scope until the Phase D UX and threat
model justify them.

**Acceptance gate A3: passed.** Policy-driven suspension now produces a
versioned approval request bound to run and conversation identity, normalized
tool call, canonical arguments SHA-256, governing and complete capability set,
reason code, request time, and expiry. `run()` acknowledges
`approval.requested` before its terminal `needsApproval` event and returns the
owned request alongside pending calls. Resume requires an injected authority
to verify an opaque signed/session-bound submission; unknown conversational
fields are rejected and never become authorization input. The supplied run
and conversation must match the request, changed arguments and expired
requests fail closed, and `approval.resolved` acknowledgement precedes any
execution.

An approved call re-enters the current registry, argument validator, complete
capability declaration, A2.2 execution controller, and trusted idempotency
path. A capability added after suspension therefore has no matching approval
rule and denies. Denial produces an untrusted-visible error result without
starting the handler. Duplicate identical resumes return the same owned result
without executing or appending twice; a conflicting second decision fails.
Tests cover binding changes, expiry, unauthorized and extra-field submissions,
resolution-journal failure, denial, duplicate approval, and conflicting
resume.

## Milestone A4 — MCP integration

**Status:** Implemented and deterministically verified, 2026-08-12. The
official MCP TypeScript SDK v1 is isolated behind a narrow client port; the
transport-independent admission core and confined stdio transport are both
covered by malicious-server integration tests.

**Goal:** Admit external tools without creating a second security path.

**Estimated effort:** 1–2 weeks.

- Use the official MCP SDK behind `src/mcp/`.
- Normalize MCP tools into `ToolRegistry`.
- Assign per-server capability ceilings.
- Treat names, descriptions, schemas, and results as untrusted.
- Apply identical validation, policy, approval, timeouts, limits, and audit
  events as built-in tools.
- Pin server identity/configuration and expose connection health.
- Test malicious descriptions, schema changes, disconnects, and oversized
  results.

**Acceptance gate A4: passed.** Configured servers are admitted through the
official SDK and pinned by server name/version. Paginated discovery is bounded
and cycle-safe; only deployment-configured remote tools are registered. Remote
names, descriptions, input schemas, and output schemas are fingerprinted,
while only deployment-owned local names and descriptions enter the model
prompt. Per-server capability ceilings are checked before registration, and
registration is atomic so a later invalid declaration cannot leave an earlier
tool active.

Every admitted handler enters the same `ToolRegistry`, schema validator,
capability policy, approval path, execution controller, lifecycle callbacks,
and result-size boundary as a built-in tool. Unsupported MCP content remains
explicitly marked untrusted JSON rather than being dropped. Connection health
is exposed as ready/degraded/closed. The stdio connector reuses A2.2's
executable, argument, workspace, and explicit-environment policy and sets a
finite protocol buffer. Deterministic tests cover malicious server
instructions/descriptions, identity and input/output-schema drift, extra and
duplicate tools, cursor cycles, malformed arguments, disconnects, oversized
results, capability-ceiling escape, atomic registration failure, a real
confined stdio round trip, and an empty-by-default registry.

**Phase A gate:** all A.1 definition-of-done items pass, including live
streaming against Codex and Qwen, cancellation, policy bypass attempts,
approval resume, and audience-redaction tests.

## Milestone B0 — persistence prerequisites

**Status:** Accepted and recorded, 2026-08-12, in
`phaseB/adrs/B0-persistence-prerequisites.md`.

**Goal:** Freeze deployment decisions that affect every storage interface.

**Estimated effort:** 2–4 days.

Decide and record:

- Supported Postgres major version.
- Migration tool.
- Default attachment backend: local disk or client-run S3-compatible store.
- Encryption/key-management boundary.
- Backup/restore expectations and recovery objectives.
- Single-tenant schema now; explicit trigger for revisiting multi-tenancy.
- Local embedding runtime/model and version.

Do not start schema implementation until these decisions are explicit.

**Acceptance gate B0: passed.** PostgreSQL 18.x/pgvector 0.8.6, dbmate
v2.35.0 plain-SQL migrations, local-disk attachment default, deployment-owned
encryption/key boundary, 15-minute RPO and 4-hour RTO with quarterly restore
proof, the single-tenant revisit trigger, and Ollama v0.32.5 with
`nomic-embed-text:v1.5` at 768 dimensions are explicit. The embedding model's
full local digest and availability remain honestly deferred to B5.

## Milestone B1 — schema, codecs, and repositories

**Status:** Accepted and verified, 2026-08-19.

**Goal:** Persist complete product-owned history with readable SQL.

**Estimated effort:** 2 weeks.

Tables initially include:

- users
- conversations
- runs and turns
- messages
- tool calls and tool decisions
- approvals
- attachments
- event journal
- outbox jobs and consumer checkpoints
- retention/erasure jobs

Requirements:

- Explicit SQL migrations from the first table.
- `(conversation_id, seq)` uniqueness.
- Product message schema version on every message.
- Append-only messages; revisions point backward with `supersedes_id`.
- Validation at the write boundary.
- No raw provider payload by default.
- Metadata-only audit projection.

**Files:** new `src/storage/migrations/`, `src/storage/repositories/`, and
integration tests using a real disposable Postgres instance.

**Acceptance gate B1: passed.** Pinned dbmate v2.35.0 applied the initial
migration to a fresh PostgreSQL 18.6 + pgvector 0.8.6 database. The schema
covers every table listed above, message writes validate the product envelope,
database triggers reject in-place message updates and enforce backward-only
same-conversation supersession, and the current-message view hides superseded
rows. Explicit repositories and a node-postgres adapter passed live tests for
messages, tools/decisions, approvals, attachments, atomic journal/audit writes,
outbox idempotency, checkpoints, and five-store erasure jobs. The full suite
passed 387/387 with the integration database enabled; typecheck and migration
checksum verification passed. Pinned dbmate has no `--strict` flag, so applied
migration immutability is test-enforced through a SHA-256 manifest instead.

## Milestone B2 — complete history and provider projection

**Status:** Implemented and deterministically verified, 2026-08-21.

**Goal:** Separate durable conversation history from bounded model context.

**Estimated effort:** 1–2 weeks.

- Refactor `ConversationManager` so append does not delete durable history.
- Build provider context as a projection for each call.
- Store usage required to rebuild the latest valid token anchor.
- Rebuild the anchor only when the entire anchored prefix is loaded.
- Expose `anchored` versus `estimated` after reload.
- Test long conversations, partial loads, superseded messages, and tool-pair
  integrity.

**Acceptance gate B2: passed.** `ConversationManager.append()` no longer
deletes history. `getContext()` and `compileContext()` use a bounded provider
projection, `getHistory()` remains complete, current messages can be loaded
through `MessageRepository`, full-prefix reloads rebuild the latest usable
1.8 anchor, partial loads report `estimated`, and tests cover long-history
projection, superseded/current reload semantics, anchor tightening/loosening,
tool-pair integrity, and provider budget invariants. The deterministic suite
passed 392/392 with the storage integration skipped; the live integration
then passed separately on PostgreSQL 18.6 + pgvector 0.8.6 after the pinned
dbmate 2.35.0 migration, and typecheck plus diff checks passed.

## Milestone B3 — durable journal and outbox

**Status:** Implemented and verified, 2026-08-21. Deterministic, live
PostgreSQL, and literal process-kill gates pass.

**Goal:** Make persistence part of the acknowledgement contract.

**Estimated effort:** 1–2 weeks.

- Append run transitions to the journal before acknowledging them.
- Insert journal records and outbox jobs in one Postgres transaction.
- Consumers update checkpoints idempotently.
- Replays tolerate duplicates and process restarts.
- Database outage yields encrypted bounded spool or
  `persistenceUnavailable`.
- Spool replay preserves event IDs and ordering.
- Backpressure is explicit when journal/spool capacity is exhausted.

Fault-injection tests kill the process between every journal, outbox,
consumer, and acknowledgement boundary.

**Implementation result:** `EventJournalRepository.appendWithOutbox()` uses
one PostgreSQL statement to insert the journal event, metadata-only audit
projection, and `journal.event.appended` outbox job. Duplicate event IDs are
idempotent. `DurableJournalSink` is a required event sink. It replays older
spooled events before it writes a new event. It acknowledges a database
outage only after an AES-256-GCM spool write is synced to disk. The spool has
explicit entry and byte limits, deterministic event identities, authenticated
decryption, and per-run sequence replay. It rejects full or corrupt storage.

`JournalConsumer` reads after a durable journal sequence and advances its
checkpoint only after its handler completes. Delivery IDs are event IDs, so
a consumer can make repeated delivery idempotent. Tests inject failure after
an ambiguous database commit, after replay commit but before spool deletion,
and after a consumer side effect but before checkpoint commit. Replays keep
one journal row, retain the original event ID, and complete after restart.

**Acceptance gate B3: passed.** Pinned dbmate 2.35.0 applied the migration to
PostgreSQL 18.6 with pgvector 0.8.6. The live suite passed 404/404. It proves
that journal, audit, and outbox rows commit together, and that duplicate replay
creates no second row. Literal process termination tests prove rollback or
idempotent recovery at the journal/outbox, acknowledgement, spool deletion,
consumer side-effect, and checkpoint boundaries. Typecheck and diff checks
pass.

## Milestone B4 — attachments and ingestion

**Goal:** Store and process files without breaking residency or tool policy.

**Estimated effort:** 1 week.

- Content-addressed attachment IDs and integrity hashes.
- MIME/type and size validation.
- Quarantine/staging before parsing.
- Cleanup of temporary files.
- Access checks at every read, not only upload.
- Backend abstraction for local disk and S3-compatible storage.
- Attachment deletion jobs integrated with the outbox.

Archive extraction, document parsers, and image processing must use
maintained libraries, resource limits, and path-traversal protections.

**Acceptance gate B4: passed.** `AttachmentService` now creates
content-bound IDs and immutable SHA-256 object keys, stages bytes on a
deployment-owned volume, enforces streaming size and MIME checks, removes
temporary files on every exit path, and checks access before every existing
attachment read. Local-disk and S3-compatible object stores share one
interface and verify size plus digest on reads. Parser adapters must declare
their library/version, and the processing boundary enforces output, archive,
compression-ratio, and relative-path limits. Deletion first tombstones the
row and enqueues a metadata-only outbox job in one SQL statement; the worker
deletes the object idempotently before marking the row deleted.

Adversarial tests cover excess streams, MIME mismatch, invalid IDs, temporary
cleanup, message/conversation binding, unauthorized reads, tampering,
traversal, symlink substitution, S3 checksum/precondition metadata, parser
output paths, and deletion replay.
Pinned dbmate 2.35.0 applied the schema to PostgreSQL 18.6 with pgvector 0.8.6,
and the complete live suite passed 414/414. Typecheck and diff checks pass.

## Milestone B5 — local embeddings and search

**Status:** Accepted and verified, 2026-08-21.

**Goal:** Make organizational knowledge searchable without leaving the
client boundary.

**Estimated effort:** 1–2 weeks.

- Local embedding model with pinned version/digest.
- Chunk records linked to source and access policy.
- pgvector schema and index.
- Hybrid lexical/vector query interface if measurement justifies it.
- Access-control filtering before candidates reach the model.
- Citation/source identifiers returned with retrieved content.
- Retrieval quality fixture set and regression metrics.
- Air-gapped test proving hosted embedding endpoints cannot be selected.

**Implementation result:** `src/search/embeddings.ts` accepts only local
embedding providers, requires the full `sha256:` model digest, rejects
hosted endpoints, computes a stable manifest digest, and validates finite
fixed-dimension vector parameters. The storage schema now includes
`embedding_models`, `knowledge_sources`, `knowledge_chunks`, and
`chunk_embeddings`; chunks carry source, citation, content hash, and JSON
access policy, while embeddings use pgvector with a 768-dimension HNSW cosine
index. Lexical search is measured through a generated `tsvector` and GIN
index rather than guessed outside the database.

`KnowledgeSearchRepository` registers pinned manifests, writes source-linked
chunks, and searches with access filtering in the SQL `WHERE` clause before
the bounded result set is returned to the model. Results include citation and
source identifiers. `src/search/retrieval.ts` adds quality-fixture metrics
for hit@k and mean reciprocal rank.

**Acceptance gate B5: passed.** Deterministic tests cover full local digest
enforcement, hosted-endpoint rejection, vector dimension/numeric validation,
quality metrics, parameterized chunk writes, citation returns,
access-filtered SQL, migration tables/indexes, and checksum immutability.
`npm run verify:embeddings` pulled and verified local Ollama 0.32.5 with
`nomic-embed-text:v1.5`, digest
`sha256:0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f`,
768 dimensions, embedding capability, and a real `search_query:` probe.
The machine-readable evidence is
`conformance/2026-08-21-embedding-nomic-local.json`.

Pinned dbmate 2.35.0 applied the checked-in migration to a disposable
PostgreSQL 18.6 + pgvector 0.8.6 database. The live B1-B5 storage integration
passed with embedding manifest registration, source/chunk/vector insert,
unauthorized search exclusion, authorized citation return, and the prior
history/journal/attachment checks. The B3 process-kill integration passed
when run separately on the clean migrated database. `npm run typecheck`,
`npm test`, and `git diff --check` passed.

## Milestone B6 — retention and verified erasure

**Status:** Implemented and verified, 2026-08-21. Conversation, logical
message-revision, and user scopes tombstone immediately; a deferred database
guard rejects a write transaction that began before the tombstone; and an
ordered seven-store coordinator requires retrieval-side absence twice before
completion.

**Goal:** Delete content from every location where it can be retrieved.

**Estimated effort:** 1–2 weeks.

Erasure flow:

1. Transactionally tombstone the content and enqueue deletion jobs.
2. Immediately filter tombstoned content from every read/search path.
3. Idempotently delete attachments, embeddings, index entries, cache
   records, temporary derivatives, and optional provider payloads.
4. Reconcile every store.
5. Mark complete only after retrieval-side verification cannot find the
   content.

Audit retains identifiers, actor, action, time, model, and outcome—never the
erased content.

**Acceptance gate B6: passed.** The immutable follow-on dbmate migration adds
subject tombstones, stable message/conversation/attachment/knowledge scopes,
filtered message and journal views, and deferred commit-time write guards.
Every deployment must provide exactly one adapter for attachments, embeddings,
search, cache, temporary derivatives, provider payloads, and PostgreSQL.
Adapters delete idempotently in dependency order; PostgreSQL runs last; and a
second reconciliation pass blocks completion if any public retrieval path
finds residue. Live PostgreSQL 18.6/pgvector 0.8.6 tests proved conversation,
message-revision, and user erasure, object/vector/search removal, audit-content
redaction, duplicate-request idempotency, sibling-history preservation, and
the concurrent late-write negative control.

## Milestone B7 — residency, recovery, and operational proof

**Status:** Implemented and verified, 2026-08-21.

**Goal:** Prove the sovereignty claim under normal and failure conditions.

**Estimated effort:** 1 week.

- Machine-readable residency inventory for database, object storage,
  embeddings, indexes, logs, caches, temp files, backups, and telemetry.
- Log-content tests with canary prompt/tool values.
- Backup/restore drill that preserves append ordering and schema versions.
- Database outage/spool/replay drill.
- Search-after-erasure test.
- Air-gapped egress test.
- Migration forward and rollback/recovery test.
- Interrupted stream stores terminal run metadata and no completed assistant
  message.

**Implementation result:** `phaseB/residency-inventory.v1.json` enumerates all
nine data locations and freezes metadata-only logs/telemetry, a 35-day backup
expiry baseline, isolated restore/reconciliation, and explicit
vacuum/reindex/cryptographic-erasure boundaries. `src/residency.ts` validates
that inventory, serializes only the allowlisted operational event projection,
and provides an exact-origin, no-redirect air-gapped fetch boundary.
`RunHistoryProjector` idempotently materializes run, turn, completed-message,
and terminal state from journal deliveries; interrupted deltas remain
ephemeral and cannot become a completed assistant message.

`npm run verify:residency` is the destructive-scope-guarded operational drill.
It requires two explicitly prefixed disposable databases, performs a real
custom-format backup/restore, verifies append order and table/envelope schema
versions, runs pinned dbmate down/up recovery, and executes the outage-spool,
search-after-erasure, air-gap, log-canary, and interrupted-stream gates. Its
dated report contains environment versions and a backup archive digest but no
database credentials or client content.

**Acceptance gate B7: passed.** The complete verifier passed on PostgreSQL
18.6, pgvector 0.8.6, and dbmate 2.35.0. Machine-readable evidence is in
`conformance/2026-08-21-residency-recovery.json`. The full deterministic suite
then discovered 443 tests: 437 passed and six isolated database/process tests
skipped without `STORAGE_TEST_DATABASE_URL`; typecheck and `git diff --check`
passed.

**Phase B gate: passed.** Complete history survives restore, provider context
projection remains bounded, every acknowledged durable transition has a
journal/spool recovery path, and B6/B7 retrieval checks prove erased content is
absent from active retrieval paths. Historical backups expire by policy; page
reclamation is not misrepresented as immediate forensic overwrite.

## Continuous workstream E — conformance and evaluation

This runs beside every milestone rather than waiting for roadmap Phase E.

Maintain dated machine-readable artifacts for:

- Provider/tool/streaming conformance.
- Served context and output-limit behavior.
- Prompt caching.
- Structured output.
- Cancellation and timeout behavior.
- Local load/admission and memory pressure.
- Latency, throughput, queue time, and cost.
- Prompt-injection and permission-bypass attempts.
- Retrieval quality and citation correctness.
- Persistence recovery and erasure.

CI runs deterministic tests. Live/provider/hardware suites run separately,
identify their environment, and never report a skipped credential or
unavailable service as a pass.

## Continuous workstream S — security and threat modelling

At each milestone:

- Update the data-flow and trust-boundary diagram.
- Enumerate attacker-controlled fields.
- Verify least privilege and deny-by-default behavior.
- Add a regression for every discovered bypass.
- Confirm logs, traces, and errors contain no client content by default.
- Confirm secret values are referenced, rotated, and never stored in tracked
  configuration.
- Review dependency provenance, versions, and update policy.

Minimum threat scenarios include indirect prompt injection, malicious MCP
descriptions, symlink escape, SSRF, shell argument injection, tool-result
poisoning, approval replay, event forgery, cross-user access, data leakage
through embeddings/logs/caches, and incomplete erasure.

## Verification matrix

| Level | Purpose | Examples |
|---|---|---|
| Unit | Pure contract and policy behavior | codecs, projection, redaction, decisions |
| Property | Invariants across generated sequences | event ordering, budget, no orphan tool results |
| Integration | Real boundaries | Postgres, filesystem, Ollama, MCP test server |
| Fault injection | Recovery semantics | abort, timeout, DB loss, process death, duplicate delivery |
| Adversarial | Security boundaries | traversal, SSRF, injection, approval replay |
| Live conformance | Provider truth | Codex/Qwen streaming, caching, tools, usage |
| Soak/performance | Operational limits | long runs, queueing, memory pressure, p95 latency |

Every milestone requires:

- Typecheck and deterministic tests green.
- New public inputs validated at runtime.
- At least one negative test proving the failure gate actually fails.
- Documentation updated with verified/unverified labels.
- No unrelated worktree changes or secrets in Git.

## Suggested repository layout

```text
src/
  context/
    context-compiler.ts
    prompt-layout.ts
  messages/
    envelope.ts
    codec.ts
  model-control/
    capabilities.ts
    controller.ts
    ollama.ts
  events.ts
  event-projections.ts
  run.ts
  policy.ts
  tools/
    filesystem.ts
    search.ts
    shell.ts
    http.ts
  mcp/
    client.ts
    registry-adapter.ts
  storage/
    migrations/
    repositories/
    journal.ts
    outbox.ts
    spool.ts
    attachments.ts
    embeddings.ts
    erasure.ts
scripts/
  verify-cache.ts
  verify-streaming.ts
  verify-recovery.ts
  verify-erasure.ts
conformance/
  YYYY-MM-DD-*.json
```

This is a direction, not a requirement to create empty directories before
their milestone begins.

## Critical-path ordering and parallelism

```text
A0.1 events ───────────────┐
A0.3 message envelope ─────┼─> A1 run loop ─> A2 policy/tools ─> A3 approval ─> A4 MCP
A0-P context/cache ────────┤
A0-M model control ────────┘

A0.1 + A0.3 ─> B1 schema ─> B2 projection ─> B3 journal/outbox
                                      ├──────> B4 attachments
                                      └──────> B5 search ─> B6 erasure ─> B7 proof
```

A0-P and A0-M can run in parallel after the envelope names are stable. Phase
B schema work may begin once the event and message envelopes are frozen, but
durable acknowledgement integration waits for the Phase A run-state machine.

## Effort and release checkpoints

For one experienced engineer, with review and QA included:

| Checkpoint | Approximate effort | Demonstrable result |
|---|---:|---|
| A0 contracts/context/model control | 4–6 weeks | stable contracts, cache evidence, truthful local admission |
| Phase A runtime/policy/approval/MCP | 5–8 weeks | controlled streaming agent capable of safe work |
| Phase B persistence/residency | 7–10 weeks | durable, searchable, recoverable, erasable history |
| Total sequential | 16–24 weeks | Phase A+B foundation ready for server/UI work |

These are planning ranges, not commitments. Attachment formats, embedding
quality, deployment encryption, and approval UX can expand them. Two
engineers can parallelize A0-P/A0-M and B4/B5, but the event/message contracts
and durability boundary need one accountable owner.

Release checkpoints:

1. **Developer preview:** A0 + A1, no side-effecting tools.
2. **Controlled-agent alpha:** A2 + A3, built-in tools behind approvals.
3. **Integration alpha:** A4, MCP through identical policy controls.
4. **Durable alpha:** B1–B3, restart/replay proven.
5. **Sovereign knowledge beta:** B4–B5, attachments and local search.
6. **Compliance-ready beta:** B6–B7, erasure/residency/recovery evidence.

## Explicitly deferred

Do not place these on the critical path before Phase A/B gates pass:

- Semantic response caching.
- Automatic provider fallback or opaque model routing.
- Long-running autonomous “work until done” execution.
- Sub-agents and delegation.
- Multi-tenant database architecture.
- Kafka/NATS/Redis messaging.
- Collaborative WebSockets.
- Fine-tuning and LoRA workflows.
- Hosted embedding fallback in sovereign deployments.

Each can change cost, privacy, failure semantics, or authority. Add one only
through an ADR and a failing conformance test that demonstrates the need.

## First implementation slice

The first pull request should be intentionally narrow:

1. Add the versioned `RunEvent` envelope and typed event union.
2. Add UI/persistence/audit/log projections.
3. Add JSON-serializability, ordering, terminal-event, and redaction tests.
4. Add no runtime loop and no transport infrastructure yet.

That slice establishes the contract all subsequent work uses while remaining
small enough for adversarial review before it becomes expensive to change.
