import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { embeddingManifestDigest } from "../../search/embeddings.ts";
import type { SqlExecutor, SqlQueryResult } from "../sql.ts";
import { EventJournalRepository } from "./journal.ts";
import { MessageRepository } from "./messages.ts";
import { KnowledgeSearchRepository } from "./search.ts";
import {
  ConsumerCheckpointRepository,
  ERASURE_STORES,
  ErasureRepository,
  OutboxRepository,
} from "./work.ts";

const occurredAt = "2026-08-19T08:00:00.000Z";

class RecordingExecutor implements SqlExecutor {
  readonly calls: { sql: string; values: readonly unknown[] }[] = [];
  readonly results: SqlQueryResult[] = [];

  async query(sql: string, values: readonly unknown[] = []): Promise<SqlQueryResult> {
    this.calls.push({ sql, values });
    return this.results.shift() ?? { rows: [], rowCount: 0 };
  }
}

function userMessage(id = "message-1") {
  return {
    schemaVersion: 1 as const,
    messageId: id,
    role: "user" as const,
    createdAt: occurredAt,
    content: [{ type: "text" as const, text: "client-content-canary" }],
  };
}

const embeddingManifest = {
  provider: "ollama" as const,
  model: "nomic-embed-text",
  version: "2026-08-21",
  dimensions: 3,
  digest: `sha256:${"b".repeat(64)}` as const,
  endpoint: "http://localhost:11434/api/embeddings",
};

test("message writes validate the complete envelope before issuing SQL", async () => {
  const database = new RecordingExecutor();
  const repository = new MessageRepository(database);
  const malformed = {
    ...userMessage(),
    content: [{ type: "future-block", raw: "must-not-write" }],
  };

  await assert.rejects(
    repository.append({ conversationId: "conversation-1", seq: 0, message: malformed as never }),
    /unknown message block/,
  );
  assert.equal(database.calls.length, 0);
});

test("message writes use explicit parameterized SQL and decode an owned envelope", async () => {
  const database = new RecordingExecutor();
  database.results.push({
    rows: [{
      conversation_id: "conversation-1",
      seq: "0",
      content: userMessage(),
      supersedes_id: null,
      stored_at: new Date(occurredAt),
    }],
    rowCount: 1,
  });
  const repository = new MessageRepository(database);
  const stored = await repository.append({
    conversationId: "conversation-1",
    seq: 0,
    message: userMessage(),
  });

  assert.equal(stored.message.messageId, "message-1");
  assert.match(database.calls[0]!.sql, /INSERT INTO messages/);
  assert.doesNotMatch(database.calls[0]!.sql, /client-content-canary/);
  assert.equal(database.calls[0]!.values[0], "message-1");
  assert.equal(database.calls[0]!.values[6], null);
  assert.equal(database.calls[0]!.values[9], null);
});

test("current-history reads are ordered, bounded, and reject numeric fail-open values", async () => {
  const database = new RecordingExecutor();
  const repository = new MessageRepository(database);

  await assert.rejects(
    repository.listCurrent("conversation-1", { limit: Number.NaN }),
    /limit must be a positive safe integer/,
  );
  await assert.rejects(
    repository.listCurrent("conversation-1", { afterSeq: Number.POSITIVE_INFINITY }),
    /afterSeq must be a safe integer/,
  );
  assert.equal(database.calls.length, 0);

  await repository.listCurrent("conversation-1", { afterSeq: 4, limit: 25 });
  assert.match(database.calls[0]!.sql, /FROM current_messages/);
  assert.match(database.calls[0]!.sql, /ORDER BY seq ASC/);
  assert.deepEqual(database.calls[0]!.values, ["conversation-1", 4, 25]);
});

test("complete current-history reads page until the unsuperseded view is exhausted", async () => {
  const database = new RecordingExecutor();
  const row = (seq: number) => ({
    conversation_id: "conversation-1",
    seq,
    content: userMessage(`message-${seq}`),
    supersedes_id: null,
    stored_at: new Date(occurredAt),
  });
  database.results.push(
    { rows: [row(0), row(2)], rowCount: 2 },
    { rows: [row(5)], rowCount: 1 },
  );
  const repository = new MessageRepository(database);

  const loaded = await repository.listAllCurrent("conversation-1", 2);

  assert.deepEqual(loaded.map((message) => message.seq), [0, 2, 5]);
  assert.deepEqual(database.calls.map((call) => call.values), [
    ["conversation-1", -1, 2],
    ["conversation-1", 2, 2],
  ]);
});

