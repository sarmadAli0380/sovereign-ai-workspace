import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { RUN_EVENT_SCHEMA_VERSION, type RunEvent } from "../events.ts";
import { PRODUCT_MESSAGE_SCHEMA_VERSION } from "../messages/envelope.ts";
import { PgSqlExecutor } from "../storage/pg.ts";
import {
  AttachmentRepository,
  EventJournalRepository,
  IdentityRepository,
  MessageRepository,
  RunRepository,
} from "../storage/repositories/index.ts";
import { PostgresProductReadStore } from "./product-reads.ts";
import { PostgresRunControlGateway, RunControlError } from "./run-controls.ts";

const databaseUrl = process.env["STORAGE_TEST_DATABASE_URL"];

test("C4 live PostgreSQL: controls are atomic and product reads are bounded projections", {
  skip: databaseUrl ? false : "set STORAGE_TEST_DATABASE_URL to a disposable migrated database",
}, async (context) => {
  const pool = new Pool({ connectionString: databaseUrl, max: 3 });
  context.after(() => pool.end());
  const database = new PgSqlExecutor(pool);
  const suffix = randomUUID();
  const userId = `c4-user-${suffix}`;
  const conversationId = `c4-conversation-${suffix}`;
  const at = new Date().toISOString();
  const identities = new IdentityRepository(database);
  await identities.createUser({ id: userId, externalSubject: userId, displayName: "C4 fixture", createdAt: at });
  await identities.createConversation({ id: conversationId, createdBy: userId, createdAt: at });

  const controls = new PostgresRunControlGateway({
    pool,
    policy: {
      maxConcurrentPerUser: 1, maxConcurrentPerModel: 1,
      maxRunsPerUserPerWindow: 10, rateWindowMs: 60_000,
      maxTokensPerUserPerWindow: 1_000, maxSpendUsdPerUserPerWindow: 1,
      budgetWindowMs: 60_000, leaseTtlMs: 60_000,
    },
  });
  const first = await controls.acquire({
    runId: `c4-control-run-1-${suffix}`, userId, idempotencyKey: `caller-1-${suffix}`,
    requestSha256: "a".repeat(64), configKey: "local-qwen", provider: "ollama",
    model: "qwen3:4b", reservedTokens: 100, reservedCostUsd: 0,
  });
  await assert.rejects(controls.acquire({
    runId: `c4-control-run-2-${suffix}`, userId, idempotencyKey: `caller-2-${suffix}`,
    requestSha256: "b".repeat(64), configKey: "local-qwen", provider: "ollama",
    model: "qwen3:4b", reservedTokens: 100, reservedCostUsd: 0,
  }), (error: unknown) => error instanceof RunControlError && error.code === "control.user-concurrency-exhausted");
  await first.settle({ tokens: 40, costUsd: 0, measured: true });
  const second = await controls.acquire({
    runId: `c4-control-run-2-${suffix}`, userId, idempotencyKey: `caller-2-${suffix}`,
    requestSha256: "b".repeat(64), configKey: "local-qwen", provider: "ollama",
    model: "qwen3:4b", reservedTokens: 100, reservedCostUsd: 0,
  });
  await second.release();

  const messageId = `c4-message-${suffix}`;
  await new MessageRepository(database).append({
    conversationId,
    seq: 0,
    message: {
      schemaVersion: PRODUCT_MESSAGE_SCHEMA_VERSION,
      messageId,
      role: "user",
      createdAt: at,
      content: [{ type: "text", text: "bounded C4 history" }],
    },
  });
  const sha = "c".repeat(64);
  const objectSuffix = suffix.replaceAll("-", "").slice(0, 32);
  await new AttachmentRepository(database).create({
    id: `sha256:${sha}:${suffix}`,
    conversationId,
    messageId,
    objectKey: `sha256/cc/${sha}/${objectSuffix}`,
    sha256: sha,
    byteSize: 12,
    mimeType: "text/plain",
    createdAt: at,
  });
  const runId = `c4-read-run-${suffix}`;
  await new RunRepository(database).start({
    id: runId, conversationId, initiatedBy: userId, causationId: `request-${suffix}`,
    configKey: "local-qwen", provider: "ollama", model: "qwen3:4b", startedAt: at,
  });
  const started: RunEvent = {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    eventId: `c4-event-${suffix}`,
    runId,
    conversationId,
    sequence: 0,
    turn: 0,
    occurredAt: at,
    type: "run.started",
    causationId: `request-${suffix}`,
    audience: "persistence",
    sensitivity: "metadata",
    payload: { configKey: "local-qwen", provider: "ollama", model: "qwen3:4b" },
  };
  await new EventJournalRepository(database).append(started);

  const reads = new PostgresProductReadStore(database);
  assert.equal((await reads.listMessages(conversationId, -1, 1))[0]?.message.messageId, messageId);
  const attachment = (await reads.listAttachments(conversationId, undefined, 1))[0]!;
  assert.equal("objectKey" in attachment, false);
  assert.equal((await reads.getRun(runId))?.status, "running");
  const audit = await reads.listAudit(0, 100);
  assert.ok(audit.some((event) => event.eventId === started.eventId));
  assert.equal(JSON.stringify(audit).includes("bounded C4 history"), false);
});
