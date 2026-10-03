import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { SqlExecutor, SqlQueryResult } from "../storage/sql.ts";
import { AuthenticationError, parseSessionRegistry, type ServerPrincipal } from "./auth.ts";
import { PostgresIdentityStore } from "./identity-store.ts";

class RecordingDatabase implements SqlExecutor {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  readonly results: SqlQueryResult[] = [];

  async query(sql: string, values: readonly unknown[] = []): Promise<SqlQueryResult> {
    this.calls.push({ sql, values });
    return this.results.shift() ?? { rows: [], rowCount: 0 };
  }
}

const admin: ServerPrincipal = {
  sessionId: "admin-session",
  userId: "admin-user",
  roles: ["admin"],
  allowedConfigKeys: ["local-qwen"],
};
const now = Date.parse("2026-08-25T12:00:00.000Z");

test("C3 identity: PostgreSQL authentication looks up only a token digest and current grants", async () => {
  const database = new RecordingDatabase();
  database.results.push({ rows: [{
    session_id: "session-1",
    user_id: "user-1",
    roles: ["member"],
    config_keys: ["local-qwen"],
  }] });
  const token = "t".repeat(48);
  const principal = await new PostgresIdentityStore(database).authenticate(`Bearer ${token}`, now);

  assert.deepEqual(principal, {
    sessionId: "session-1", userId: "user-1", roles: ["member"], allowedConfigKeys: ["local-qwen"],
  });
  assert.equal(database.calls[0]!.values[0], createHash("sha256").update(token).digest("hex"));
  assert.equal(database.calls[0]!.values.includes(token), false);
  assert.match(database.calls[0]!.sql, /user_roles/);
  assert.match(database.calls[0]!.sql, /user_model_grants/);

  await assert.rejects(new PostgresIdentityStore(new RecordingDatabase()).authenticate(`Bearer ${token}`, now),
    (error) => error instanceof AuthenticationError);
});

test("C3 identity: bootstrap imports digests only when durable sessions are empty", async () => {
  const database = new RecordingDatabase();
  database.results.push({ rows: [{ inserted: "1" }] });
  const digest = "a".repeat(64);
  const registry = parseSessionRegistry({
    schemaVersion: 1,
    sessions: [{
      sessionId: "bootstrap-session", userId: "admin-user", tokenSha256: digest,
      roles: ["admin"], allowedConfigKeys: ["local-qwen"],
      expiresAt: "2026-09-01T00:00:00.000Z", status: "active",
    }],
  });
  assert.equal(await new PostgresIdentityStore(database, { now: () => now }).bootstrap(registry), true);
  assert.match(database.calls[0]!.sql, /NOT EXISTS \(SELECT 1 FROM server_sessions\)/);
  assert.match(String(database.calls[0]!.values[0]), new RegExp(digest));
  assert.doesNotMatch(String(database.calls[0]!.values[0]), /Bearer/);
});

test("C3 identity: an issued raw token is returned once while SQL receives only its digest", async () => {
  const database = new RecordingDatabase();
  database.results.push({ rows: [{ id: "issued-session" }] });
  const raw = "r".repeat(48);
  const store = new PostgresIdentityStore(database, {
    idFactory: () => "issued-session",
    tokenFactory: () => raw,
    now: () => now,
  });
  const issued = await store.issueSession(admin, {
    userId: "user-1",
    expiresAt: "2026-08-26T12:00:00.000Z",
  });
  assert.equal(issued.token, raw);
  assert.equal(database.calls[0]!.values[2], createHash("sha256").update(raw).digest("hex"));
  assert.equal(database.calls[0]!.values.includes(raw), false);
  assert.match(database.calls[0]!.sql, /role\.role = 'admin'/);
});

test("C3 identity: access replacement is bounded and protects the last administrator", async () => {
  const database = new RecordingDatabase();
  database.results.push({ rows: [{ user_id: "user-1", roles: ["member"], config_keys: ["local-qwen"] }] });
  const store = new PostgresIdentityStore(database, { now: () => now });
  const access = await store.setUserAccess(admin, {
    userId: "user-1", roles: ["member"], allowedConfigKeys: ["local-qwen"],
  });
  assert.deepEqual(access, { userId: "user-1", roles: ["member"], allowedConfigKeys: ["local-qwen"] });
  assert.match(database.calls[0]!.sql, /other_admin/);
  await assert.rejects(store.setUserAccess({ ...admin, roles: ["member"] }, {
    userId: "user-1", roles: ["member"], allowedConfigKeys: ["local-qwen"],
  }), /administration-denied/);
});