test("journal writes full persistence data and metadata-only audit data atomically", async () => {
  const database = new RecordingExecutor();
  database.results.push({ rows: [{ event_id: "event-1", journal_seq: "17" }], rowCount: 1 });
  const repository = new EventJournalRepository(database);
  const persisted = await repository.append({
    schemaVersion: 1,
    eventId: "event-1",
    runId: "run-1",
    conversationId: "conversation-1",
    sequence: 2,
    turn: 1,
    occurredAt,
    type: "message.completed",
    causationId: "request-1",
    audience: "persistence",
    sensitivity: "content",
    payload: { message: userMessage() },
  });

  assert.equal(persisted, true);
  assert.equal(database.calls.length, 1);
  assert.match(database.calls[0]!.sql, /WITH inserted_event AS/);
  assert.match(database.calls[0]!.sql, /INSERT INTO audit_events/);
  assert.match(database.calls[0]!.sql, /INSERT INTO outbox_jobs/);
  assert.match(database.calls[0]!.sql, /journal\.event\.appended/);
  assert.match(database.calls[0]!.sql, /SELECT event_id, journal_seq/);
  assert.match(String(database.calls[0]!.values[8]), /client-content-canary/);
  assert.doesNotMatch(String(database.calls[0]!.values[10]), /client-content-canary/);
  assert.match(String(database.calls[0]!.values[10]), /contentHash/);
  assert.equal(database.calls[0]!.values[11], "journal:event-1");
  assert.equal(database.calls[0]!.values[12], "journal:event-1");
});

test("duplicate journal delivery is an explicit idempotent no-op", async () => {
  const database = new RecordingExecutor();
  database.results.push({ rows: [], rowCount: 0 });
  const repository = new EventJournalRepository(database);
  const inserted = await repository.append({
    schemaVersion: 1,
    eventId: "event-duplicate",
    runId: "run-1",
    conversationId: "conversation-1",
    sequence: 2,
    turn: 1,
    occurredAt,
    type: "run.completed",
    causationId: "request-1",
    audience: "persistence",
    sensitivity: "metadata",
    payload: { reason: "stop" },
  });
  assert.equal(inserted, false);
});

test("ephemeral message deltas never enter the durable journal", async () => {
  const database = new RecordingExecutor();
  const repository = new EventJournalRepository(database);
  const persisted = await repository.append({
    schemaVersion: 1,
    eventId: "event-delta",
    runId: "run-1",
    conversationId: "conversation-1",
    sequence: 1,
    turn: 1,
    occurredAt,
    type: "message.delta",
    causationId: "request-1",
    audience: "ui",
    sensitivity: "content",
    payload: { messageId: "message-1", index: 0, blockType: "text", delta: "secret" },
  });
  assert.equal(persisted, false);
  assert.equal(database.calls.length, 0);
});

test("outbox enqueue is caller-key idempotent and keeps payload out of SQL text", async () => {
  const database = new RecordingExecutor();
  database.results.push({ rows: [{ id: "job-1" }], rowCount: 1 });
  const repository = new OutboxRepository(database);
  const inserted = await repository.enqueue({
    id: "job-1",
    topic: "erasure.requested",
    aggregateType: "conversation",
    aggregateId: "conversation-1",
    idempotencyKey: "erase-conversation-1",
    payload: { canary: "outbox-content-canary" },
    availableAt: occurredAt,
    createdAt: occurredAt,
  });

  assert.equal(inserted, true);
  assert.match(database.calls[0]!.sql, /ON CONFLICT \(idempotency_key\) DO NOTHING/);
  assert.doesNotMatch(database.calls[0]!.sql, /outbox-content-canary/);
});

test("journal replay reads are ordered and validate envelope identity", async () => {
  const database = new RecordingExecutor();
  database.results.push({
    rows: [{
      journal_seq: "18",
      event_id: "event-replay",
      event: {
        schemaVersion: 1,
        eventId: "event-replay",
        runId: "run-1",
        conversationId: "conversation-1",
        sequence: 3,
        turn: 1,
        occurredAt,
        type: "run.completed",
        causationId: "request-1",
        audience: "persistence",
        sensitivity: "metadata",
        payload: { reason: "stop" },
      },
    }],
    rowCount: 1,
  });
  const repository = new EventJournalRepository(database);

  const rows = await repository.listAfter(17, 25);

  assert.equal(rows[0]?.journalSeq, 18);
  assert.equal(rows[0]?.event.eventId, "event-replay");
  assert.match(database.calls[0]!.sql, /ORDER BY journal_seq ASC/);
  assert.deepEqual(database.calls[0]!.values, [17, 25]);
});

