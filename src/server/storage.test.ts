import assert from "node:assert/strict";
import test from "node:test";
import type { SqlExecutor, SqlQueryResult } from "../storage/sql.ts";
import { PostgresServerAccessController } from "./storage.ts";

class Database implements SqlExecutor {
  queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  rows: Array<Record<string, unknown>> = [{ "?column?": 1 }];

  async query(sql: string, values: readonly unknown[] = []): Promise<SqlQueryResult> {
    this.queries.push({ sql, values });
    return { rows: this.rows, rowCount: this.rows.length };
  }
}

const member = {
  sessionId: "session-1",
  userId: "user-1",
  roles: ["member" as const],
  allowedConfigKeys: ["local-qwen"],
};

test("C1 storage: conversation and run access bind resource ownership to the authenticated user", async () => {
  const database = new Database();
  const access = new PostgresServerAccessController(database);
  assert.equal(await access.authorizeConversation(member, "conversation-1"), true);
  assert.equal(await access.authorizeRun(member, "run-1"), true);
  assert.deepEqual(database.queries[0]!.values, ["conversation-1", false, "user-1"]);
  assert.deepEqual(database.queries[1]!.values, ["run-1", false, "user-1"]);
  assert.match(database.queries[0]!.sql, /owner\.status = 'active'/);
  assert.match(database.queries[1]!.sql, /conversation\.created_by = \$3/);
});

test("C1 storage: admin access is explicit and missing resources deny", async () => {
  const database = new Database();
  const access = new PostgresServerAccessController(database);
  await access.authorizeConversation({ ...member, roles: ["admin"] }, "conversation-1");
  assert.equal(database.queries[0]!.values[1], true);
  database.rows = [];
  assert.equal(await access.authorizeRun(member, "missing-run"), false);
});
