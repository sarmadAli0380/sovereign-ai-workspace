# C1 — Authenticated HTTP/SSE ingress boundary

**Status:** Accepted and deterministically implemented, 2026-08-25  
**Scope:** the first Phase C slice; not yet the deployable inference command
gateway, approval API, session issuance UI, or rate/spend control  
**Depends on:** A0.1/A0.2 events and transport, A1/A2 runtime controls, B1/B3
repositories and durable journal, and P3.1 readiness

## Context

P3.1 deliberately ships no long-running application process. The next process
must be the deployment's sole ingress without creating a second event format,
an unauthenticated model path, an in-memory replay authority, or a resource-ID
oracle. HTTP commands and SSE delivery have different lifecycles, but they must
share the same authenticated product identity and durable run identity.

## Decisions

1. `POST /v1/conversations/:conversationId/runs` is the bounded command
   boundary. It accepts only `configKey`, a non-empty text message, and a
   positive `maxTurns` no greater than 32. Unknown fields, non-JSON content,
   oversized bodies, and ungranted models fail closed.
2. `GET /v1/runs/:runId/events` is one-way SSE. It reuses the canonical
   `RunEvent` codec and `encodeRunEventSse`; it never invents a browser event
   schema. `Last-Event-ID` resolves inside the authorized run's durable journal.
3. A process-local broker carries only events whose required durable
   acknowledgement has already succeeded. It is a live fan-out optimization,
   not history. Reconnect truth remains PostgreSQL.
4. Authentication is an opaque bearer session. Only SHA-256 token digests are
   stored in the bounded registry. Expired, revoked, malformed, and unknown
   sessions return the same authentication failure. The file-backed adapter
   reloads per request so an atomic replacement can rotate or revoke sessions.
5. RBAC grants a permission; it does not grant a resource. PostgreSQL separately
   proves conversation/run ownership, active-user state, and non-archived state.
   Unauthorized resources return the same response as absent resources.
6. Model access is an explicit session grant (`allowedConfigKeys`). The server
   never infers permission from a client-supplied config key.
7. `/healthz` and `/readyz` expose status only. Error responses contain stable
   codes and request identities, never stack traces, bearer tokens, client
   content, database details, or provider details. CORS is absent by default.

## Acceptance

- Auth parsing rejects absent, malformed, unknown, expired, and revoked tokens.
- Registry parsing rejects unknown fields, duplicate identities/hashes, unknown
  roles, unbounded lists, and raw-token-shaped drift.
- HTTP command parsing is content-type checked, byte bounded, schema exact, and
  model-grant checked before command ownership transfers.
- PostgreSQL adapters bind conversation/run access to the authenticated user;
  admin bypass is explicit data, not an ambient server mode.
- SSE replay validates stored run/event/sequence identity, preserves order,
  resumes strictly after the named event, and closes on a terminal event.
- The full deterministic suite, typecheck, deployment topology verifier, and
  `git diff --check` remain green.

## Deferred to C2

- The concrete command gateway that appends the user message, loads complete
  history, calls the existing `run()`, and composes `DurableJournalSink` before
  live fan-out.
- PostgreSQL-backed session issuance/revocation and administrative role/model
  grant management. C1's file registry is the bootstrap/air-gapped authority.
- Compose server service and its one published ingress port. Data services stay
  private; deployment wiring is not added until the concrete gateway exists.
- Approval commands, rate/spend controls, attachments, history endpoints, and
  browser origin policy.