test("C1 run replay resolves Last-Event-ID inside the same run and preserves event order", async () => {
  const database = new RecordingExecutor();
  database.results.push(
    { rows: [{ event_sequence: "2" }], rowCount: 1 },
    {
      rows: [{
        event_id: "event-3",
        event_sequence: "3",
        event: {
          schemaVersion: 1,
          eventId: "event-3",
          runId: "run-1",
          conversationId: "conversation-1",
          sequence: 3,
          turn: 1,
          occurredAt,
          type: "run.completed",
          causationId: "request-1",
          audience: "persistence",
          sensitivity: "metadata",
          payload: { reason: "stop" },
        },
      }],
      rowCount: 1,
    },
  );
  const repository = new EventJournalRepository(database);

  const rows = await repository.listRunEvents("run-1", "event-2", 25);

  assert.deepEqual(rows.map((event) => event.eventId), ["event-3"]);
  assert.match(database.calls[0]!.sql, /run_id = \$1 AND event_id = \$2/);
  assert.deepEqual(database.calls[0]!.values, ["run-1", "event-2"]);
  assert.match(database.calls[1]!.sql, /event_sequence > \$2/);
  assert.deepEqual(database.calls[1]!.values, ["run-1", 2, 25]);
});

test("C1 run replay rejects unavailable checkpoints and cross-run envelope drift", async () => {
  const unavailable = new RecordingExecutor();
  unavailable.results.push({ rows: [], rowCount: 0 });
  await assert.rejects(
    new EventJournalRepository(unavailable).listRunEvents("run-1", "missing"),
    /checkpoint eventId is not available/,
  );

  const drifted = new RecordingExecutor();
  drifted.results.push({
    rows: [{
      event_id: "event-0",
      event_sequence: 0,
      event: {
        schemaVersion: 1,
        eventId: "event-0",
        runId: "another-run",
        conversationId: "conversation-1",
        sequence: 0,
        turn: 0,
        occurredAt,
        type: "run.started",
        causationId: "request-1",
        audience: "persistence",
        sensitivity: "metadata",
        payload: { configKey: "local-qwen", provider: "ollama", model: "qwen3:4b" },
      },
    }],
    rowCount: 1,
  });
  await assert.rejects(
    new EventJournalRepository(drifted).listRunEvents("run-1"),
    /identity does not match/,
  );
});

test("consumer checkpoints advance monotonically and stale delivery is a no-op", async () => {
  const database = new RecordingExecutor();
  database.results.push(
    { rows: [{ journal_seq: "18" }], rowCount: 1 },
    { rows: [], rowCount: 0 },
  );
  const checkpoints = new ConsumerCheckpointRepository(database);
  const input = {
    consumerName: "search-index",
    journalSeq: 18,
    eventId: "event-replay",
    updatedAt: occurredAt,
  };

  assert.equal(await checkpoints.advance(input), true);
  assert.equal(await checkpoints.advance(input), false);
  assert.match(database.calls[0]!.sql, /consumer_checkpoints\.journal_seq < EXCLUDED\.journal_seq/);
});

test("erasure request tombstones and snapshots the complete scope before queueing work", async () => {
  const database = new RecordingExecutor();
  database.results.push(
    {
      rows: [{
        id: "erasure-1",
        subject_type: "conversation",
        subject_id: "conversation-1",
        requested_by: "user-1",
        reason_code: "retention.expired",
        status: "pending",
        requested_at: new Date(occurredAt),
        completed_at: null,
        last_error_code: null,
        created: true,
      }],
      rowCount: 1,
    },
    {
      rows: ERASURE_STORES.map((store) => ({
        store,
        status: "pending",
        attempts: "0",
        last_error_code: null,
        verified_at: null,
      })),
      rowCount: ERASURE_STORES.length,
    },
  );
  const repository = new ErasureRepository(database);

  const requested = await repository.request({
    id: "erasure-1",
    subjectType: "conversation",
    subjectId: "conversation-1",
    requestedBy: "user-1",
    reasonCode: "retention.expired",
    requestedAt: occurredAt,
    outboxJobId: "erasure-outbox-1",
  });

  assert.equal(requested.created, true);
  assert.deepEqual(requested.job.targets.map((target) => target.store), ERASURE_STORES);
  assert.equal(database.calls.length, 2);
  assert.match(database.calls[0]!.sql, /^WITH RECURSIVE requested_subject AS/);
  assert.match(database.calls[0]!.sql, /INSERT INTO erasure_tombstones/);
  assert.match(database.calls[0]!.sql, /INSERT INTO erasure_message_scope/);
  assert.match(database.calls[0]!.sql, /INSERT INTO erasure_attachment_objects/);
  assert.match(database.calls[0]!.sql, /UPDATE knowledge_chunks AS chunk/);
  assert.match(database.calls[0]!.sql, /erasure\.process\.requested/);
  assert.deepEqual(database.calls[0]!.values[6], [...ERASURE_STORES]);
});

