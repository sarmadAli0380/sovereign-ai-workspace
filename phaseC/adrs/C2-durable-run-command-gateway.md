# C2 — Durable run command gateway and deployment service

**Status:** Accepted and implemented, 2026-08-25  
**Scope:** durable authenticated user commands through bounded local inference;
identity administration, approval APIs, rate/spend controls, and product reads
remain C3/C4  
**Depends on:** C1 ingress, A1/A2 runtime controls, A0-M admission, B1-B3
persistence, B7 projection/recovery, and P3.1 deployment

## Context

C1 authenticated commands and event reads but deliberately stopped before
owning a user message or invoking inference. C2 must cross those boundaries
without allowing HTTP retries to duplicate user content, allowing live SSE to
overtake persistence, or reintroducing a model path which bypasses the granted
config key and current admission evidence.

## Decisions

1. Every run command requires a caller-owned `Idempotency-Key` of 16–128
   bounded identifier characters. The key is scoped to the authenticated user.
   The first request binds a canonical request hash; an identical retry returns
   the original run, while different content under the same key returns 409.
2. One PostgreSQL statement locks the conversation and atomically inserts the
   command ownership row, user message, and pre-owned run. Circular command/run
   and command/message references are deferred and checked at commit. HTTP 202
   is emitted only after that ownership is durable.
3. Direct user messages and journal-projected assistant messages allocate one
   conversation-local sequence under the conversation row lock. Global journal
   sequence is delivery order, not a safe conversation sequence once user
   messages can be written directly.
4. The gateway reloads complete current history through
   `ConversationManager.loadCurrent`, passes the durable initiating message ID
   into the first turn, resolves only the configured local route, and obtains a
   lease from `LocalModelController` using current Ollama identity, digest,
   served context, health, residency, and operator-supplied memory evidence.
5. The existing bounded `run()` receives the authenticated deployment/role/
   conversation policy context. C2 exposes no implicit built-in tools. A route
   which is not currently admitted produces bounded canonical failure events
   instead of calling the provider.
6. Every canonical event first crosses `DurableJournalSink` (PostgreSQL or the
   authenticated encrypted spool), then the idempotent run-history projector,
   then C1's process-local broker. `message.delta` retains its already-decided
   ephemeral semantics, but it still crosses the required sink boundary before
   live fan-out. Durable replay remains PostgreSQL truth.
7. Compose adds one long-running server on the internal data plane. It receives
   only database, spool, and session-registry file secrets; mounts persistent
   attachment/spool volumes; uses a read-only root and no Linux capabilities;
   and publishes only `127.0.0.1:8080`. PostgreSQL and Ollama remain
   unpublished. Wider-network exposure requires operator-approved TLS
   termination or tunnelling.

## Acceptance evidence

- Deterministic negative controls cover caller idempotency, conflict, complete
  history reload, authenticated policy context, journal/projector/broker order,
  non-duplicating retry, server config, and the single-ingress Compose policy.
- A fresh disposable PostgreSQL 18/pgvector 0.8.6 database applied all three
  immutable migrations with pinned dbmate 2.35.0. The live C2 integration
  proved atomic ownership, identical retry, conflicting retry rejection, run
  authorization, projector reconciliation of a pre-owned run, and ordered
  user/assistant history. The disposable container was removed afterward.
- The full suite discovers 474 tests: 467 pass and seven isolated live tests
  skip without their disposable database/process environments. The C2 live
  test passes separately. Typecheck, rendered Compose policy, production image
  build, image-local production dependency audit, and `git diff --check` pass.

## Deferred

- C3 owns durable session issuance/revocation administration and authenticated
  approval listing/resolution.
- C4 owns rate/concurrency/spend controls and bounded product read APIs.
- Target client-owned Linux qualification, approved ingress TLS, backup/restore
  rehearsal with the C2 migration, and accelerator-resident inference remain
  release gates rather than claims from this development host.
