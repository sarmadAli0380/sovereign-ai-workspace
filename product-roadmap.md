# Product roadmap — a sovereign AI workspace

**Supersedes** `00-original-roadmap.md`, which is kept as history. See
`ADR-003-sovereign-workspace-product.md` for why the framing changed.

**The deliverable:** a self-hosted AI workspace — Claude-app in shape — that
a client runs entirely inside their own network, with any LLM behind it,
swappable per client requirement.

**Deployment shape:** server plus web UI first; desktop client later.

**Execution plan:** `implementation-plan-a0-through-phase-b.md` sequences
the pre-Phase-A event, prompt/cache, and model-control foundations through
the Phase A and Phase B implementation gates.

---

## What is already done

Not restated in the phases below, because it exists and is verified.

| | |
|---|---|
| Model resolution | configKey → model in one lookup, all quirks declared as data |
| Conversation state | budget anchored on measured input, truncation, tool-result capping |
| Tool dispatch | registry, parallel execution, errors wrapped as results |
| One transition | `step()` — the agent loop below is built on top of it |
| Provider registration | any OpenAI-compatible `/v1` server, from JSON |
| Memory sizing | measured, validated across two model families |
| Live verification | two providers, genuine cross-provider swap |
| Run/event contract | versioned typed events, runtime validation, ordered-run invariants, audience redaction |
| Bounded agent run | required turn/deadline bounds, canonical event mapping, cancellation, terminal reasons |
| Tool capability policy | required control declarations, deterministic fail-closed decisions, pre-execution audit events, approval batch suspension |
| Context compilation | versioned deterministic prompts, stable tools, bounded provider projection, content-free fingerprints |
| Cache conformance | machine-readable cold/warm/invalidation/truncation probes; Codex observed, Qwen explicitly unverified |
| Truncation decision | drop-oldest default retained; deterministic prefix compaction measured as an opt-in candidate |
| Model capability record | versioned declared/observed evidence with provenance, freshness, health and fail-closed route assessment |
| Local model admission | runtime inspection, sizing/headroom, resident/sequence limits, explicit load and degradation states |

This is still the product's bottom layer rather than a user-facing workspace.
Phase B, the P3.1 single-node substrate, and the C1-C4 authenticated durable
server path have since been built; the web UI and the packaged governance
surface below remain product work.

---

## Phase A — the agent runtime

*Turns a model call into something that can do work.*

**Designed: `phaseA/adrs/A1-agent-runtime.md`.** A0.1's event contract and
audience projections, A0.2's transport, and A1's streaming bounded run loop
and A2.1's capability-policy gateway are implemented. A2.2's execution
controls and A2.3's opt-in built-in tools are also implemented; approval
resume is implemented as A3's persistence-ready process-local controller;
MCP and the C1-C4 HTTP/SSE, identity, control, approval, and product-read server
path are implemented.

- An agent loop over `step()` — turn limits, deadline/cancellation, streaming
  out. **Implemented deterministically; live provider stream conformance remains.**
- A built-in tool suite: file read/write, search, shell, HTTP. Each one a
  security boundary in a client deployment, so scoping is part of the
  design, not an afterthought.
- MCP client support, so a client can attach their own internal tools.
- Streaming to the UI: tokens, tool calls, and errors as they happen.
- Active provider/tool cancellation and finite timeouts; operational errors
  never become assistant history.
- One causal event protocol with separate content-bearing UI/persistence and
  metadata-only audit/log projections.

**Reverses 1.7's "no agent loop" decision** — see ADR-003. `step()` stays a
single transition underneath.

## Phase B — persistence, on the client's own database

*The sovereignty claim lives or dies here.*

**Designed: `phaseB/adrs/B1-persistence-and-residency.md`; B1-B7 implemented
and verified through 2026-08-21.** A0.3's versioned message contract/runtime
codec, explicit PostgreSQL repositories, complete-history/provider-window
projection, durable journal/outbox, attachment ingestion, and local
embeddings/search, convergent verified erasure, and residency/recovery
operational proof are implemented.

- PostgreSQL schema and repositories: users, conversations, runs/turns,
  messages, tool calls/decisions, approvals, attachments, journal/audit,
  outbox/checkpoints, and erasure jobs.
- Versioned product message envelopes, so stored history is not coupled to a
  `pi-ai` package version.
- `ConversationManager` stores complete loaded history and projects a bounded
  provider window without losing the budgeting work already done.
- File and attachment storage on the client's disk or object store.
- Embeddings and vector search **in the client's database** — pgvector, with
  local Ollama `nomic-embed-text:v1.5` pinned by live digest evidence.
