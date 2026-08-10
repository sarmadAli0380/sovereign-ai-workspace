# Implementation plan — harness perimeter through Phase B

**Status:** Proposed execution plan, 2026-08-06
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
- Typed tool registration, argument validation, and parallel dispatch.
- Provider retry, active cancellation forwarding, and request timeouts.
- Runtime response conformance checks.
- OpenAI-compatible local-provider registration.
- Local-model sizing and live served-context verification.
- Live Codex/Qwen tool and cross-provider conformance.

Known constraints that shape the plan:

- `step()` is not streaming internally and there is no bounded `run()` loop.
- Tool handlers do not yet declare capabilities, timeouts, or concurrency
  costs.
- `ConversationManager` still discards messages when projecting to the
  model window.
- There is no durable journal, database schema, attachment store, or search.
- Prompt-cache accounting is implemented but has not been exercised with a
  deliberate stable prefix above the provider's cache threshold.
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
emission and transport remain deliberately deferred to A1 and A0.2.

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

### A0.3 — product message envelope

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

## Milestone A0-P — context, prompt, and caching

**Goal:** Make prompt construction deterministic and establish caching facts
before the agent loop increases prompt size and variability.

**Estimated effort:** 1–2 weeks.

### A0-P.1 — context compiler boundary

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

### A0-P.2 — caching conformance script

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

**Acceptance gate A0-P:** live, dated evidence exists for authenticated
Codex and local Qwen. Unsupported or unreported cache metrics are recorded
as unsupported/unverified, never inferred from latency alone.

### A0-P.3 — truncation strategy decision

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

## Milestone A0-M — model control plane

**Goal:** Ensure the harness invokes what the deployment can actually serve.

**Estimated effort:** 1–2 weeks.

### A0-M.1 — declared and observed capability records

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

### A0-M.2 — local inference admission

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

### A0-M.3 — performance baseline and provisional SLO process

Run at least 30 warm samples per supported deployment profile before setting
an SLO. Capture p50/p95:

- Time to first event/token.
- Prompt evaluation throughput.
- Generation throughput.
- Full tool round-trip latency.
- Queue time, model-load time, and provider time separately.

The existing single-run Codex/Qwen measurements are smoke evidence, not an
SLO. Establish thresholds only after the distribution is measured.

## Milestone A1 — streaming step and bounded run loop

**Goal:** Turn the harness into a controlled agent runtime without changing
the one-step public contract.

**Estimated effort:** 1–2 weeks.

### A1.1 — one streaming path

- Move `step()` internally to `Models.stream()`.
- Forward provider deltas through the event sink.
- Obtain the final message from the same stream's `.result()`.
- Preserve no-sink behavior and existing `StepResult` behavior.
- Validate the completed runtime message before appending it.
- Ensure aborted/error calls emit terminal events and never enter assistant
  history.

### A1.2 — `run()` state machine

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

## Milestone A2 — policy and tool execution gateway

**Goal:** Make tool execution safe enough for client data and systems.

**Estimated effort:** 2–3 weeks.

### A2.1 — capability declarations and decisions

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

### A2.2 — execution controls

- Per-tool AbortSignal and deadline.
- Global/per-capability concurrency limits.
- Output-size limits before results enter model context.
- Workspace realpath confinement and symlink-escape protection.
- Shell executable/working-directory/environment policy.
- HTTP scheme, destination, redirect, DNS, and response-size policy.
- Structured redaction of tool arguments/results from operational logs.
- Idempotency keys for side-effecting tools where possible.

### A2.3 — built-in tools

Implement in this order:

1. File read and directory listing.
2. Search.
3. File write through staged patch/atomic replacement.
4. Shell execution.
5. HTTP fetch.

No built-in tool is enabled by default. Each tool receives adversarial tests
for path escape, malformed arguments, oversized output, timeout, abort, and
prompt injection in returned content.

## Milestone A3 — approval suspend/resume

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

## Milestone A4 — MCP integration

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

**Phase A gate:** all A.1 definition-of-done items pass, including live
streaming against Codex and Qwen, cancellation, policy bypass attempts,
approval resume, and audience-redaction tests.

## Milestone B0 — persistence prerequisites

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

## Milestone B1 — schema, codecs, and repositories

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

## Milestone B2 — complete history and provider projection

**Goal:** Separate durable conversation history from bounded model context.

**Estimated effort:** 1–2 weeks.

- Refactor `ConversationManager` so append does not delete durable history.
- Build provider context as a projection for each call.
- Store usage required to rebuild the latest valid token anchor.
- Rebuild the anchor only when the entire anchored prefix is loaded.
- Expose `anchored` versus `estimated` after reload.
- Test long conversations, partial loads, superseded messages, and tool-pair
  integrity.

## Milestone B3 — durable journal and outbox

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

## Milestone B5 — local embeddings and search

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

## Milestone B6 — retention and verified erasure

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

## Milestone B7 — residency, recovery, and operational proof

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

**Phase B gate:** complete history survives restart, context projection stays
within budget, every acknowledged transition is recoverable, and erased
content is absent from all retrieval paths.

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
