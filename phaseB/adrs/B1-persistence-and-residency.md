# B.1 — Persistence, and what "the data stays here" actually means

**Status:** Designed, pre-implementation (2026-08-05)
**Depends on:** ADR-003, 1.5 (`ConversationManager`), 1.8 (budget anchoring),
A.1 (the runtime emits events; this layer subscribes)
**Feeds:** C (the server reads and writes through this), D (history in the
UI), G (audit and retention)

## How to read this document

**[VERIFIED]** means checked against the code or the installed package with
evidence inline. **[UNVERIFIED]** means believed, not proven. Unmarked
statements are decisions.

## Why this phase is the load-bearing one

Every other phase makes the product *work*. This one makes the central claim
*true*. "All the data is retained on enterprise servers, not in foreign
databases" is a promise about where bytes land, and it is only as strong as
the leakiest place data touches.

Most of that risk is not in the chat table. It is in the derived and
incidental places — embeddings, search indexes, logs, caches, temp files —
which are exactly the places people forget to enumerate.

## Finding 1 — truncation currently *deletes*, and that must change

**[VERIFIED]** `ConversationManager.append()` ends with:

```ts
this.context.messages = kept;   // conversation-manager.ts
```

Messages evicted to fit the model's context window are **gone from the
object**. That was correct for a library where the caller owned the
transcript and the manager owned one call's context.

It is wrong for a product. A user scrolling back must see their whole
conversation; the model sees a window. Those are different things, and today
they are the same array.

**Decision: the stored conversation is complete, and the model's context is
a projection of it.** Truncation stops being a mutation and becomes a view
computed for each request.