- Retention and deletion that actually deletes, including from indexes.
- Durable journal/outbox and idempotent erasure workflows across database,
  object storage, embeddings, caches, and search.

## Phase C — the server

**C1-C4 implemented 2026-08-25:** one-time bootstrap bearer authentication,
PostgreSQL session issuance/revocation and current role/model grants, RBAC plus
PostgreSQL ownership, caller-idempotent durable user commands, complete history
reload, local-model admission, bounded runtime execution, durable SSE
replay/live fan-out, authenticated durable approval listing/resolution,
PostgreSQL-backed per-user/model concurrency, rate/token/spend controls,
bounded ownership-filtered product reads, and one hardened loopback Compose
ingress.

- HTTP + SSE API in front of the agent runtime.
- Authentication, sessions, and RBAC. Deployed per client, so a single
  tenant per deployment is the default; multi-tenant is a later question.
- Secret management and rotation. Tracked configuration may reference a
  secret but never contain one.
- Per-user and per-org model access — not every user gets every model.
- Rate limiting and spend controls, using the measured token accounting
  rather than an estimate.

## Phase D — the web UI

- Chat: streaming, markdown, code, attachments, conversation history.
- Model switcher, showing what each model actually supports rather than a
  flat list — the conformance data made visible to the user.
- Admin: users, roles, model configuration, audit browsing.

## Phase E — provider conformance

*The differentiator. See ADR-003, Decision 4.*

- A conformance suite every candidate model must pass before it is declared
  supported: does it honour `maxTokens`, what context is *actually* served,
  does it report usage, does tool calling round-trip cleanly, does it leak
  tool JSON into content, does it replay reasoning.
- Machine-readable results, dated, per model — a client-facing artifact.
- Fail-closed assertions: a tool test fails unless a tool round trip really
  occurred, malformed providers cannot pass by agreeing on the same wrong
  type, and a cross-provider proof requires two different providers.
- Grows directly out of `verify-live` / `verify-swap` / `size-model` and the
  catalogue of provider lies in `findings-log.md`.

Breadth here is measured in *verified* models, never in adapter count.

## Phase F — deployment

**P3.1 substrate implemented 2026-08-24 and extended through C4 on 2026-08-25:** digest-pinned runtime,
PostgreSQL/pgvector, and Ollama images; an internal-only Compose data plane;
file secrets; persistent volumes; one-shot model bootstrap, migrations,
readiness, backup, and the C4 server as the sole loopback ingress. This is not
the complete Phase F gate because target-host, TLS-ingress, accelerator, and
full operational evidence are recorded separately.
Development evidence is in
`conformance/2026-08-24-single-node-deployment.json`; target-host repetition is
a pre-production gate.

- One `docker-compose` bringing up app, database, vector store, and
  inference engine on a fresh server.
- Air-gapped mode with zero outbound calls, for clients who require it.
- Enforced egress policy at the network and application layers; air-gapped
  mode cannot resolve a hosted provider even when one remains in config.
- On-prem versus private cloud, and when to recommend which.
- Hardware sizing from `size-model.ts` — already built.

## Phase G — governance

*Often the actual thing the client is paying for.*

- Audit log: who queried what, when, against which model, with what result.
- Encryption at rest and in transit.
- Data residency end to end — logs, embeddings, caches, not just the chat.
- The regulatory frame per client base: EU AI Act, SDAIA-style national AI
  governance for Gulf clients.

## Phase H — productize

- Per-client configuration: models, data sources, access rules, branding.
- An onboarding checklist: sizing, model selection and certification,
  compliance review, deploy.
- Desktop client, once the server product is proven.
- LoRA/QLoRA fine-tuning for client terminology, if a client needs it.

---

## Ordering

A → B → C → D gets to a demoable product; that is the critical path. E runs
alongside from the start, because every model added to a client deployment
needs certifying anyway and the suite grows by being used. F and G are what
make it sellable to a regulated client. H is what makes the second client
cheaper than the first.

Security and governance are acceptance gates across A–F, not work postponed
until G. Phase G packages and exposes the evidence; threat modelling, secret
handling, redaction, durable audit events, encryption boundaries, and
erasure semantics must shape the earlier schemas and APIs before they
freeze.

## The honest note

Building this from scratch is many months, and most of it — UI, storage,
auth, file handling — is not the model-agnostic part that makes it worth
building. That was weighed and accepted (ADR-003, Decision 1). It is
recorded here so the timeline is never a surprise.
