import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { Pool } from "pg";
import { approvalArgumentsHash } from "../approval.ts";
import { ToolExecutionController } from "../tool-execution.ts";
import { ToolRegistry } from "../tool-registry.ts";
import { PgSqlExecutor } from "../storage/pg.ts";
import {
  ApprovalRepository,
  IdentityRepository,
  MessageRepository,
  RunRepository,
  ToolRepository,
} from "../storage/repositories/index.ts";
import { AuthenticationError, parseSessionRegistry } from "./auth.ts";
import { DurableApprovalGateway, PostgresApprovalStore } from "./approval-gateway.ts";
import { PostgresIdentityStore } from "./identity-store.ts";

const databaseUrl = process.env["STORAGE_TEST_DATABASE_URL"];

test("C3 live PostgreSQL: identity administration and authenticated approval resolution are durable", {
  skip: databaseUrl ? false : "set STORAGE_TEST_DATABASE_URL to a disposable migrated database",
}, async (context) => {
  const pool = new Pool({ connectionString: databaseUrl, max: 3 });
  context.after(() => pool.end());
  const database = new PgSqlExecutor(pool);
  const fixedNow = Date.parse("2026-08-25T12:00:00.000Z");
  const adminToken = "a".repeat(48);
  const bootstrap = parseSessionRegistry({
    schemaVersion: 1,
    sessions: [{
      sessionId: "c3-bootstrap-admin",
      userId: "c3-admin",
      tokenSha256: createHash("sha256").update(adminToken).digest("hex"),
      roles: ["admin"],
      allowedConfigKeys: ["local-qwen"],
      expiresAt: "2026-08-26T12:00:00.000Z",
      status: "active",
    }],
  });
  const identities = new PostgresIdentityStore(database, { now: () => fixedNow });
  assert.equal(await identities.bootstrap(bootstrap), true);
  assert.equal(await identities.bootstrap(bootstrap), false);
  const admin = await identities.authenticate(`Bearer ${adminToken}`, fixedNow);
  assert.deepEqual(admin.roles, ["admin"]);

  const suffix = randomUUID();
  const userId = `c3-user-${suffix}`;
  const repository = new IdentityRepository(database);
  await repository.createUser({
    id: userId,
    externalSubject: `c3-subject-${suffix}`,
    displayName: "C3 User",
    createdAt: "2026-08-25T12:00:00.000Z",
  });
  await identities.setUserAccess(admin, {
    userId,
    roles: ["member"],
    allowedConfigKeys: ["local-qwen"],
  });
  const rawMemberToken = "m".repeat(48);
  const issuing = new PostgresIdentityStore(database, {
    idFactory: () => `c3-session-${suffix}`,
    tokenFactory: () => rawMemberToken,
    now: () => fixedNow,
  });
  const issued = await issuing.issueSession(admin, {
    userId,
    expiresAt: "2026-08-26T12:00:00.000Z",
  });
  const member = await identities.authenticate(`Bearer ${issued.token}`, fixedNow);
  assert.deepEqual(member.allowedConfigKeys, ["local-qwen"]);

  const conversationId = `c3-conversation-${suffix}`;
  const runId = `c3-run-${suffix}`;
  const turnId = `c3-turn-${suffix}`;
  const toolCallId = `c3-call-${suffix}`;
  const approvalId = `c3-approval-${suffix}`;
  await repository.createConversation({
    id: conversationId,
    createdBy: userId,
    createdAt: "2026-08-25T12:00:00.000Z",
  });
  const runs = new RunRepository(database);
  await runs.start({
    id: runId,
    conversationId,
    initiatedBy: userId,
    causationId: `c3-request-${suffix}`,
    configKey: "local-qwen",
    provider: "ollama",
    model: "qwen3:4b",
    startedAt: "2026-08-25T12:00:00.000Z",
  });
  await runs.startTurn({
    id: turnId,
    runId,
    conversationId,
    turnNumber: 0,
    startedAt: "2026-08-25T12:00:00.000Z",
  });
  const args = { path: "approved.txt", content: "durable" };
  const tools = new ToolRepository(database);
  await tools.recordRequest({
    runId, toolCallId, turnId, conversationId, toolName: "write_file",
    arguments: args, requestedAt: "2026-08-25T12:00:00.000Z",
  });
  await tools.recordDecision({
    id: `c3-decision-${suffix}`,
    runId, toolCallId, capability: "filesystem.write", capabilities: ["filesystem.write"],
    decision: "requireApproval", reasonCode: "policy.approval-required",
    decidedAt: "2026-08-25T12:00:00.000Z",
  });
  await new ApprovalRepository(database).createPending({
    schemaVersion: 1,
    approvalId,
    runId,
    conversationId,
    toolCall: { type: "toolCall", id: toolCallId, name: "write_file", arguments: args },
    argumentsHash: approvalArgumentsHash(args),
    capability: "filesystem.write",
    capabilities: ["filesystem.write"],
    reasonCode: "policy.approval-required",
    requestedAt: "2026-08-25T12:00:00.000Z",
    expiresAt: "2099-08-25T13:00:00.000Z",
  });

  let executions = 0;
  const registry = new ToolRegistry();
  registry.register({
    definition: {
      name: "write_file",
      description: "fixture",
      parameters: Type.Object({ path: Type.String(), content: Type.String() }, { additionalProperties: false }),
    },
    controls: {
      capabilities: ["filesystem.write"], risk: "high", timeoutMs: 1_000,
      maxOutputChars: 1_000, concurrencyCost: 1, sideEffect: "reversible", idempotency: "callerKey",
    },
    async execute() {
      executions += 1;
      return { content: [{ type: "text" as const, text: "written" }] };
    },
  });
  const approvals = new DurableApprovalGateway({
    store: new PostgresApprovalStore(database),
    messages: new MessageRepository(database),
    registry,
    executionController: new ToolExecutionController({ globalCapacity: 2, defaultCapabilityCapacity: 2 }),
    deploymentId: "single-node",
    contextWindow: 8_192,
    now: () => fixedNow + 1_000,
  });
  assert.equal((await approvals.list(member)).length, 1);
  const resolution = await approvals.resolve(member, runId, [{ approvalId, decision: "approved" }]);
  assert.equal(resolution.replayed, false);
  assert.equal(executions, 1);
  const replay = await approvals.resolve(member, runId, [{ approvalId, decision: "approved" }]);
  assert.equal(replay.replayed, true);
  assert.equal(executions, 1);
  const durable = await pool.query<{
    status: string; resolution_session_id: string; tool_results: string;
  }>(
    `SELECT approval.status, approval.resolution_session_id,
            (SELECT count(*)::text FROM messages
             WHERE conversation_id = $2 AND role = 'toolResult') AS tool_results
     FROM approvals AS approval WHERE approval.id = $1`,
    [approvalId, conversationId],
  );
  assert.deepEqual(durable.rows[0], {
    status: "approved", resolution_session_id: issued.sessionId, tool_results: "1",
  });

  assert.equal(await identities.revokeSession(admin, issued.sessionId), true);
  await assert.rejects(identities.authenticate(`Bearer ${issued.token}`, fixedNow + 2_000),
    (error) => error instanceof AuthenticationError);
});