This is the largest structural change in Phase B and it revises 1.5's
decision 4 ("truncation runs on every `append()` so the Context is always
within budget"). The *guarantee* survives — what goes to the provider is
still always within budget — but it is produced by projecting rather than by
discarding. Recorded as a revision rather than a silent change, per this
project's rule about not re-deciding ADRs quietly.

## Finding 2 — almost none of `ConversationManager`'s state is persistent

**[VERIFIED]** inventory of what the class holds:

| field | kind |
|---|---|
| `context.messages` | **persistent** |
| `context.systemPrompt`, `context.tools` | config, per request |
| `budget`, `overheadTokens`, `messageBudget` | derived from model config |
| `maxToolResultChars`, `strategy` | config |
| `anchor` | **derivable** — see below |

So persistence needs one thing: **messages, with their usage.** Everything
else is configuration or arithmetic.

**The 1.8 anchor does not need its own table.** It is
`{ tokens, messageIndex }` where `tokens = input + cacheRead + cacheWrite`
of an assistant message. If usage is stored per message — which audit and
spend control need anyway — the anchor rebuilds on load by finding the most
recent assistant message carrying usable usage.

With one condition, which is the same rule 1.8 already applies to
truncation: **rebuild the anchor only if the whole anchored prefix is
loaded.** A windowed load that starts after the anchored message must fall
back to `estimated`, because the anchor's token count covers messages that
are not in memory. The existing `BudgetSource` field already expresses this,
so nothing new is needed in the API — only the discipline to use it.

## Decision 3 — storage shape: JSONB for content, columns for queries

Message content currently arrives as a discriminated union owned by
`pi-ai`, and it grows — `thinkingSignature` and `textSignature` were added
to our accounting only after they caused a defect. That dependency type is
appropriate inside the runtime, but it cannot be the permanent database or
public API contract: a package update must not redefine historical data.

**Decision: a versioned product envelope in JSONB; columns for what is
actually queried.** The write boundary maps the current `pi-ai` message into
our envelope. Unknown provider blocks can be retained in a typed extension
field, but raw provider payloads are off by default and inherit the same
retention and erasure policy as message content.

```
messages
  id            uuid pk
  conversation_id uuid fk
  seq           bigint          -- ordering within the conversation
  schema_version smallint        -- version of our product envelope
  role          text            -- user | assistant | toolResult
  content       jsonb           -- versioned product content envelope
  provider      text
  model         text
  config_key    text
  usage         jsonb           -- input/output/cacheRead/cacheWrite/cost
  created_at    timestamptz
  supersedes_id uuid null        -- points backward; old rows never change
```

`(conversation_id, seq)` is unique. Readers dispatch by `schema_version`;
new code must read every version still present or migrate it explicitly.

Normalising every block would mean a migration for shape nothing queries
into. The versioned JSONB envelope keeps that flexibility without letting a
dependency's TypeScript declaration become the product's durable contract.
Queries are by conversation, time, role, and model — all columns. Search is
a separate index either way.

**The cost, stated plainly:** the database cannot enforce the content shape,
so validation happens on write. Given this project's history with
unvalidated inputs — a one-character typo in `local-providers.json` disabled
truncation entirely — that validation is not optional and gets a regression
test.

## Decision 4 — append-only

Messages are immutable. An edit writes a new row whose `supersedes_id`
points to the previous row; the previous row is never updated. The current
view selects the newest unsuperseded version. Deletion is an explicit
retention operation, never an edit disguised as `UPDATE`.

This is what makes the Phase G audit story possible at all: an audit log
over mutable rows proves nothing, because the thing it attests to can have
changed underneath it.

## Decision 5 — the residency inventory is a deliverable

The sovereignty claim needs an enumeration of **every place client data
lands**, each one inside the boundary. Anything not on the list is a leak
nobody has thought about.

| where | notes |
|---|---|
| messages, conversations | client Postgres |
| attachments | client disk or client-run object store |
| **embeddings** | client pgvector — derived from client data, therefore client data |
| search index | client-side; must be erasable |
| application logs | must not contain prompt or completion content by default |
| provider request cache | if any; must be local and bounded |
| temp files | attachment processing, uploads — cleaned, and inside the boundary |
| crash/telemetry | **off by default**, and absent entirely in air-gapped mode |

**The one most often missed: the embedding model must be local too.** A
deployment that stores embeddings in the client's pgvector while calling a
hosted embedding API has shipped every document out of the building. The
vector is local; the document was not. Worth stating because it is invisible
in the schema — the leak is in a code path, not a table.

The model itself is a deliberate exception: a client may choose a hosted LLM
and accept that their prompts leave. That is a per-deployment decision,
declared in config, and **air-gapped mode must make it impossible** rather
than merely discouraged.

## Decision 6 — erasure versus audit, resolved explicitly

These genuinely conflict. GDPR-style erasure requires content to be
destroyable; audit requires an immutable record of what happened.

**Decision: audit records reference identifiers and metadata, never
content.** Erasure removes the message rows, attachments, embeddings and
index entries, and leaves the audit trail's *shape* intact — who did what,
when, against which model. What was said is gone; that something was said,
and by whom, remains.

This has to be designed into the audit schema from the start, because an
audit log that copied prompt text cannot later be made erasable.

## Decision 7 — deletion must reach the derived stores

A deleted message that is still retrievable by semantic search is a
compliance failure, and it is the kind that stays invisible until an auditor
goes looking.

Postgres, a filesystem/object store, pgvector, and a separate search engine
cannot share one ACID transaction. Claiming otherwise would make the design
impossible to implement.

**Decision: erasure is a durable, convergent workflow.** One database
transaction tombstones the content, makes every query/search path filter it
immediately, and writes deletion jobs to an outbox. Idempotent workers remove
attachments, embeddings, cached/provider payloads, and search entries. The
job is complete only after reconciliation verifies every store and a
retrieval-side test can no longer find the content. Failed deletions remain
visible and retryable; they are never reported as complete.

This is the same failure mode as `lessons.md` #6: a check placed where the
evidence has already been removed proves nothing. Verify erasure from the
retrieval side, not the storage side.

## Decision 8 — explicit SQL and migrations from day one

**Decision: a thin query layer with explicit SQL, plus a migration tool.**
Not an ORM.

The reason is specific to this product rather than general taste: a client's
compliance reviewer may need to see exactly what is stored and what is
queried. SQL is readable by that audience; an ORM's generated queries are
not. The same reasoning that keeps provider quirks as declarative data
applies here — the auditable thing should be the readable thing.

Migrations exist from the first table, because client deployments are
upgraded in place and there is no opportunity to reset.

## Decision 9 — the durability boundary

The runtime remains database-free, but the server must durably journal state
transitions before acknowledging them. A database outage therefore has two
allowed outcomes: encrypted in-boundary spool with later idempotent replay,
or a suspended run with `persistenceUnavailable`. "Conversation succeeded
but its history disappeared" is not an allowed degraded mode.

The journal is the source for persistence/audit consumers. Each event has a
stable id; every consumer is idempotent and stores its checkpoint.

## Decision 10 — completed messages and interrupted streams

Streaming deltas are ephemeral UI events. The completed assistant message is
the durable conversation record. If a stream is interrupted, the run stores
terminal metadata (`cancelled`, `timeout`, or `error`) but does not invent an
assistant message. If resumable drafts are added later, they live in a
separate draft table and never masquerade as completed history.

## Open items

- **Multi-tenancy.** Single tenant per deployment is the default (ADR-003).
  If that ever changes, row-level security versus schema-per-tenant must be
  settled *before* the schema is fixed — retrofitting tenant isolation is
  the kind of change that touches every query.
- **Attachment storage backend.** Client disk versus a client-run
  S3-compatible store is a per-deployment choice, so the interface is
  abstracted; which is the default is not yet decided.
- **[UNVERIFIED]** pgvector index behaviour on delete — whether removing
  rows frees index entries promptly or requires maintenance. Matters for the
  erasure guarantee and needs measuring, not assuming.

## Definition of done

- [ ] Truncation reworked as a projection; the stored conversation is
      complete. Existing budget guarantees still proven by the current
      tests.
- [ ] Schema and migrations for users, conversations, messages,
      attachments.
- [ ] Stored messages use a versioned product envelope, with fixtures proving
      old schema versions remain readable after a runtime dependency upgrade.
- [ ] Message content validated on write, with a regression test for a
      malformed block.
- [ ] Load path rebuilds the 1.8 anchor, and falls back to `estimated` when
      the anchored prefix is not fully loaded.
- [ ] Append-only enforced, including the supersede path.
- [ ] Durable journal/outbox with idempotent consumers; database-outage tests
      prove runs are spooled or suspended, never silently unrecorded.
- [ ] Residency inventory written, with a test asserting logs contain no
      prompt or completion content.
- [ ] Erasure saga across message rows, attachments, embeddings, cache, and
      index, with retry/reconciliation and retrieval-side verification.
- [ ] Interrupted streams persist terminal run metadata but no fabricated
      assistant message.
- [ ] Local embedding model wired; hosted embedding calls impossible in
      air-gapped mode.

## Files this will change

- `src/conversation-manager.ts` — truncation becomes projection.
- New: `src/storage/` (schema, migrations, repositories), `src/residency.ts`.
- Logged in `findings-log.md`.
