import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  createModels,
  type Api,
  type AssistantMessage,
  type Model,
  type Models,
  type StreamOptions,
  type Usage,
} from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Pool } from "pg";
import type { ConfigEntry } from "../config.ts";
import { ConversationManager } from "../conversation-manager.ts";
import { run } from "../run.ts";
import { DurableJournalSink } from "./durable-journal.ts";
import { PgSqlExecutor } from "./pg.ts";
import { EventJournalRepository, IdentityRepository, MessageRepository, RunRepository } from "./repositories/index.ts";
import { RunHistoryProjector } from "./run-history-projector.ts";

const databaseUrl = process.env["STORAGE_TEST_DATABASE_URL"];
const entry: ConfigEntry = { provider: "faux", modelId: "interrupted", maxTokens: 64 };
const usage: Usage = {
  input: 3,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 4,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function modelFixture(): Model<Api> {
  const provider = fauxProvider({
    provider: "faux",
    models: [{ id: "interrupted", contextWindow: 8_192, maxTokens: 64 }],
  });
  const models = createModels();
  models.setProvider(provider.provider);
  const model = models.getModel("faux", "interrupted");
  if (!model) throw new Error("fixture model was not registered");
  return model;
}

function interruptedModels(): Models {
  return {
    stream(_model: Model<Api>, _context: unknown, options?: StreamOptions) {
      const stream = createAssistantMessageEventStream();
      const base: AssistantMessage = {
        role: "assistant",
        content: [],
        api: "faux",
        provider: "faux",
        model: "interrupted",
        usage,
        stopReason: "aborted",
        timestamp: Date.parse("2026-08-21T14:00:00.000Z"),
      };
      const abort = (): void => stream.push({ type: "error", reason: "aborted", error: base });
      options?.signal?.addEventListener("abort", abort, { once: true });
      queueMicrotask(() => {
        stream.push({ type: "start", partial: base });
        stream.push({ type: "text_start", contentIndex: 0, partial: base });
        stream.push({
          type: "text_delta",
          contentIndex: 0,
          delta: "interrupted-stream-canary",
          partial: { ...base, content: [{ type: "text", text: "interrupted-stream-canary" }] },
        });
      });
      return stream;
    },
  } as unknown as Models;
}

test("B7 interrupted stream persists terminal run metadata and no assistant message", {
  skip: databaseUrl ? false : "set STORAGE_TEST_DATABASE_URL to a disposable migrated database",
}, async (context) => {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  context.after(() => pool.end());
  const database = new PgSqlExecutor(pool);
  const suffix = randomUUID();
  const userId = `b7-user-${suffix}`;
  const conversationId = `b7-conversation-${suffix}`;
  const runId = `b7-run-${suffix}`;
  const userMessageId = `b7-user-message-${suffix}`;
  const causationId = `b7-request-${suffix}`;
  const occurredAt = "2026-08-21T14:00:00.000Z";

  const identities = new IdentityRepository(database);
  await identities.createUser({
    id: userId,
    externalSubject: `b7-oidc-${suffix}`,
    displayName: "B7 interrupted stream",
    createdAt: occurredAt,
  });
  await identities.createConversation({
    id: conversationId,
    createdBy: userId,
    title: "B7 interrupted stream",
    createdAt: occurredAt,
  });
  await new MessageRepository(database).append({
    conversationId,
    seq: 0,
    message: {
      schemaVersion: 1,
      messageId: userMessageId,
      role: "user",
      createdAt: occurredAt,
      content: [{ type: "text", text: "interrupt this response" }],
    },
  });
  await new RunRepository(database).start({
    id: runId,
    conversationId,
    initiatedBy: userId,
    causationId,
    configKey: "b7-fixture",
    provider: "faux",
    model: "interrupted",
    startedAt: occurredAt,
  });

  const before = await pool.query<{ journal_seq: string }>(
    "SELECT COALESCE(max(journal_seq), 0)::text AS journal_seq FROM event_journal",
  );
  const baseline = Number(before.rows[0]!.journal_seq);
  const journal = new EventJournalRepository(database);
  const durable = new DurableJournalSink({ journal });
  const controller = new AbortController();
  const conversation = new ConversationManager({ contextWindow: 8_192 });
  conversation.append({ role: "user", content: "interrupt this response", timestamp: Date.parse(occurredAt) });
  let nextId = 0;

  const outcome = await run(
    {
      models: interruptedModels(),
      model: modelFixture(),
      entry,
      configKey: "b7-fixture",
      conversation,
    },
    {
      conversationId,
      causationId,
      runId,
      maxTurns: 1,
      deadline: Date.now() + 5_000,
      signal: controller.signal,
      now: () => Date.parse(occurredAt),
      idFactory: () => `b7-event-${suffix}-${nextId++}`,
      onEvent: async (event) => {
        await durable.sink(event);
        if (event.type === "message.delta") controller.abort(new Error("B7 injected interruption"));
      },
    },
  );
  assert.equal(outcome.reason, "cancelled");

  const storedEvents = await journal.listAfter(baseline, 100);
  const projector = new RunHistoryProjector(database);
  for (const stored of storedEvents) {
    await projector.apply({
      deliveryId: stored.event.eventId,
      journalSeq: stored.journalSeq,
      event: stored.event,
    });
  }
  // At-least-once replay must not rewrite or duplicate the projection.
  for (const stored of storedEvents) {
    await projector.apply({
      deliveryId: stored.event.eventId,
      journalSeq: stored.journalSeq,
      event: stored.event,
    });
  }

  const proof = await pool.query<{
    status: string;
    terminal_reason: string;
    terminal_code: string;
    completed_at: Date;
    assistant_messages: string;
    completed_events: string;
    cancelled_events: string;
  }>(
    `SELECT run.status, run.terminal_reason, run.terminal_code, run.completed_at,
            (SELECT count(*)::text FROM messages
             WHERE conversation_id = $2 AND role = 'assistant') AS assistant_messages,
            (SELECT count(*)::text FROM event_journal
             WHERE run_id = $1 AND event_type = 'message.completed') AS completed_events,
            (SELECT count(*)::text FROM event_journal
             WHERE run_id = $1 AND event_type = 'run.cancelled') AS cancelled_events
     FROM runs AS run
     WHERE run.id = $1`,
    [runId, conversationId],
  );
  assert.deepEqual(
    {
      status: proof.rows[0]!.status,
      terminalReason: proof.rows[0]!.terminal_reason,
      terminalCode: proof.rows[0]!.terminal_code,
      assistantMessages: proof.rows[0]!.assistant_messages,
      completedEvents: proof.rows[0]!.completed_events,
      cancelledEvents: proof.rows[0]!.cancelled_events,
    },
    {
      status: "cancelled",
      terminalReason: "cancelled",
      terminalCode: "caller.cancelled",
      assistantMessages: "0",
      completedEvents: "0",
      cancelledEvents: "1",
    },
  );
  assert.ok(proof.rows[0]!.completed_at instanceof Date);
});
