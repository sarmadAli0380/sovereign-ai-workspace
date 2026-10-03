import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { approvalArgumentsHash } from "../approval.ts";
import { ConversationManager } from "../conversation-manager.ts";
import {
  AttachmentErasureStoreAdapter,
  ErasureCoordinator,
  SqlErasureStoreAdapter,
  type ErasureStoreAdapter,
} from "./erasure.ts";
import {
  AttachmentRepository,
  ApprovalRepository,
  ErasureRepository,
  EventJournalRepository,
  IdentityRepository,
  KnowledgeSearchRepository,
  MessageRepository,
  OutboxRepository,
  RunRepository,
  ToolRepository,
} from "./repositories/index.ts";
import { PgSqlExecutor } from "./pg.ts";
import { PostgresRunCommandStore } from "../server/command-store.ts";

const databaseUrl = process.env["STORAGE_TEST_DATABASE_URL"];

test("B1-B5 storage preserves history, journal, attachments, and local search", {
  skip: databaseUrl ? false : "set STORAGE_TEST_DATABASE_URL to a disposable migrated database",
}, async (context) => {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  context.after(() => pool.end());
  const database = new PgSqlExecutor(pool);

  const versions = await pool.query<{ server_version_num: string; extversion: string }>(
    `SELECT current_setting('server_version_num') AS server_version_num,
            extversion
     FROM pg_extension
     WHERE extname = 'vector'`,
  );
  assert.equal(versions.rows.length, 1);
  assert.match(versions.rows[0]!.server_version_num, /^18/);
  assert.equal(versions.rows[0]!.extversion, "0.8.6");

  const suffix = randomUUID();
  const userId = `user-${suffix}`;
  const conversationId = `conversation-${suffix}`;
  const runId = `run-${suffix}`;
  const turnId = `turn-${suffix}`;
  const firstMessageId = `message-1-${suffix}`;
  const revisedMessageId = `message-2-${suffix}`;
  const toolCallId = `tool-call-${suffix}`;
  const sessionId = `session-${suffix}`;
  const timestamp = "2026-08-19T09:00:00.000Z";
  const laterTimestamp = "2026-08-19T09:00:01.000Z";

  const identities = new IdentityRepository(database);
  await identities.createUser({
    id: userId,
    externalSubject: `oidc-${suffix}`,
    displayName: "Storage Test User",
    createdAt: timestamp,
  });
  await pool.query(
    `INSERT INTO user_roles (user_id, role, granted_by, granted_at)
     VALUES ($1, 'admin', $1, $2::timestamptz)`,
    [userId, timestamp],
  );
  await pool.query(
    `INSERT INTO user_model_grants (user_id, config_key, granted_by, granted_at)
     VALUES ($1, 'codex-default', $1, $2::timestamptz)`,
    [userId, timestamp],
  );
  await pool.query(
    `INSERT INTO server_sessions (
       id, user_id, token_sha256, status, issued_by, issued_at, expires_at
     ) VALUES ($1, $2, $3, 'active', $2, $4::timestamptz, $5::timestamptz)`,
    [sessionId, userId, "f".repeat(64), timestamp, "2026-08-20T09:00:00.000Z"],
  );
  await identities.createConversation({
    id: conversationId,
    createdBy: userId,
    title: "B1 integration",
    createdAt: timestamp,
  });

  const messages = new MessageRepository(database);
  await messages.append({
    conversationId,
    seq: 0,
    message: {
      schemaVersion: 1,
      messageId: firstMessageId,
      role: "user",
      createdAt: timestamp,
      content: [{ type: "text", text: "superseded-content-canary" }],
    },
  });
  await messages.supersede({
    conversationId,
    seq: 1,
    supersedesId: firstMessageId,
    message: {
      schemaVersion: 1,
      messageId: revisedMessageId,
      role: "user",
      createdAt: laterTimestamp,
      content: [{ type: "text", text: "current-content-canary" }],
    },
  });
  const current = await messages.listCurrent(conversationId);
  assert.deepEqual(current.map((item) => item.message.messageId), [revisedMessageId]);
  const reloaded = await ConversationManager.loadCurrent({
    conversationId,
    repository: messages,
    contextWindow: 8_192,
  });
  assert.deepEqual(
    reloaded.getHistory().map((message) =>
      message.role === "user" && Array.isArray(message.content)
        ? message.content[0]
        : message.content,
    ),
    [{ type: "text", text: "current-content-canary" }],
  );

  await assert.rejects(
    pool.query(`UPDATE messages SET role = 'assistant' WHERE id = $1`, [firstMessageId]),
    (error: unknown) =>
      typeof error === "object" && error !== null &&
      (error as { code?: string }).code === "55000",
  );

  const runs = new RunRepository(database);
  await runs.start({
    id: runId,
    conversationId,
    initiatedBy: userId,
    causationId: `request-${suffix}`,
    configKey: "codex-default",
    provider: "openai-codex",
    model: "fixture-model",
    startedAt: timestamp,
  });
  await runs.startTurn({
    id: turnId,
    runId,
    conversationId,
    turnNumber: 0,
    inputMessageId: revisedMessageId,
    startedAt: timestamp,
  });

  const tools = new ToolRepository(database);
  const toolArguments = { path: "README.md" } as const;
  await tools.recordRequest({
    runId,
    toolCallId,
    turnId,
    conversationId,
    toolName: "read_file",
    arguments: toolArguments,
    requestedAt: timestamp,
  });
  await tools.recordDecision({
    id: `decision-${suffix}`,
    runId,
    toolCallId,
    capability: "filesystem.read",
    capabilities: ["filesystem.read"],
    decision: "requireApproval",
    reasonCode: "policy.human-review",
    decidedAt: timestamp,
  });

  const approvals = new ApprovalRepository(database);
  await approvals.createPending({
    schemaVersion: 1,
    approvalId: `approval-${suffix}`,
    runId,
    conversationId,
    toolCall: { type: "toolCall", id: toolCallId, name: "read_file", arguments: toolArguments },
    argumentsHash: approvalArgumentsHash(toolArguments),
    capability: "filesystem.read",
    capabilities: ["filesystem.read"],
    reasonCode: "policy.human-review",
    requestedAt: timestamp,
    expiresAt: "2026-08-19T09:05:00.000Z",
  });
  await approvals.resolve({
    approvalId: `approval-${suffix}`,
    status: "approved",
    resolvedAt: laterTimestamp,
    resolvedBy: userId,
    resolutionSessionId: sessionId,
    resolutionRequestSha256: "e".repeat(64),
    reasonCode: "actor.approved",
  });
  await assert.rejects(
    approvals.resolve({
      approvalId: `approval-${suffix}`,
      status: "approved",
      resolvedAt: laterTimestamp,
      resolvedBy: userId,
      resolutionSessionId: sessionId,
      resolutionRequestSha256: "e".repeat(64),
    }),
    /resolve approval expected exactly one row, received 0/,
  );
  await tools.recordStarted(runId, toolCallId, laterTimestamp);
  await tools.recordCompleted({
    runId,
    toolCallId,
    isError: false,
    result: { content: "bounded-result" },
    completedAt: laterTimestamp,
  });

  const attachments = new AttachmentRepository(database);
  const attachmentId = `attachment-${suffix}`;
  await attachments.create({
    id: attachmentId,
    conversationId,
    messageId: revisedMessageId,
    objectKey: `sha256/${suffix}`,
    sha256: "a".repeat(64),
    byteSize: 12,
    mimeType: "text/plain",
    createdAt: timestamp,
  });
  assert.equal((await attachments.get(attachmentId))?.state, "available");
  assert.equal(await attachments.tombstoneAndEnqueueDeletion({
    id: attachmentId,
    outboxJobId: `attachment-delete-${suffix}`,
    tombstonedAt: laterTimestamp,
  }), true);
  const attachmentDeletion = await pool.query<{
    state: string;
    topic: string;
    payload: { attachmentId: string };
  }>(
    `SELECT a.state, o.topic, o.payload
     FROM attachments a
     JOIN outbox_jobs o ON o.aggregate_id = a.id
     WHERE a.id = $1 AND o.idempotency_key = 'attachment:delete:' || a.id`,
    [attachmentId],
  );
  assert.deepEqual(attachmentDeletion.rows, [{
    state: "tombstoned",
    topic: "attachment.delete.requested",
    payload: { attachmentId },
  }]);
  assert.equal(await attachments.markDeleted(attachmentId), true);
  assert.equal(await attachments.markDeleted(attachmentId), false);

  const journal = new EventJournalRepository(database);
  const eventId = `event-${suffix}`;
  assert.equal(await journal.append({
    schemaVersion: 1,
    eventId,
    runId,
    conversationId,
    sequence: 0,
    turn: 0,
    occurredAt: timestamp,
    type: "message.completed",
    causationId: `request-${suffix}`,
    audience: "persistence",
    sensitivity: "content",
    payload: {
      message: {
        schemaVersion: 1,
        messageId: revisedMessageId,
        role: "user",
        createdAt: laterTimestamp,
        content: [{ type: "text", text: "audit-redaction-canary" }],
      },
    },
  }), true);
  assert.equal(await journal.append({
    schemaVersion: 1,
    eventId,
    runId,
    conversationId,
    sequence: 0,
    turn: 0,
    occurredAt: timestamp,
    type: "message.completed",
    causationId: `request-${suffix}`,
    audience: "persistence",
    sensitivity: "content",
    payload: {
      message: {
        schemaVersion: 1,
        messageId: revisedMessageId,
        role: "user",
        createdAt: laterTimestamp,
        content: [{ type: "text", text: "audit-redaction-canary" }],
      },
    },
  }), false);
  const journalCounts = await pool.query<{
    journal_count: string;
    audit_count: string;
    outbox_count: string;
    audit_text: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM event_journal WHERE event_id = $1) AS journal_count,
       (SELECT count(*)::text FROM audit_events WHERE event_id = $1) AS audit_count,
       (SELECT count(*)::text FROM outbox_jobs WHERE idempotency_key = 'journal:' || $1) AS outbox_count,
       (SELECT metadata::text FROM audit_events WHERE event_id = $1) AS audit_text`,
    [eventId],
  );
  assert.equal(journalCounts.rows[0]!.journal_count, "1");
  assert.equal(journalCounts.rows[0]!.audit_count, "1");
  assert.equal(journalCounts.rows[0]!.outbox_count, "1");
  assert.doesNotMatch(journalCounts.rows[0]!.audit_text, /audit-redaction-canary/);
  assert.match(journalCounts.rows[0]!.audit_text, /contentHash/);

  const work = new OutboxRepository(database);
  const outboxInput = {
    id: `outbox-${suffix}`,
    topic: "erasure.requested",
    aggregateType: "conversation",
    aggregateId: conversationId,
    idempotencyKey: `erase-${conversationId}`,
    payload: { conversationId },
    availableAt: timestamp,
    createdAt: timestamp,
  } as const;
  assert.equal(await work.enqueue(outboxInput), true);
  assert.equal(await work.enqueue({ ...outboxInput, id: `outbox-retry-${suffix}` }), false);
  const journalSequence = await pool.query<{ journal_seq: string }>(
    `SELECT journal_seq::text FROM event_journal WHERE event_id = $1`,
    [eventId],
  );
  assert.equal(await work.advanceCheckpoint({
    consumerName: `consumer-${suffix}`,
    journalSeq: Number(journalSequence.rows[0]!.journal_seq),
    eventId,
    updatedAt: timestamp,
  }), true);

  const search = new KnowledgeSearchRepository(database);
  const embeddingManifest = {
    provider: "ollama" as const,
    model: "nomic-embed-text:v1.5",
    version: "v1.5",
    dimensions: 768,
    digest: `sha256:${"0".repeat(64)}` as const,
    endpoint: "http://127.0.0.1:11434/api/embed",
  };
  const embedding = Array.from({ length: 768 }, (_, index) => index === 0 ? 1 : 0);
  await search.registerEmbeddingModel({
    manifest: embeddingManifest,
    registeredAt: timestamp,
  });
  await search.upsertSource({
    sourceId: `source-${suffix}`,
    sourceType: "document",
    sourceUri: "docs://phase-b/b5",
    sourceVersion: "sha256:b5-source",
    title: "B5 local search",
    createdAt: timestamp,
  });
  await search.upsertChunk({
    chunkId: `chunk-${suffix}`,
    sourceId: `source-${suffix}`,
    citationId: "phase-b-b5#chunk-0",
    ordinal: 0,
    content: "B5 local embeddings stay inside the client boundary",
    contentHash: createHash("sha256")
      .update("B5 local embeddings stay inside the client boundary")
      .digest("hex"),
    accessPolicy: { visibility: "restricted", allowedGroups: ["engineering"] },
    manifest: embeddingManifest,
    embedding,
    createdAt: timestamp,
  });
  assert.deepEqual(await search.search({
    manifest: embeddingManifest,
    query: "local embeddings",
    embedding,
    actorUserId: userId,
    groupIds: [],
  }), []);
  const searchResults = await search.search({
    manifest: embeddingManifest,
    query: "local embeddings",
    embedding,
    actorUserId: userId,
    groupIds: ["engineering"],
  });
  assert.equal(searchResults[0]?.citationId, "phase-b-b5#chunk-0");
  assert.equal(searchResults[0]?.sourceUri, "docs://phase-b/b5");

  await runs.completeTurn({
    id: turnId,
    stopReason: "stop",
    budgetTokens: 120,
    budgetSource: "anchored",
    usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120 },
    completedAt: laterTimestamp,
  });
  await runs.finish({
    id: runId,
    status: "completed",
    terminalReason: "stop",
    usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120 },
    completedAt: laterTimestamp,
  });
  await assert.rejects(
    runs.finish({
      id: runId,
      status: "completed",
      terminalReason: "stop",
      completedAt: laterTimestamp,
    }),
    /finish run expected exactly one row, received 0/,
  );
});

test("B6 tombstones immediately and completes only after retrieval-side absence proof", {
  skip: databaseUrl ? false : "set STORAGE_TEST_DATABASE_URL to a disposable migrated database",
}, async (context) => {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  context.after(() => pool.end());
  const database = new PgSqlExecutor(pool);
  const suffix = randomUUID();
  const userId = `b6-user-${suffix}`;
  const conversationId = `b6-conversation-${suffix}`;
  const messageId = `b6-message-${suffix}`;
  const runId = `b6-run-${suffix}`;
  const eventId = `b6-event-${suffix}`;
  const attachmentId = `b6-attachment-${suffix}`;
  const sourceId = `b6-source-${suffix}`;
  const chunkId = `b6-chunk-${suffix}`;
  const erasureId = `b6-erasure-${suffix}`;
  const timestamp = "2026-08-21T12:00:00.000Z";
  const canary = `b6-retrieval-canary-${suffix}`;

  const identities = new IdentityRepository(database);
  await identities.createUser({
    id: userId,
    externalSubject: `b6-oidc-${suffix}`,
    displayName: `B6 User ${suffix}`,
    createdAt: timestamp,
  });
  await identities.createConversation({
    id: conversationId,
    createdBy: userId,
    title: canary,
    createdAt: timestamp,
  });

  const messages = new MessageRepository(database);
  await messages.append({
    conversationId,
    seq: 0,
    message: {
      schemaVersion: 1,
      messageId,
      role: "user",
      createdAt: timestamp,
      content: [{ type: "text", text: canary }],
    },
  });

  const runs = new RunRepository(database);
  await runs.start({
    id: runId,
    conversationId,
    initiatedBy: userId,
    causationId: `b6-request-${suffix}`,
    configKey: "codex-default",
    provider: "openai-codex",
    model: "fixture-model",
    startedAt: timestamp,
  });
  const journal = new EventJournalRepository(database);
  assert.equal(await journal.append({
    schemaVersion: 1,
    eventId,
    runId,
    conversationId,
    sequence: 0,
    turn: 0,
    occurredAt: timestamp,
    type: "message.completed",
    causationId: `b6-request-${suffix}`,
    audience: "persistence",
    sensitivity: "content",
    payload: {
      message: {
        schemaVersion: 1,
        messageId,
        role: "user",
        createdAt: timestamp,
        content: [{ type: "text", text: canary }],
      },
    },
  }), true);

  const attachments = new AttachmentRepository(database);
  const objectKey = `sha256/${suffix}`;
  await attachments.create({
    id: attachmentId,
    conversationId,
    messageId,
    objectKey,
    sha256: "e".repeat(64),
    byteSize: 12,
    mimeType: "text/plain",
    originalName: `${canary}.txt`,
    createdAt: timestamp,
  });

  const search = new KnowledgeSearchRepository(database);
  const manifest = {
    provider: "ollama" as const,
    model: "nomic-embed-text:v1.5",
    version: "v1.5",
    dimensions: 768,
    digest: `sha256:${"0".repeat(64)}` as const,
    endpoint: "http://127.0.0.1:11434/api/embed",
  };
  const embedding = Array.from({ length: 768 }, (_, index) => index === 0 ? 1 : 0);
  await search.registerEmbeddingModel({ manifest, registeredAt: timestamp });
  await search.upsertSource({
    sourceId,
    sourceType: "message",
    sourceUri: `message://${messageId}`,
    sourceVersion: `sha256:${"f".repeat(64)}`,
    title: canary,
    messageId,
    createdAt: timestamp,
  });
  await search.upsertChunk({
    chunkId,
    sourceId,
    citationId: `${messageId}#0`,
    ordinal: 0,
    content: canary,
    contentHash: createHash("sha256").update(canary).digest("hex"),
    accessPolicy: { visibility: "public" },
    manifest,
    embedding,
    createdAt: timestamp,
  });
  assert.equal((await search.search({
    manifest,
    query: canary,
    embedding,
    actorUserId: userId,
  }))[0]?.chunkId, chunkId);

  const lateMessageId = `b6-late-message-${suffix}`;
  const lateWriter = await pool.connect();
  await lateWriter.query("BEGIN");
  await lateWriter.query(
    `INSERT INTO messages (
       id, conversation_id, seq, schema_version, role, content, created_at
     ) VALUES ($1, $2, 1, 1, 'user', $3::jsonb, $4::timestamptz)`,
    [
      lateMessageId,
      conversationId,
      JSON.stringify({
        schemaVersion: 1,
        messageId: lateMessageId,
        role: "user",
        createdAt: timestamp,
        content: [{ type: "text", text: "late write must abort" }],
      }),
      timestamp,
    ],
  );

  const erasure = new ErasureRepository(database);
  const requested = await erasure.request({
    id: erasureId,
    subjectType: "conversation",
    subjectId: conversationId,
    requestedBy: userId,
    reasonCode: "retention.expired",
    requestedAt: timestamp,
    outboxJobId: `b6-outbox-${suffix}`,
  });
  assert.equal(requested.created, true);
  assert.equal((await erasure.request({
    id: `b6-erasure-retry-${suffix}`,
    subjectType: "conversation",
    subjectId: conversationId,
    requestedBy: userId,
    reasonCode: "retention.expired",
    requestedAt: timestamp,
    outboxJobId: `b6-outbox-retry-${suffix}`,
  })).created, false);
  try {
    await assert.rejects(
      lateWriter.query("COMMIT"),
      (error: unknown) =>
        typeof error === "object" && error !== null &&
        (error as { code?: string }).code === "55000",
    );
  } finally {
    await lateWriter.query("ROLLBACK").catch(() => undefined);
    lateWriter.release();
  }
  assert.equal((await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM messages WHERE id = $1`, [lateMessageId],
  )).rows[0]!.count, "0");

  assert.deepEqual(await messages.listCurrent(conversationId), []);
  assert.equal(await messages.getById(messageId), null);
  assert.deepEqual(await search.search({
    manifest,
    query: canary,
    embedding,
    actorUserId: userId,
  }), []);
  const journalSequence = await pool.query<{ journal_seq: string }>(
    `SELECT journal_seq::text FROM event_journal WHERE event_id = $1`,
    [eventId],
  );
  const visibleJournal = await journal.listAfter(
    Number(journalSequence.rows[0]!.journal_seq) - 1,
    10,
  );
  assert.equal(visibleJournal.some((entry) => entry.event.eventId === eventId), false);

  const objectKeys = new Set([objectKey]);
  const attachmentAdapter = new AttachmentErasureStoreAdapter({
    repository: erasure,
    objectStore: {
      async delete(key) { objectKeys.delete(key); },
      async exists(key) { return objectKeys.has(key); },
    },
  });
  const memoryAdapter = (store: "cache" | "temporary_derivatives" | "provider_payloads") => {
    const residue = new Set([`${store}:${conversationId}`]);
    return {
      store,
      async erase() { residue.clear(); },
      async findResidue() { return [...residue]; },
    } satisfies ErasureStoreAdapter;
  };
  const coordinator = new ErasureCoordinator({
    repository: erasure,
    adapters: [
      attachmentAdapter,
      new SqlErasureStoreAdapter(erasure, "embeddings"),
      new SqlErasureStoreAdapter(erasure, "search"),
      memoryAdapter("cache"),
      memoryAdapter("temporary_derivatives"),
      memoryAdapter("provider_payloads"),
      new SqlErasureStoreAdapter(erasure, "postgres"),
    ],
    clock: () => "2026-08-21T12:00:01.000Z",
  });
  const completed = await coordinator.process(erasureId);
  assert.equal(completed.status, "completed");
  assert.equal(completed.targets.every((target) => target.status === "verified"), true);

  const proof = await pool.query<{
    messages: string;
    attachments: string;
    sources: string;
    chunks: string;
    embeddings: string;
    journal: string;
    audit: string;
    audit_text: string;
    outbox: string;
    attachment_scope: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM messages WHERE id = $1) AS messages,
       (SELECT count(*)::text FROM attachments WHERE id = $2) AS attachments,
       (SELECT count(*)::text FROM knowledge_sources WHERE id = $3) AS sources,
       (SELECT count(*)::text FROM knowledge_chunks WHERE id = $4) AS chunks,
       (SELECT count(*)::text FROM chunk_embeddings WHERE chunk_id = $4) AS embeddings,
       (SELECT count(*)::text FROM event_journal WHERE event_id = $5) AS journal,
       (SELECT count(*)::text FROM audit_events WHERE event_id = $5) AS audit,
       (SELECT metadata::text FROM audit_events WHERE event_id = $5) AS audit_text,
       (SELECT count(*)::text FROM outbox_jobs WHERE idempotency_key = 'erasure:process:' || $6) AS outbox,
       (SELECT count(*)::text FROM erasure_attachment_objects WHERE erasure_job_id = $6) AS attachment_scope`,
    [messageId, attachmentId, sourceId, chunkId, eventId, erasureId],
  );
  assert.deepEqual(proof.rows[0], {
    messages: "0",
    attachments: "0",
    sources: "0",
    chunks: "0",
    embeddings: "0",
    journal: "0",
    audit: "1",
    audit_text: proof.rows[0]!.audit_text,
    outbox: "1",
    attachment_scope: "0",
  });
  assert.doesNotMatch(proof.rows[0]!.audit_text, new RegExp(canary));
  assert.equal(objectKeys.size, 0);
  assert.deepEqual(await search.search({
    manifest,
    query: canary,
    embedding,
    actorUserId: userId,
  }), []);
});

