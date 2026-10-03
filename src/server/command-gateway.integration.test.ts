import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { RUN_EVENT_SCHEMA_VERSION, type RunEvent } from "../events.ts";
import { PRODUCT_MESSAGE_SCHEMA_VERSION, type ProductMessageEnvelope } from "../messages/envelope.ts";
import { PgSqlExecutor } from "../storage/pg.ts";
import { EventJournalRepository, IdentityRepository, MessageRepository } from "../storage/repositories/index.ts";
import { RunHistoryProjector } from "../storage/run-history-projector.ts";
import { PostgresRunCommandStore, RunCommandConflictError } from "./command-store.ts";
import { PostgresServerAccessController } from "./storage.ts";

const databaseUrl = process.env["STORAGE_TEST_DATABASE_URL"];

test("C2 live PostgreSQL: command ownership is idempotent and projection remains ordered", {
  skip: databaseUrl ? false : "set STORAGE_TEST_DATABASE_URL to a disposable migrated database",
}, async (context) => {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  context.after(() => pool.end());
  const database = new PgSqlExecutor(pool);
  const suffix = randomUUID();
  const userId = `c2-user-${suffix}`;
  const conversationId = `c2-conversation-${suffix}`;
  const runId = `c2-run-${suffix}`;
  const commandId = `c2-command-${suffix}`;
  const messageId = `c2-user-message-${suffix}`;
  const at = new Date().toISOString();
  const identities = new IdentityRepository(database);
  await identities.createUser({ id: userId, externalSubject: userId, displayName: "C2 fixture", createdAt: at });
  await identities.createConversation({ id: conversationId, createdBy: userId, createdAt: at });

  const message: ProductMessageEnvelope = {
    schemaVersion: PRODUCT_MESSAGE_SCHEMA_VERSION,
    messageId,
    role: "user",
    createdAt: at,
    content: [{ type: "text", text: "live c2 command" }],
  };
  const input = {
    commandId,
    runId,
    conversationId,
    userId,
    sessionId: `session-${suffix}`,
    isAdmin: false,
    idempotencyKey: `caller-${suffix}`,
    requestSha256: "a".repeat(64),
    message,
    configKey: "local-qwen",
    maxTurns: 2,
    causationId: `request-${suffix}`,
    provider: "ollama",
    model: "qwen3:4b",
    acceptedAt: at,
  };
  const commands = new PostgresRunCommandStore(database);
  const first = await commands.accept(input);
  const retry = await commands.accept({
    ...input,
    commandId: `another-command-${suffix}`,
    runId: `another-run-${suffix}`,
    message: { ...message, messageId: `another-message-${suffix}` },
    causationId: `another-request-${suffix}`,
  });
  assert.equal(first.created, true);
  assert.equal(retry.created, false);
  assert.equal(retry.runId, runId);
  await assert.rejects(commands.accept({ ...input, requestSha256: "b".repeat(64) }), RunCommandConflictError);

  const principal = { sessionId: input.sessionId, userId, roles: ["member" as const], allowedConfigKeys: ["local-qwen"] };
  assert.equal(await new PostgresServerAccessController(database).authorizeRun(principal, runId), true);

  const journal = new EventJournalRepository(database);
  const projector = new RunHistoryProjector(database);
  const started: RunEvent = {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    eventId: `c2-started-${suffix}`,
    runId,
    conversationId,
    sequence: 0,
    turn: 0,
    occurredAt: new Date(Date.parse(at) + 1).toISOString(),
    type: "run.started",
    causationId: input.causationId,
    audience: "persistence",
    sensitivity: "metadata",
    payload: { configKey: "local-qwen", provider: "ollama", model: "qwen3:4b" },
  };
  const startAppend = await journal.appendWithOutbox(started);
  assert.ok(startAppend.journalSeq);
  await projector.apply({ deliveryId: started.eventId, journalSeq: startAppend.journalSeq!, event: started });

  const assistantId = `c2-assistant-${suffix}`;
  const completed: RunEvent = {
    ...started,
    eventId: `c2-completed-${suffix}`,
    sequence: 1,
    turn: 1,
    occurredAt: new Date(Date.parse(at) + 2).toISOString(),
    type: "message.completed",
    sensitivity: "content",
    payload: {
      message: {
        schemaVersion: PRODUCT_MESSAGE_SCHEMA_VERSION,
        messageId: assistantId,
        role: "assistant",
        createdAt: new Date(Date.parse(at) + 2).toISOString(),
        content: [{ type: "text", text: "hello" }],
        provider: { api: "openai-completions", provider: "ollama", model: "qwen3:4b", configKey: "local-qwen" },
        assistant: { stopReason: "stop" },
        usage: {
          inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2,
          costUsd: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    },
  };
  const completedAppend = await journal.appendWithOutbox(completed);
  assert.ok(completedAppend.journalSeq);
  await projector.apply({ deliveryId: completed.eventId, journalSeq: completedAppend.journalSeq!, event: completed });
  const history = await new MessageRepository(database).listAllCurrent(conversationId);
  assert.deepEqual(history.map((stored) => stored.message.messageId), [messageId, assistantId]);
  assert.deepEqual(history.map((stored) => stored.seq), [0, 1]);
});
