# Product roadmap — a sovereign AI workspace

**Supersedes** `00-original-roadmap.md`, which is kept as history. See
`ADR-003-sovereign-workspace-product.md` for why the framing changed.

**The deliverable:** a self-hosted AI workspace — Claude-app in shape — that
a client runs entirely inside their own network, with any LLM behind it,
swappable per client requirement.

**Deployment shape:** server plus web UI first; desktop client later.

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

**Roughly 10–15% of the product, and it is the bottom layer.** Everything
below is new work.

---

## Phase A — the agent runtime

*Turns a model call into something that can do work.*

**Designed: `phaseA/adrs/A1-agent-runtime.md`.** Not yet implemented.

- An agent loop over `step()` — turn limits, cancellation, streaming out.
- A built-in tool suite: file read/write, search, shell, HTTP. Each one a
  security boundary in a client deployment, so scoping is part of the
  design, not an afterthought.
- MCP client support, so a client can attach their own internal tools.
- Streaming to the UI: tokens, tool calls, and errors as they happen.

**Reverses 1.7's "no agent loop" decision** — see ADR-003. `step()` stays a
single transition underneath.

## Phase B — persistence, on the client's own database

*The sovereignty claim lives or dies here.*

**Designed: `phaseB/adrs/B1-persistence-and-residency.md`.** Not yet
implemented. Note it revises 1.5: truncation becomes a projection rather
than a mutation, because dropping a message from the model's window must not
delete it from the user's history.

- Postgres schema: users, conversations, messages, tool calls, attachments.
- `ConversationManager` currently holds one conversation in memory in one
  process. It needs to load from and write to storage without losing the
  budgeting work already done.
- File and attachment storage on the client's disk or object store.
- Embeddings and vector search **in the client's database** — pgvector.
  Embeddings are derived from client data and are client data.
- Retention and deletion that actually deletes, including from indexes.

## Phase C — the server

- HTTP + SSE API in front of the agent runtime.
- Authentication, sessions, and RBAC. Deployed per client, so a single
  tenant per deployment is the default; multi-tenant is a later question.
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
- Grows directly out of `verify-live` / `verify-swap` / `size-model` and the
  catalogue of provider lies in `findings-log.md`.

Breadth here is measured in *verified* models, never in adapter count.

## Phase F — deployment

- One `docker-compose` bringing up app, database, vector store, and
  inference engine on a fresh server.
- Air-gapped mode with zero outbound calls, for clients who require it.
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

## The honest note

Building this from scratch is many months, and most of it — UI, storage,
auth, file handling — is not the model-agnostic part that makes it worth
building. That was weighed and accepted (ADR-003, Decision 1). It is
recorded here so the timeline is never a surprise.