test("B6 message erasure follows the revision chain without deleting sibling history", {
  skip: databaseUrl ? false : "set STORAGE_TEST_DATABASE_URL to a disposable migrated database",
}, async (context) => {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  context.after(() => pool.end());
  const database = new PgSqlExecutor(pool);
  const suffix = randomUUID();
  const userId = `b6-revision-user-${suffix}`;
  const conversationId = `b6-revision-conversation-${suffix}`;
  const originalId = `b6-original-${suffix}`;
  const revisionId = `b6-revision-${suffix}`;
  const siblingId = `b6-sibling-${suffix}`;
  const erasureId = `b6-message-erasure-${suffix}`;
  const timestamp = "2026-08-21T13:00:00.000Z";
  const identities = new IdentityRepository(database);
  await identities.createUser({
    id: userId,
    externalSubject: `b6-revision-oidc-${suffix}`,
    displayName: "Revision User",
    createdAt: timestamp,
  });
  await identities.createConversation({
    id: conversationId,
    createdBy: userId,
    title: "keep this conversation",
    createdAt: timestamp,
  });
  const messages = new MessageRepository(database);
  await messages.append({
    conversationId,
    seq: 0,
    message: {
      schemaVersion: 1, messageId: originalId, role: "user", createdAt: timestamp,
      content: [{ type: "text", text: "erase original" }],
    },
  });
  await messages.supersede({
    conversationId,
    seq: 1,
    supersedesId: originalId,
    message: {
      schemaVersion: 1, messageId: revisionId, role: "user", createdAt: timestamp,
      content: [{ type: "text", text: "erase revision" }],
    },
  });
  await messages.append({
    conversationId,
    seq: 2,
    message: {
      schemaVersion: 1, messageId: siblingId, role: "user", createdAt: timestamp,
      content: [{ type: "text", text: "keep sibling" }],
    },
  });

  const erasure = new ErasureRepository(database);
  await erasure.request({
    id: erasureId,
    subjectType: "message",
    subjectId: originalId,
    requestedBy: userId,
    reasonCode: "user.requested",
    requestedAt: timestamp,
    outboxJobId: `b6-message-outbox-${suffix}`,
  });
  assert.deepEqual((await erasure.getScope(erasureId)).messageIds, [originalId, revisionId].sort());
  assert.deepEqual(
    (await messages.listCurrent(conversationId)).map((message) => message.message.messageId),
    [siblingId],
  );

  const emptyAdapter = (store: "cache" | "temporary_derivatives" | "provider_payloads") => ({
    store,
    async erase() {},
    async findResidue() { return []; },
  }) satisfies ErasureStoreAdapter;
  const coordinator = new ErasureCoordinator({
    repository: erasure,
    adapters: [
      new AttachmentErasureStoreAdapter({
        repository: erasure,
        objectStore: { async delete() {}, async exists() { return false; } },
      }),
      new SqlErasureStoreAdapter(erasure, "embeddings"),
      new SqlErasureStoreAdapter(erasure, "search"),
      emptyAdapter("cache"),
      emptyAdapter("temporary_derivatives"),
      emptyAdapter("provider_payloads"),
      new SqlErasureStoreAdapter(erasure, "postgres"),
    ],
    clock: () => "2026-08-21T13:00:01.000Z",
  });
  assert.equal((await coordinator.process(erasureId)).status, "completed");

  const remaining = await pool.query<{ id: string }>(
    `SELECT id FROM messages WHERE conversation_id = $1 ORDER BY seq`,
    [conversationId],
  );
  assert.deepEqual(remaining.rows.map((row) => row.id), [siblingId]);
  assert.equal((await pool.query<{ title: string }>(
    `SELECT title FROM conversations WHERE id = $1`, [conversationId],
  )).rows[0]!.title, "keep this conversation");
  const retried = await erasure.request({
    id: `b6-message-erasure-retry-${suffix}`,
    subjectType: "message",
    subjectId: originalId,
    requestedBy: userId,
    reasonCode: "user.requested",
    requestedAt: timestamp,
    outboxJobId: `b6-message-outbox-retry-${suffix}`,
  });
  assert.equal(retried.created, false);
  assert.equal(retried.job.id, erasureId);
});

