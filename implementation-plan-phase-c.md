# Implementation plan — Phase C server

**Status:** C1-C4 implemented and verified 2026-08-25. P3
target-host certification remains an independent pre-production gate.  
**Decisions:** `phaseC/adrs/C1-authenticated-http-sse-ingress.md`,
`phaseC/adrs/C2-durable-run-command-gateway.md`,
`phaseC/adrs/C3-durable-identity-and-approvals.md`, and
`phaseC/adrs/C4-controls-and-product-reads.md`.

## Outcome

Make one authenticated server process the deployment's only ingress while
reusing the existing runtime, capability policy, approval, durable journal,
repository, residency, and readiness boundaries. PostgreSQL and Ollama remain
unpublished internal services.

## C1 — authenticated command and event transport

**Status:** implemented.

- Strict file-rotatable bearer session registry with digested tokens, expiry,
  revocation, roles, and per-session model grants.
- Separate permission and resource-ownership checks, backed by parameterized
  PostgreSQL conversation/run queries.
- Bounded authenticated run command endpoint.
- Canonical SSE frames, durable per-run replay with `Last-Event-ID`, and
  process-local post-acknowledgement fan-out.
- Minimal health/readiness responses, stable metadata-only errors, security
  headers, no default cross-origin authority.

**Deterministic evidence:** 31 focused server/repository tests pass. The full
suite discovers 462 tests (456 pass and six isolated database/process
integrations skip without a disposable database), typecheck passes, the P3
deployment topology verifier passes all eight checks, and `git diff --check`
passes.

## C2 — concrete durable run command gateway and deployment service

**Status:** implemented.

1. Append and acknowledge the authenticated user message with a caller-owned
   idempotency key.
2. Load complete current history through `ConversationManager.loadCurrent`.
3. Resolve only a config key granted to the principal and admitted by the
   existing model-control boundary.
4. Invoke the existing bounded `run()` with the authenticated policy subject.
5. Compose the durable journal/spool acknowledgement before C1 live fan-out;
   no event may reach SSE first.
6. Project run history idempotently and expose the accepted run only after its
   command ownership is durable.
7. Add the long-running server service to Compose with one explicit ingress
   port, file secrets, read-only root, persistent attachments/spool, and only
   the internal data plane. PostgreSQL and Ollama remain unpublished.

**Evidence:** caller-key idempotency, complete-history reload, admission lease,
authenticated policy context, durable/projected-before-live event order, and
Compose hardening pass deterministic tests. Pinned dbmate applied the C2
migration to a fresh PostgreSQL 18/pgvector 0.8.6 database and the live C2
integration passed. The production image builds and its dependency audit
reports zero vulnerabilities. The full suite discovers 474 tests (467 pass,
seven environment-isolated live tests skip); typecheck and topology policy pass.

## C3 — durable identity administration and approvals

**Status:** implemented.

- PostgreSQL session issuance/revocation and role/model-grant administration.
- Authenticated approval listing/resolution using `ApprovalResumeController`;
  conversational text is never authorization.
- Explicit CSRF/origin policy if browser cookies are introduced. Bearer-only
  deployments do not silently enable credentials across origins.

**Evidence:** PostgreSQL is the live source for digested bearer sessions,
current roles, and current model grants; the file registry is an empty-database
bootstrap only. Admin access replacement, bounded one-time token issuance,
revocation, final-admin protection, ownership-filtered approval listing, exact
authenticated batch resolution through `ApprovalResumeController`, durable
decision/result persistence, same-session replay, and bearer-only origin/cookie
negative controls pass deterministic tests. Pinned dbmate applied all four
migrations to a fresh PostgreSQL 18/pgvector 0.8.6 database; the C3 live
integration and the existing B1-B6 storage integrations pass on that schema.
The full database-free suite discovers 487 tests: 479 pass and eight isolated
database/process integrations skip; typecheck and deployment topology policy
pass.

## C4 — controls and product reads

**Status:** implemented.

- Per-user/per-model concurrency and rate limits.
- Measured token/spend budgets which fail closed when a provider cannot enforce
  or report the required bound.
- Bounded conversation history, attachment, run-status, and audit-facing APIs.

**Evidence:** PostgreSQL-backed, expiring idempotent reservations atomically
enforce per-user/model concurrency, per-user rate, token, and spend windows.
Routes without enforced output limits or required token/cost reporting fail
before command ownership. Reservations settle from product-validated measured
usage or remain conservatively charged after incomplete reporting. Exact
cursor/limit schemas bound ownership-filtered message, available-attachment
metadata, run-status, and admin-only audit-projection reads. Pinned dbmate
applied all five migrations to fresh PostgreSQL 18/pgvector 0.8.6; the C4 and
existing B1-B6/C2-C3 live integrations passed serially on that clean schema.
The full database-free suite discovers 500 tests: 491 pass and nine isolated
database/process integrations skip. Typecheck, rendered deployment policy, and
`git diff --check` pass; the cached offline production dependency audit reports
zero vulnerabilities, while three live registry audit attempts returned an
empty endpoint error and remain unverified.

## Continuous gates

- Authentication/authorization negative controls and metadata-only logs.
- Exact request/event schema validation and bounded queues/bodies/replay.
- Database integration tests run against a disposable isolated database.
- Full tests, typecheck, production dependency audit, Compose topology policy,
  `git diff --check`, and target-host operational certification before release.
