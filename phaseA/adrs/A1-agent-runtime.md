# A.1 — The agent runtime

**Status:** Designed; A1.1, A1.2, and A2.1 implemented and deterministically
verified (2026-08-12), later Phase A slices remain pre-implementation
**Depends on:** ADR-003 (the deliverable is a product), 1.5, 1.6, 1.7
(`step()`), 1.8 (budget anchoring)
**Feeds:** B (persistence subscribes to the event stream), C (the server
exposes it), D (the UI renders it), G (audit consumes tool events)

## How to read this document

Same convention as 2.4/2.5/1.8. **[VERIFIED]** means checked against the
installed package with the evidence inline. **[UNVERIFIED]** means believed,
not proven — treat as risk. An unmarked statement is a decision.

Written after checking `pi-ai` rather than assuming it, because this
project's ADRs have been wrong about `pi-ai` five times and every one cost
implementation time.

## What Phase A is

Turning a model call into something that can do work: a loop, a tool suite,
MCP, and a stream of events a UI can render. It is the first phase where
this stops being a library.

It also reverses 1.7's "no agent loop" decision, per ADR-003 — that was
correct for a library and wrong for a product.

## What `pi-ai` already gives us

**[VERIFIED]** `Models.complete()` is *literally* `stream().result()`:

```js
// node_modules/@earendil-works/pi-ai/dist/models.js:270
async complete(model, context, options) {
    return this.stream(model, context, options).result();
}
```

**[VERIFIED]** `AssistantMessageEventStream` is both async-iterable **and**
carries `.result(): Promise<AssistantMessage>` (`utils/event-stream.d.ts`).
So one call yields streaming events *and* the final message.

**[VERIFIED]** The event protocol is already rich (`types.d.ts:365`):
`start`, `text_start` / `text_delta` / `text_end`, `thinking_start` /
`thinking_delta` / `thinking_end`, `toolcall_start` / `toolcall_delta` /
`toolcall_end`, terminating in `done` or `error`. Every event carries
`partial: AssistantMessage`.

**[VERIFIED]** `signal?: AbortSignal` is on the stream options.

**[VERIFIED]** There is **no MCP support**. The only `mcp` string in the
package is an OAuth scope (`user:mcp_servers`) in Anthropic's auth flow.
The MCP client is ours to build.

## Decision 1 — one code path, not a streaming twin

Since `complete()` *is* `stream().result()`, a `streamStep()` alongside
`step()` would be two paths through identical provider behaviour.

**Decision: `step()` moves to `stream()` internally and takes an optional
event sink.** With no sink it behaves exactly as today; with one it forwards
events as they arrive. `complete()` stays as the non-streaming convenience
wrapper for callers who want one call and one message.

The reasoning is this project's own history rather than elegance: the
adversarial QA passes found defects concentrated wherever two paths were
meant to behave identically. A second streaming path would be a standing
invitation to that class of bug, and `pi-ai` has already collapsed it for
us.

## Decision 2 — `run()` wraps `step()`; `step()` does not change shape

`step()` stays exactly one transition (1.7). `run()` is the loop:

```
run(deps, { conversationId, causationId, maxTurns, deadline, signal, onEvent }) → RunResult
```

It owns only what a loop owns — identity, the turn counter, the stopping rule,
cancellation/deadline, aggregate usage/latency, and event emission. It adds no
autonomy the caller did not ask for: `maxTurns` and a finite deadline are
required, not defaulted to something generous.

**`step()` remains public and usable alone.** An application that wants one
model call with no loop still gets it — that part of 1.7's "subtraction"
argument survives ADR-003 intact.

## Decision 3 — the event protocol is the runtime's only output

The server, the UI, the persistence layer and the audit log all consume the
same stream. Nothing reaches into the runtime's internals.

The A0 product protocol supersedes the earlier provider-shaped sketch. The
runtime now emits `run.started`, `turn.started`, ephemeral `message.delta`,
versioned `message.completed`, tool lifecycle events, `turn.completed`, and
exactly one of `run.completed`, `run.failed`, or `run.cancelled`. The envelope
carries run/conversation identity, sequence, turn, causation, audience, and
sensitivity. `step()` can still expose every raw pi-ai attempt event directly;
`run()` maps only renderable text/thinking deltas and the final validated
logical outcome into the provider-independent product protocol. In particular,
a retry attempt's raw `error` is not a terminal run event when a later attempt
succeeds.

`RunResult.reason` is one of `stop` | `maxTurns` | `cancelled` | `error` |
`needsApproval` | `persistenceUnavailable`. Publishable runs end in exactly
one `run.completed`, `run.failed`, or `run.cancelled` event. A failed required
journal acknowledgement returns `persistenceUnavailable` without pretending a
terminal event reached that failed boundary. **Every event must be
JSON-serializable**, because it goes
over SSE to a browser and into Postgres for replay. That constraint is
stated now because retrofitting serializability is painful.