test("search repository registers only pinned local models and keeps content parameterized", async () => {
  const database = new RecordingExecutor();
  database.results.push({
    rows: [{
      manifest_digest: embeddingManifestDigest(embeddingManifest),
      manifest: embeddingManifest,
      registered_at: new Date(occurredAt),
    }],
    rowCount: 1,
  });
  const repository = new KnowledgeSearchRepository(database);

  const stored = await repository.registerEmbeddingModel({
    manifest: embeddingManifest,
    registeredAt: occurredAt,
  });

  assert.equal(stored.manifestDigest, embeddingManifestDigest(embeddingManifest));
  assert.match(database.calls[0]!.sql, /INSERT INTO embedding_models/);
  assert.doesNotMatch(database.calls[0]!.sql, /nomic-embed-text/);
  assert.equal(database.calls[0]!.values[0], embeddingManifestDigest(embeddingManifest));

  await assert.rejects(
    repository.registerEmbeddingModel({
      manifest: {
        ...embeddingManifest,
        endpoint: "https://api.openai.com/v1/embeddings",
      },
      registeredAt: occurredAt,
    }),
    /local http or unix transport|outside the client boundary/,
  );
});

test("search repository writes source-linked chunks with citation and access policy", async () => {
  const database = new RecordingExecutor();
  database.results.push({ rows: [{ chunk_id: "chunk-1" }], rowCount: 1 });
  const repository = new KnowledgeSearchRepository(database);

  await repository.upsertChunk({
    chunkId: "chunk-1",
    sourceId: "source-1",
    citationId: "source-1#chunk-0",
    ordinal: 0,
    content: "restricted client content canary",
    contentHash: "c".repeat(64),
    accessPolicy: { visibility: "restricted", allowedUsers: ["user-1"] },
    manifest: embeddingManifest,
    embedding: [1, 0, 0],
    createdAt: occurredAt,
  });

  assert.match(database.calls[0]!.sql, /INSERT INTO knowledge_chunks/);
  assert.match(database.calls[0]!.sql, /INSERT INTO chunk_embeddings/);
  assert.doesNotMatch(database.calls[0]!.sql, /restricted client content canary/);
  assert.equal(database.calls[0]!.values[4], "restricted client content canary");
  assert.equal(database.calls[0]!.values[8], embeddingManifestDigest(embeddingManifest));
  assert.equal(database.calls[0]!.values[9], "[1,0,0]");
});

test("search applies access filtering before returning bounded candidates with citations", async () => {
  const database = new RecordingExecutor();
  database.results.push({
    rows: [{
      chunk_id: "chunk-1",
      source_id: "source-1",
      source_type: "document",
      source_uri: "docs://phase-b",
      source_version: "sha256:source",
      citation_id: "phase-b#chunk-0",
      ordinal: "0",
      content: "local embeddings stay inside the boundary",
      content_hash: "d".repeat(64),
      access_policy: { visibility: "restricted", allowedGroups: ["engineering"] },
      created_at: new Date(occurredAt),
      vector_score: 0.97,
      lexical_score: 0.12,
      combined_score: 0.82,
    }],
    rowCount: 1,
  });
  const repository = new KnowledgeSearchRepository(database);

  const rows = await repository.search({
    manifest: embeddingManifest,
    query: "local embeddings",
    embedding: [0.9, 0.1, 0],
    actorUserId: "user-2",
    groupIds: ["engineering"],
    limit: 5,
  });

  assert.equal(rows[0]?.citationId, "phase-b#chunk-0");
  assert.match(database.calls[0]!.sql, /kc\.tombstoned_at IS NULL/);
  assert.match(database.calls[0]!.sql, /access_policy/);
  assert.match(database.calls[0]!.sql, /LIMIT \$6/);
  assert.deepEqual(database.calls[0]!.values, [
    embeddingManifestDigest(embeddingManifest),
    "[0.9,0.1,0]",
    "local embeddings",
    "user-2",
    ["engineering"],
    5,
  ]);
});

