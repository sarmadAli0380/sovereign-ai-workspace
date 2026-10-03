# C4 — Durable controls and bounded product reads

**Status:** Accepted and implemented, 2026-08-25

**Scope:** per-user/model concurrency and rate limits, measured token/spend
budgets, and ownership-filtered product read APIs

**Depends on:** C1 authentication and ownership, C2 durable command ownership,
C3 current identity grants, B1 product repositories, and B3 audit projection

## Context

C2 could bound one run but did not bound how many runs a user or model could
start, how often they could start them, or how much token/spend capacity they
could consume across runs. The durable store already held product history,
attachment metadata, run status, and content-redacted audit projections, but
C1-C3 exposed only commands, SSE, identity administration, and approvals.

## Decisions

1. PostgreSQL owns C4 accounting. A caller idempotency key is bound to one
   expiring `run_control_reservations` row before command ownership. Transaction
   advisory locks serialize the affected user and provider/model scopes; fresh
   statements then check concurrency, rate, token, and spend counters before
   insertion. Identical retries reuse the reservation and cannot double-charge.
2. Concurrency counts only active, unexpired leases. Rate and budget windows
   retain accepted work across restarts. A process death can release capacity
   when its lease expires, while its token/spend reservation remains charged
   conservatively until the budget window closes.
3. Admission reserves `contextWindow * maxTurns` tokens and an operator/model
   maximum run cost before inference. Successful runtime messages supply the
   product-owned token and USD cost usage; settlement replaces the reservation
   with measured values. A failed or incomplete report settles conservatively.
4. A controlled route must declare an enforced output-token limit and token/cost
   reporting. Missing, false, non-finite, or otherwise unaccountable capability
   data rejects the command before its user message or run is created. The
   supported local Ollama route has zero provider spend and a product-validated
   required usage envelope.
5. Control values are strict deployment configuration. The first supported
   topology defaults to one concurrent run per user/model, 60 accepted runs per
   user per hour, one million tokens per user per day, and zero external-provider
   spend. The lease TTL must exceed the bounded run timeout.
6. Product reads are separate from the canonical persistence API. HTTP exposes:
   bounded current conversation messages, available attachment metadata, one
   run status, and administrator-only audit events. Conversation/run ownership
   remains indistinguishable from absence for members.
7. Every list accepts only an exact cursor and a maximum page size of 100.
   Attachment reads omit object keys and hashes. Audit reads come only from the
   existing metadata/derived-content audit projection and never from canonical
   content-bearing journal events.

## Acceptance evidence

- Deterministic tests cover strict configuration, all four rejection classes,
  idempotent reservation reuse, measured settlement, conservative reservation,
  provider-accountability rejection, bounded SQL, metadata-only attachment
  output, HTTP permissions, ownership, cursor validation, and audit admin scope.
- Pinned dbmate 2.35.0 applied all five immutable migrations to a fresh
  PostgreSQL 18/pgvector 0.8.6 database. The live C4 integration proved atomic
  concurrency rejection, measured settlement and capacity release, message and
  attachment reads, run status, and content-free audit reads. The existing
  B1-B6 and C2-C3 storage integrations also passed serially on that fresh schema.
- The disposable database container was removed after verification. Target-host
  deployment, approved TLS ingress, and accelerator-resident inference remain
  independent release gates.

## Deferred

- Per-role/tenant policy administration and multi-node distributed admission
  require a later product decision. This first deployment remains one server
  process and one PostgreSQL authority.
- Conversation creation, attachment upload/download, search, and UI composition
  are later product APIs; C4 exposes only the requested bounded reads.
