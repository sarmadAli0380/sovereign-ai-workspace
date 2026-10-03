# C3 — Durable identity administration and approvals

**Status:** Accepted and implemented, 2026-08-25

**Scope:** PostgreSQL-backed bearer sessions, role/model-grant administration,
and authenticated approval listing/resolution

**Depends on:** C1 transport/ownership checks, C2 durable run gateway, A2 policy
and tool controls, A3 `ApprovalResumeController`, and B1 repositories

## Context

C1's file registry established a strict bearer boundary but could not issue or
revoke sessions through the product, and its embedded roles/model grants would
have become stale administration state. A3 established that approvals are
structured, batch-atomic, bound to exact tool arguments/capabilities, and never
authorized by conversational text, but did not expose an authenticated durable
server path.

## Decisions

1. PostgreSQL is the live identity authority. `server_sessions` stores only a
   SHA-256 token digest, expiry, status, issuer, and revocation metadata.
   `user_roles` and `user_model_grants` are current grants, not copied session
   claims, so a grant change takes effect on the next authenticated request.
2. The existing file registry is a one-time bootstrap input only. Under an
   advisory lock, an empty session database imports missing bootstrap users,
   grants, and digested sessions. Once any durable session exists, restart does
   not overwrite administration or revive a revoked session.
3. Only a currently authenticated durable administrator can replace a user's
   exact role/model-grant sets, issue a bounded session, or revoke a session.
   Removing the final active administrator fails closed. A newly issued raw
   token crosses the response once under `Cache-Control: no-store`; SQL, logs,
   environment, and checked files receive only its digest.
4. Members list/resolve pending approvals only for conversations they own;
   administrators may operate tenant-wide. Listing reconstructs the A3 request
   from the durable run, tool call, policy decision, and approval rows and is
   bounded to 100 records.
5. Resolution accepts the complete exact batch for one run. The authenticated
   session is injected server-side as the A3 authority proof; clients cannot
   submit an authorization string or conversational fields. The
   `ApprovalResumeController` verifies the entire batch, then one SQL statement
   durably binds every decision to the actor, session, and canonical request
   hash before any approved handler starts. Identical same-session retries are
   idempotent; incomplete or conflicting retries fail.
6. Tool execution re-enters the existing registry, argument validation,
   capability declarations, execution controller, and trusted per-approval
   idempotency key. Result messages are appended to durable conversation
   history. No built-in tool is enabled by default.
7. The current deployment remains bearer-only. It rejects cookies and any
   request carrying an `Origin` header, emits no CORS credential headers, and
   therefore does not claim browser-cookie CSRF protection. Introducing cookies
   requires a separate same-origin and CSRF decision.

## Acceptance evidence

- Deterministic tests cover digest-only lookup/issuance, current-grant loading,
  one-time bootstrap, final-admin protection, ownership-filtered approval
  listing, atomic decision persistence, partial-batch rejection, HTTP role
  checks, conversational-field rejection, and bearer-only origin/cookie denial.
- Pinned dbmate 2.35.0 applied all four migrations to a fresh disposable
  PostgreSQL 18/pgvector 0.8.6 database. The live C3 integration proved
  bootstrap non-reapplication, admin authentication, access replacement,
  one-time raw-token issuance, member authentication, approval execution,
  durable resolution/result history, idempotent replay, and revocation.
- The existing B1-B6 storage integration suite also passes on the C3 schema.
  A focused live B6 erasure proof additionally verifies that user roles and
  model grants are deleted, sessions are revoked with their original digest
  destroyed, and the user's C2 command is removed and detached from its run.
  Target-host deployment, approved TLS ingress, and accelerator-resident
  inference remain independent release gates.

## Deferred

- C4 owns per-user/model concurrency and rate limits, measured spend/token
  budgets, and bounded conversation, attachment, run-status, and audit reads.
- Durable continuation of a suspended model run after tool results is a product
  workflow decision beyond this approval-decision slice; C3 durably records the
  decision and tool result without inventing a second inference command.