`turn_end` carries `budget` — the `BudgetUsage` from 1.8, including whether
the number is `anchored` or `estimated`. The UI can then show real context
consumption rather than a guess, which is a genuine product feature that
falls out of work already done.

### Event audiences and redaction

"One stream" means one causal protocol, not one unrestricted payload copied
unchanged to every destination. The events are projected by audience:

| audience | content policy |
|---|---|
| live UI | content needed to render the current authorized conversation |
| conversation persistence | complete message content under the conversation's retention policy |
| audit | identifiers, capability decision, timing, model, usage, and outcome only |
| application logs/metrics | operational metadata only; no prompt, completion, tool arguments, or tool results |

`tool_start.arguments` is content-bearing. It may be present in the
authorized UI/persistence projection, but the audit projection stores only
an argument hash and size unless a deployment explicitly defines a stricter
regulated audit requirement. Redaction is schema-driven and tested; it is
not a best-effort logging filter applied after serialization.

## Decision 4 — the model proposes, the policy disposes

The security model, and the part that matters most for a product that runs
inside a client's network with access to their data.

**The model may request any tool. Whether it runs is decided by code and
configuration the model cannot influence.**

Its corollary is the one that is easy to get wrong: **tool results are
untrusted input.** A document the agent reads, a web page it fetches, or an
MCP server's own tool description may contain text aimed at the model. So
nothing in a tool result — and nothing in model output — may widen
permissions, approve an action, or alter policy. Approval decisions come
from a human or from configuration, never from the conversation.

Five mechanisms:

**(a) Capabilities, not tool names.** Each tool declares what it needs:
`fs.read`, `fs.write`, `exec`, `net`. Policy is written against
capabilities. Name-based allowlists are the same mistake as provider names
in control flow — they don't compose and they rot.

Implemented in A2.1: a registration also declares risk, timeout, output limit,
concurrency cost, side-effect class, and idempotency strategy. Registration
validates and snapshots this control metadata. A2.2 now enforces the declared
timeout/output/concurrency controls and trusted caller-key idempotency.

**(b) Policy evaluated before `execute()`.** Per deployment and per role:
`allow` | `deny` | `requireApproval` for each capability. The decision is
recorded as its own canonical `tool.decision` event before `tool.started`, so
the audit log receives the governing capability, complete capability set,
decision, and stable reason code. The data-rule evaluator accepts deployment,
authenticated role, workspace, registered controls, and normalized arguments;
unknown inputs fail closed. Missing, unmatched, and ambiguous policy denies.
All calls in one model turn are decided before any sibling executes, and one
approval-required call suspends the complete batch.

**(c) Workspace confinement.** Every path argument is resolved to a real
path — following symlinks — and asserted inside the configured root before
the handler sees it. Symlink escape is the classic bug here, and
`path.resolve()` alone does not catch it.

**(d) Timeouts.** The QA pass found `dispatchToolCall` could wedge forever.
A2.2 now derives a per-tool deadline, aborts cooperatively, and surfaces the
timeout as an `isError` result so the model can react. Capacity remains held
until an uncooperative underlying handler actually settles.

**(e) Output and concurrency caps.** A2.2 rejects oversized output before a
result reaches lifecycle events or model context and enforces finite shared
global/per-capability capacity using the declared cost. The older
`maxToolResultChars` remains a separate conversation-projection cap.

**(f) Active-call cancellation and timeouts.** Cancellation must reach the
provider request and every running tool, not only retry sleeps or the outer
loop. Model calls and tools have finite configurable timeouts. A cancelled
or timed-out operation emits a terminal event and is never appended to the
conversation as if the assistant said it.

**No built-in tool is enabled by default.** A deployment opts in, per
capability, per role.

## Decision 5 — approval suspends the run rather than blocking it

A human-in-the-loop approval crosses an HTTP boundary. Two shapes were
considered: hold the connection and await a callback, or suspend and resume.

**Decision: suspend.** `run()` ends with `reason: "needsApproval"` and the
pending calls visible; the caller resumes with decisions. This keeps the
server stateless per request, survives a dropped connection, and makes the
approval decision a persisted record rather than an in-memory promise.

It also costs almost nothing to build, because **`step()` already has this
shape**: when tools are requested and no registry can run them, it returns
`done: true` with `toolCalls` populated rather than swallowing the request.
Approval-required is the same case with a different reason. Designing it
now rather than retrofitting is deliberate — this is the one decision in
Phase A that would be genuinely expensive to change later.