test("the initial migration declares every B1 table and database append-only guards", async () => {
  const migration = await readFile(
    new URL("../migrations/20260819000100_initial_storage.sql", import.meta.url),
    "utf8",
  );
  for (const table of [
    "users", "conversations", "runs", "turns", "messages", "tool_calls",
    "tool_decisions", "approvals", "attachments", "event_journal",
    "audit_events", "outbox_jobs", "consumer_checkpoints", "erasure_jobs",
    "erasure_targets", "embedding_models", "knowledge_sources",
    "knowledge_chunks", "chunk_embeddings",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE ${table} \\(`));
  }
  assert.match(migration, /UNIQUE \(conversation_id, seq\)/);
  assert.match(migration, /CREATE TRIGGER messages_append_only/);
  assert.match(migration, /CREATE VIEW current_messages/);
  assert.match(migration, /CREATE EXTENSION IF NOT EXISTS vector VERSION '0\.8\.6'/);
  assert.match(migration, /CREATE INDEX chunk_embeddings_vector_idx/);
  assert.match(migration, /embedding vector\(768\) NOT NULL/);
  assert.doesNotMatch(migration, /raw_provider_payload/i);
});

test("the B6 migration adds tombstone scopes, retrieval views, and every erasure store", async () => {
  const migration = await readFile(
    new URL("../migrations/20260821000200_verified_erasure.sql", import.meta.url),
    "utf8",
  );
  for (const table of [
    "erasure_tombstones", "erasure_conversation_scope", "erasure_message_scope",
    "erasure_attachment_objects", "erasure_knowledge_sources",
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE ${table} \\(`));
  }
  for (const store of ERASURE_STORES) assert.match(migration, new RegExp(`'${store}'`));
  assert.match(migration, /CREATE OR REPLACE VIEW current_messages/);
  assert.match(migration, /CREATE VIEW retrievable_event_journal/);
  assert.match(migration, /CREATE CONSTRAINT TRIGGER messages_erasure_guard/);
  assert.match(migration, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(migration, /DROP CONSTRAINT audit_events_event_id_fkey/);
  assert.doesNotMatch(migration, /client-content-canary/);
});

test("applied migration content matches the immutable checksum manifest", async () => {
  const checksumsUrl = new URL("../migrations/checksums.json", import.meta.url);
  const manifestText = await readFile(checksumsUrl, "utf8");
  const manifest = JSON.parse(manifestText) as Record<string, string>;
  assert.deepEqual(Object.keys(manifest).sort(), [
    "20260819000100_initial_storage.sql",
    "20260821000200_verified_erasure.sql",
    "20260825000300_phase_c_command_gateway.sql",
    "20260825000400_phase_c_identity_approvals.sql",
    "20260825000500_phase_c_controls_reads.sql",
  ]);
  for (const [filename, digest] of Object.entries(manifest)) {
    const migration = await readFile(new URL(`../migrations/${filename}`, import.meta.url));
    assert.equal(createHash("sha256").update(migration).digest("hex"), digest);
  }
});

test("the C2 migration binds idempotent commands, messages, and preowned runs", async () => {
  const migration = await readFile(
    new URL("../migrations/20260825000300_phase_c_command_gateway.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /CREATE TABLE run_commands/);
  assert.match(migration, /UNIQUE \(user_id, idempotency_key\)/);
  assert.match(migration, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(migration, /runs_runtime_started_after_acceptance/);
  assert.match(migration, /UPDATE runs SET runtime_started_at = started_at/);
  const schema = await readFile(new URL("../schema.sql", import.meta.url), "utf8");
  assert.match(schema, /CREATE TABLE public\.run_commands/);
  assert.match(schema, /runtime_started_at timestamp with time zone/);
});

test("the C3 migration makes sessions, access grants, and approvals durable", async () => {
  const migration = await readFile(
    new URL("../migrations/20260825000400_phase_c_identity_approvals.sql", import.meta.url),
    "utf8",
  );
  for (const table of ["user_roles", "user_model_grants", "server_sessions"]) {
    assert.match(migration, new RegExp(`CREATE TABLE ${table} \\(`));
  }
  assert.match(migration, /token_sha256 text NOT NULL UNIQUE/);
  assert.match(migration, /resolution_session_id/);
  assert.match(migration, /approvals_authenticated_resolution/);
  assert.doesNotMatch(migration, /bearer_token|raw_token/i);
});

test("the C4 migration makes control reservations durable and audit pagination indexed", async () => {
  const migration = await readFile(
    new URL("../migrations/20260825000500_phase_c_controls_reads.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /CREATE TABLE run_control_reservations/);
  assert.match(migration, /UNIQUE \(user_id, idempotency_key\)/);
  assert.match(migration, /accounting_state IN \('reserved', 'measured', 'conservative'\)/);
  assert.match(migration, /run_control_model_active_idx/);
  assert.match(migration, /audit_events_recorded_idx/);
});
