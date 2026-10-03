import assert from "node:assert/strict";
import test from "node:test";
import type { SqlExecutor, SqlQueryResult } from "../storage/sql.ts";
import type { ServerPrincipal } from "./auth.ts";
import { PostgresApprovalStore } from "./approval-gateway.ts";

class RecordingDatabase implements SqlExecutor {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  readonly results: SqlQueryResult[] = [];
  async query(sql: string, values: readonly unknown[] = []): Promise<SqlQueryResult> {
    this.calls.push({ sql, values });
    return this.results.shift() ?? { rows: [], rowCount: 0 };
  }
}

const member: ServerPrincipal = {
  sessionId: "session-1", userId: "user-1", roles: ["member"], allowedConfigKeys: ["local-qwen"],
};
const row = {
  id: "approval-1",
  run_id: "run-1",
  conversation_id: "conversation-1",
  tool_call_id: "call-1",
  tool_name: "write_file",
  arguments: { path: "a.txt", content: "safe" },
  arguments_hash: "06ac6db9bb427e2c15db07f7ffe752a01f18aa111213c1ef2f80b1dd5500ce3f",
  capability: "filesystem.write",
  capabilities: ["filesystem.write"],
  reason_code: "policy.approval-required",
  status: "pending",
  requested_at: new Date("2026-08-25T12:00:00.000Z"),
  expires_at: new Date("2026-08-25T13:00:00.000Z"),
  resolution_session_id: null,
  resolution_request_sha256: null,
};

test("C3 approvals: listing is ownership-filtered, bounded, and reconstructs the exact request", async () => {
  const database = new RecordingDatabase();
  database.results.push({ rows: [row] });
  const approvals = await new PostgresApprovalStore(database).listPending(member);
  assert.equal(approvals.length, 1);
  assert.deepEqual(approvals[0]?.arguments, { path: "a.txt", content: "safe" });
  assert.equal(approvals[0]?.toolName, "write_file");
  assert.match(database.calls[0]!.sql, /conversation\.created_by = \$2/);
  assert.match(database.calls[0]!.sql, /approval\.status = 'pending'/);
  assert.equal(database.calls[0]!.values[4], 100);
});

test("C3 approvals: the complete authenticated batch becomes durable in one statement", async () => {
  const database = new RecordingDatabase();
  database.results.push({ rows: [{ resolved: "1" }] });
  const store = new PostgresApprovalStore(database);
  await store.resolveBatch({
    runId: "run-1",
    actorUserId: "user-1",
    actorSessionId: "session-1",
    requestSha256: "b".repeat(64),
    resolutions: [{
      approvalId: "approval-1", toolCallId: "call-1", decision: "approved",
      actorId: "user-1", reasonCode: "approval.authenticated",
    }],
    resolvedAt: "2026-08-25T12:01:00.000Z",
  });
  assert.match(database.calls[0]!.sql, /jsonb_to_recordset/);
  assert.match(database.calls[0]!.sql, /resolution_session_id = \$4/);
  assert.match(database.calls[0]!.sql, /resolution_request_sha256 = \$5/);
  assert.equal(database.calls[0]!.values[3], "session-1");
  assert.equal(String(database.calls[0]!.values[1]).includes("conversationText"), false);
});

test("C3 approvals: a partial durable batch fails closed", async () => {
  const database = new RecordingDatabase();
  database.results.push({ rows: [{ resolved: "0" }] });
  await assert.rejects(new PostgresApprovalStore(database).resolveBatch({
    runId: "run-1",
    actorUserId: "user-1",
    actorSessionId: "session-1",
    requestSha256: "b".repeat(64),
    resolutions: [{ approvalId: "approval-1", toolCallId: "call-1", decision: "denied", actorId: "user-1" }],
    resolvedAt: "2026-08-25T12:01:00.000Z",
  }), /resolution-conflict/);
});
