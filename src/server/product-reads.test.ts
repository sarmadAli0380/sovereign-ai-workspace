import assert from "node:assert/strict";
import test from "node:test";
import type { SqlExecutor } from "../storage/sql.ts";
import { PostgresProductReadStore } from "./product-reads.ts";

function database(rows: readonly Record<string, unknown>[], sql: string[] = []): SqlExecutor {
  return { async query(statement) { sql.push(statement); return { rows }; } };
}

test("C4 reads: messages decode the product envelope and remain bounded", async () => {
  const calls: string[] = [];
  const store = new PostgresProductReadStore(database([{
    seq: "2",
    content: {
      schemaVersion: 1,
      messageId: "message-2",
      role: "user",
      createdAt: "2026-08-25T00:00:00.000Z",
      content: [{ type: "text", text: "hello" }],
    },
  }], calls));
  const rows = await store.listMessages("conversation-1", 1, 10);
  assert.equal(rows[0]?.sequence, 2);
  assert.equal(rows[0]?.message.messageId, "message-2");
  assert.match(calls[0]!, /current_messages/);
  await assert.rejects(store.listMessages("conversation-1", -2, 10), /afterSequence/);
  await assert.rejects(store.listMessages("conversation-1", 0, 101), /limit/);
});

test("C4 reads: attachment metadata never returns object keys or content hashes", async () => {
  const store = new PostgresProductReadStore(database([{
    id: "attachment-1",
    conversation_id: "conversation-1",
    message_id: null,
    byte_size: "12",
    mime_type: "text/plain",
    original_name: "note.txt",
    created_at: "2026-08-25T00:00:00.000Z",
    object_key: "must-not-escape",
    sha256: "b".repeat(64),
  }]));
  const attachment = (await store.listAttachments("conversation-1", undefined, 10))[0]!;
  assert.deepEqual(Object.keys(attachment).sort(), [
    "attachmentId", "byteSize", "conversationId", "createdAt", "mimeType", "originalName",
  ]);
  assert.equal(JSON.stringify(attachment).includes("must-not-escape"), false);
  assert.equal(JSON.stringify(attachment).includes("b".repeat(64)), false);
});

test("C4 reads: run status and audit rows decode only their product projections", async () => {
  const runStore = new PostgresProductReadStore(database([{
    id: "run-1", conversation_id: "conversation-1", config_key: "local-qwen",
    provider: "ollama", model: "qwen3:4b", status: "completed",
    terminal_reason: "stop", terminal_code: null,
    usage: { totalTokens: 4 }, started_at: "2026-08-25T00:00:00.000Z",
    completed_at: "2026-08-25T00:00:01.000Z",
  }]));
  assert.equal((await runStore.getRun("run-1"))?.status, "completed");

  const auditStore = new PostgresProductReadStore(database([{
    journal_seq: "7", event_id: "event-7", run_id: "run-1",
    conversation_id: "conversation-1", event_sequence: "2",
    event_type: "message.completed", actor_id: null,
    metadata: { payload: { contentHash: "c".repeat(64) } },
    occurred_at: "2026-08-25T00:00:00.000Z",
    recorded_at: "2026-08-25T00:00:00.100Z",
  }]));
  const audit = (await auditStore.listAudit(0, 10))[0]!;
  assert.equal(audit.journalSequence, 7);
  assert.deepEqual(audit.metadata, { payload: { contentHash: "c".repeat(64) } });
});