test("B6 user erasure scrubs the profile and every owned conversation", {
  skip: databaseUrl ? false : "set STORAGE_TEST_DATABASE_URL to a disposable migrated database",
}, async (context) => {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  context.after(() => pool.end());
  const database = new PgSqlExecutor(pool);
  const suffix = randomUUID();
  const userId = `b6-profile-user-${suffix}`;
  const timestamp = "2026-08-21T14:00:00.000Z";
  const conversations = [`b6-user-conversation-a-${suffix}`, `b6-user-conversation-b-${suffix}`];
  const messagesByConversation = conversations.map((id, index) => ({
    conversationId: id,
    messageId: `b6-user-message-${index}-${suffix}`,
  }));
  const identities = new IdentityRepository(database);
  await identities.createUser({
    id: userId,
    externalSubject: `b6-profile-oidc-${suffix}`,
    displayName: "Erase This Profile",
    createdAt: timestamp,
  });
  const sessionId = `b6-profile-session-${suffix}`;
  const rawSessionDigest = "d".repeat(64);
  await pool.query(
    `INSERT INTO user_roles (user_id, role, granted_by, granted_at)
     VALUES ($1, 'member', $1, $2::timestamptz)`,
    [userId, timestamp],
  );
  await pool.query(
    `INSERT INTO user_model_grants (user_id, config_key, granted_by, granted_at)
     VALUES ($1, 'local-qwen', $1, $2::timestamptz)`,
    [userId, timestamp],
  );
  await pool.query(
    `INSERT INTO server_sessions (
       id, user_id, token_sha256, status, issued_by, issued_at, expires_at
     ) VALUES ($1, $2, $3, 'active', $2, $4::timestamptz, $5::timestamptz)`,
    [sessionId, userId, rawSessionDigest, timestamp, "2026-08-22T14:00:00.000Z"],
  );
  const messages = new MessageRepository(database);
  for (const [index, item] of messagesByConversation.entries()) {
    await identities.createConversation({
      id: item.conversationId,
      createdBy: userId,
      title: `Erase conversation ${index}`,
      createdAt: timestamp,
    });
    await messages.append({
      conversationId: item.conversationId,
      seq: 0,
      message: {
        schemaVersion: 1,
        messageId: item.messageId,
        role: "user",
        createdAt: timestamp,
        content: [{ type: "text", text: `erase user content ${index}` }],
      },
    });
  }
  const commandRunId = `b6-user-command-run-${suffix}`;
  await new PostgresRunCommandStore(database).accept({
    commandId: `b6-user-command-${suffix}`,
    runId: commandRunId,
    conversationId: conversations[0]!,
    userId,
    sessionId,
    isAdmin: false,
    idempotencyKey: `b6-erasure-key-${suffix}`,
    requestSha256: "c".repeat(64),
    message: {
      schemaVersion: 1,
      messageId: `b6-user-command-message-${suffix}`,
      role: "user",
      createdAt: timestamp,
      content: [{ type: "text", text: "erase command content" }],
    },
    configKey: "local-qwen",
    maxTurns: 2,
    causationId: `b6-user-command-request-${suffix}`,
    provider: "ollama",
    model: "qwen3:4b",
    acceptedAt: timestamp,
  });

  const erasureId = `b6-user-erasure-${suffix}`;
  const erasure = new ErasureRepository(database);
  await erasure.request({
    id: erasureId,
    subjectType: "user",
    subjectId: userId,
    requestedBy: userId,
    reasonCode: "user.requested",
    requestedAt: timestamp,
    outboxJobId: `b6-user-outbox-${suffix}`,
  });
  for (const conversationId of conversations) {
    assert.deepEqual(await messages.listCurrent(conversationId), []);
  }

  const emptyAdapter = (store: "cache" | "temporary_derivatives" | "provider_payloads") => ({
    store,
    async erase() {},
    async findResidue() { return []; },
  }) satisfies ErasureStoreAdapter;
  const coordinator = new ErasureCoordinator({
    repository: erasure,
    adapters: [
      new AttachmentErasureStoreAdapter({
        repository: erasure,
        objectStore: { async delete() {}, async exists() { return false; } },
      }),
      new SqlErasureStoreAdapter(erasure, "embeddings"),
      new SqlErasureStoreAdapter(erasure, "search"),
      emptyAdapter("cache"),
      emptyAdapter("temporary_derivatives"),
      emptyAdapter("provider_payloads"),
      new SqlErasureStoreAdapter(erasure, "postgres"),
    ],
    clock: () => "2026-08-21T14:00:01.000Z",
  });
  assert.equal((await coordinator.process(erasureId)).status, "completed");

  const profile = await pool.query<{
    external_subject: string;
    display_name: string;
    status: string;
    titled_conversations: string;
    messages: string;
    roles: string;
    model_grants: string;
    active_sessions: string;
    original_session_digests: string;
    run_commands: string;
    bound_commands: string;
  }>(
    `SELECT external_subject, display_name, status,
       (SELECT count(*)::text FROM conversations
        WHERE created_by = users.id AND title IS NOT NULL) AS titled_conversations,
       (SELECT count(*)::text FROM messages
        WHERE conversation_id IN (SELECT id FROM conversations WHERE created_by = users.id)) AS messages,
       (SELECT count(*)::text FROM user_roles WHERE user_id = users.id) AS roles,
       (SELECT count(*)::text FROM user_model_grants WHERE user_id = users.id) AS model_grants,
       (SELECT count(*)::text FROM server_sessions
        WHERE user_id = users.id AND status = 'active') AS active_sessions,
       (SELECT count(*)::text FROM server_sessions
        WHERE user_id = users.id AND token_sha256 = $2) AS original_session_digests,
       (SELECT count(*)::text FROM run_commands WHERE user_id = users.id) AS run_commands,
       (SELECT count(*)::text FROM runs WHERE id = $3 AND command_id IS NOT NULL) AS bound_commands
     FROM users WHERE id = $1`,
    [userId, rawSessionDigest, commandRunId],
  );
  assert.deepEqual(profile.rows[0], {
    external_subject: `erased:${erasureId}`,
    display_name: "[erased]",
    status: "disabled",
    titled_conversations: "0",
    messages: "0",
    roles: "0",
    model_grants: "0",
    active_sessions: "0",
    original_session_digests: "0",
    run_commands: "0",
    bound_commands: "0",
  });
});
