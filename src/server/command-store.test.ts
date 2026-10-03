import assert from "node:assert/strict";
import test from "node:test";
import type { SqlExecutor, SqlQueryResult } from "../storage/sql.ts";
import { PRODUCT_MESSAGE_SCHEMA_VERSION, type ProductMessageEnvelope } from "../messages/envelope.ts";
import { PostgresRunCommandStore, RunCommandConflictError } from "./command-store.ts";

const at = "2026-08-25T00:00:00.000Z";
const message: ProductMessageEnvelope = {
  schemaVersion: PRODUCT_MESSAGE_SCHEMA_VERSION,
  messageId: "message-1",
  role: "user",
  createdAt: at,
  content: [{ type: "text", text: "hello" }],
};

function row(requestSha256 = "a".repeat(64)) {
  return {
    id: "command-1",
    run_id: "run-1",
    conversation_id: "conversation-1",
    user_id: "user-1",
    session_id: "session-1",
    idempotency_key: "caller-command-0001",
    request_sha256: requestSha256,
    message_id: "message-1",
    config_key: "local-qwen",
    max_turns: 2,
    causation_id: "request-1",
    accepted_at: at,
    created: true,
  };
}

class Database implements SqlExecutor {
  readonly queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  rows: Array<Record<string, unknown>> = [row()];

  async query(sql: string, values: readonly unknown[] = []): Promise<SqlQueryResult> {
    this.queries.push({ sql, values });
    return { rows: this.rows, rowCount: this.rows.length };
  }
}

function input() {
  return {
    commandId: "command-1",
    runId: "run-1",
    conversationId: "conversation-1",
    userId: "user-1",
    sessionId: "session-1",
    isAdmin: false,
    idempotencyKey: "caller-command-0001",
    requestSha256: "a".repeat(64),
    message,
    configKey: "local-qwen",
    maxTurns: 2,
    causationId: "request-1",
    provider: "ollama",
    model: "qwen3:4b",
    acceptedAt: at,
  };
}

test("C2 command store atomically owns the key, user message, and run", async () => {
  const database = new Database();
  const accepted = await new PostgresRunCommandStore(database).accept(input());
  assert.equal(accepted.created, true);
  assert.equal(accepted.runId, "run-1");
  assert.match(database.queries[0]!.sql, /FOR UPDATE OF conversation/);
  assert.match(database.queries[0]!.sql, /INSERT INTO run_commands/);
  assert.match(database.queries[0]!.sql, /INSERT INTO messages/);
  assert.match(database.queries[0]!.sql, /INSERT INTO runs/);
  assert.match(database.queries[0]!.sql, /ON CONFLICT \(user_id, idempotency_key\) DO NOTHING/);
  assert.equal(database.queries[0]!.values[13], JSON.stringify(message));
  assert.equal(database.queries[0]!.values[15], false);
});

test("C2 command store rejects reuse of a key for a different request", async () => {
  const database = new Database();
  database.rows = [{ ...row("b".repeat(64)), created: false }];
  await assert.rejects(
    new PostgresRunCommandStore(database).accept(input()),
    RunCommandConflictError,
  );
});

test("C2 command store validates caller keys before SQL", async () => {
  const database = new Database();
  await assert.rejects(
    new PostgresRunCommandStore(database).accept({ ...input(), idempotencyKey: "short" }),
    /16-128/,
  );
  assert.equal(database.queries.length, 0);
});