## Decision 6 — MCP tools enter through the same door

**[VERIFIED]** `pi-ai` has no MCP client, so we build one — wrapping the
official `@modelcontextprotocol/sdk` rather than implementing the wire
protocol, since the protocol is not where our value is.

**Decision: MCP tools register into the same `ToolRegistry` and pass through
the same capability and policy layer as built-in tools.** An MCP server is a
third party running in the client's network; its tools must not bypass
policy because they arrived over a different transport.

**[UNVERIFIED]** and flagged as a real risk: an MCP server supplies its own
tool *names and descriptions*, which go into the prompt. That is untrusted
text in a privileged position — a hostile or compromised server can attempt
injection through a tool description alone. Mitigation is Decision 4's
corollary (descriptions cannot grant permissions) plus, probably,
per-server capability ceilings. Needs design before MCP ships, not after.

## Decision 7 — the runtime emits, it does not persist

Phase B subscribes to the event stream and writes. The runtime holds no
database handle.

The separation remains: it keeps the runtime testable with no infrastructure
and prevents database concerns from entering model/tool control flow. But a
persistence failure may **not** silently degrade recording. That contradicts
the product's complete-history and audit promises.

The server owns a durable event journal/outbox. Before acknowledging a run
or a human approval, it durably records the corresponding state transition.
If the primary database is unavailable, the deployment either writes to a
bounded encrypted local spool inside the residency boundary or suspends the
run with `persistenceUnavailable`. It never continues successfully while
quietly dropping events. Replay into the UI and audit projections comes from
that journal, using event ids for idempotency.

## What this deliberately does not build

- **No autonomous long-running agent.** `maxTurns` is required. There is no
  "work until done" mode in Phase A.
- **No tool enabled by default.**
- **No model-driven permission escalation**, in any form, ever.

## Open items

- **Approval granularity** — per call, per tool, per capability, or
  "remember for this conversation"? A product decision as much as a
  technical one; needs the UI (Phase D) to be real.
- **Sub-agents / delegation** — out of scope for A, but the event protocol
  should be checked for whether a nested run can be represented before it is
  frozen.
- **Streaming and truncation interact.** `ConversationManager.append()`
  truncates on every append; a partial streamed message is not appended
  until complete, so there is no interaction *today* — but this must be
  re-checked if partial persistence is ever added.
- **[UNVERIFIED]** whether every provider we support emits the full event
  protocol or degrades to `start` → `done`. Ollama and codex both need
  probing before the UI depends on `text_delta`. This is a conformance
  question and belongs in Phase E's suite.

## Definition of done

- [x] `step()` moves to `stream()` with an optional event sink; behaviour
      with no sink is unchanged, proven by the existing tests still passing.
- [x] `run()` with required `maxTurns` and deadline, cancellation, aggregate
      usage/latency, canonical event emission, and one terminal reason (A1.2).
- [x] Event protocol defined as types, with serializability, ordering,
      terminal-uniqueness, and future-version rejection tests (A0.1).
- [x] Audience-specific UI, persistence, audit, and log projections, with a
      test proving tool arguments and message content cannot enter audit/log
      records. Streaming deltas are excluded from persistence/audit (A0.1).
- [x] Transport contract defines ordered in-process delivery, a required
      acknowledgement sink, bounded optional observers, reconnect
      checkpoints, and pure SSE mapping (A0.2). Runtime and HTTP wiring remain
      deferred to A1 and Phase C.
- [x] Capability declarations on `ToolHandler`, and a fail-closed policy layer
      evaluated across the complete batch before `execute()` (A2.1).
- [x] Workspace confinement with a symlink-escape test (A2.2).
- [x] Per-tool timeouts, surfaced as `isError` (A2.2).
- [x] Run abort and deadline reach an active provider call and all running tools;
      cancelled/error responses never become assistant history.
- [x] Approval suspend/resume round trip (A3; durable repositories remain Phase B).
- [x] Built-in tools: file read/write, search, shell, HTTP — each behind its
      capability, none on by default (A2.3).
- [ ] MCP client, tools entering through the same registry and policy.
- [ ] Streaming verified live against both providers, and the event-protocol
      degradation question answered.
- [ ] Database outage test proves a run is durably spooled or suspended —
      never acknowledged with missing history.

## Files this will change

- `src/step.ts` — stream internally, optional event sink.
- `src/tool-registry.ts` — capabilities, timeouts, policy hook.
- `src/run.ts` — bounded state machine and canonical event mapping.
- New: `src/events.ts`, `src/event-transport.ts`,
  `src/policy.ts`, `src/tools/`, `src/mcp/`.
- Logged in `findings-log.md`.
