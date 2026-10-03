import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { once } from "node:events";
import { RUN_EVENT_SCHEMA_VERSION, type RunEvent } from "../events.ts";
import { RunEventTransportError } from "../event-transport.ts";
import { parseSessionRegistry, RegistrySessionAuthenticator, type ServerPrincipal } from "./auth.ts";
import {
  createSovereignHttpServer,
  type AcceptedRunCommand,
  type SovereignHttpServerOptions,
} from "./http-server.ts";
import { RunControlError } from "./run-controls.ts";

const token = "c".repeat(48);

function event(runId: string, sequence: number, terminal = false): RunEvent {
  return {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    eventId: `event-${sequence}`,
    runId,
    conversationId: "conversation-1",
    sequence,
    turn: 0,
    occurredAt: new Date(1_800_000_000_000 + sequence).toISOString(),
    type: terminal ? "run.completed" : "run.started",
    causationId: "request-1",
    audience: "persistence",
    sensitivity: "metadata",
    payload: terminal
      ? { reason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } }
      : { configKey: "local-qwen", provider: "ollama", model: "qwen3:4b" },
  } as RunEvent;
}

function fixture(overrides: {
  authorize?: boolean;
  replay?: readonly RunEvent[];
  replayError?: Error;
  roles?: Array<"member" | "admin">;
  identity?: SovereignHttpServerOptions["identity"];
  approvals?: SovereignHttpServerOptions["approvals"];
  reads?: SovereignHttpServerOptions["reads"];
  commandError?: Error;
} = {}) {
  const registry = parseSessionRegistry({
    schemaVersion: 1,
    sessions: [{
      sessionId: "session-1",
      userId: "user-1",
      tokenSha256: createHash("sha256").update(token).digest("hex"),
      roles: overrides.roles ?? ["member"],
      allowedConfigKeys: ["local-qwen"],
      expiresAt: "2099-01-01T00:00:00.000Z",
      status: "active",
    }],
  });
  const commands: AcceptedRunCommand[] = [];
  let next = 0;
  const server = createSovereignHttpServer({
    authenticator: new RegistrySessionAuthenticator(registry),
    access: {
      async authorizeConversation(_principal: ServerPrincipal, _conversationId: string) {
        return overrides.authorize ?? true;
      },
      async authorizeRun(_principal: ServerPrincipal, _runId: string) {
        return overrides.authorize ?? true;
      },
    },
    commands: { async start(command) {
      if (overrides.commandError) throw overrides.commandError;
      commands.push(command);
      return { runId: command.runId, conversationId: command.conversationId, created: true };
    } },
    replay: { async listRunEvents() {
      if (overrides.replayError) throw overrides.replayError;
      return overrides.replay ?? [];
    } },
    readiness: { async check() { return true; } },
    idFactory: () => ["request-1", "run-1", "request-2", "request-3"][next++] ?? `id-${next}`,
    sseHeartbeatMs: 50,
    ...(overrides.identity ? { identity: overrides.identity } : {}),
    ...(overrides.approvals ? { approvals: overrides.approvals } : {}),
    ...(overrides.reads ? { reads: overrides.reads } : {}),
  });
  return { server, commands };
}

async function withServer<T>(server: ReturnType<typeof createSovereignHttpServer>, work: (origin: string) => Promise<T>): Promise<T> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    return await work(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
}

test("C1 HTTP: health is minimal and run commands require auth, ownership, and model grant", async () => {
  const { server, commands } = fixture();
  await withServer(server, async (origin) => {
    const health = await fetch(`${origin}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });

    const unauthenticated = await fetch(`${origin}/v1/conversations/conversation-1/runs`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    assert.equal(unauthenticated.status, 401);

    const deniedModel = await fetch(`${origin}/v1/conversations/conversation-1/runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "client-command-0001",
      },
      body: JSON.stringify({ configKey: "hosted", message: "hello", maxTurns: 2 }),
    });
    assert.equal(deniedModel.status, 403);

    const accepted = await fetch(`${origin}/v1/conversations/conversation-1/runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "client-command-0002",
      },
      body: JSON.stringify({ configKey: "local-qwen", message: "hello", maxTurns: 2 }),
    });
    assert.equal(accepted.status, 202);
    assert.deepEqual(await accepted.json(), { runId: "id-5", conversationId: "conversation-1", status: "accepted" });
    assert.equal(commands.length, 1);
    assert.equal(commands[0]!.userId, "user-1");
    assert.equal(commands[0]!.message, "hello");
    assert.equal(commands[0]!.idempotencyKey, "client-command-0002");
  });
});

test("C1 HTTP: unauthorized resources are indistinguishable from absence", async () => {
  const { server } = fixture({ authorize: false });
  await withServer(server, async (origin) => {
    const response = await fetch(`${origin}/v1/conversations/conversation-1/runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "client-command-0003",
      },
      body: JSON.stringify({ configKey: "local-qwen", message: "hello", maxTurns: 2 }),
    });
    assert.equal(response.status, 404);
    assert.equal((await response.json() as { error: { code: string } }).error.code, "resource.not-found");
  });
});

test("C1 SSE: durable replay uses canonical frames and closes on a terminal event", async () => {
  const replay = [event("run-1", 0), event("run-1", 1, true)];
  const { server } = fixture({ replay });
  await withServer(server, async (origin) => {
    const response = await fetch(`${origin}/v1/runs/run-1/events`, {
      headers: { authorization: `Bearer ${token}`, "last-event-id": "prior-event" },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
    const text = await response.text();
    assert.match(text, /id: event-0\nevent: run\.started/);
    assert.match(text, /id: event-1\nevent: run\.completed/);
    assert.equal(text.includes("Bearer"), false);
  });
});

test("C1 SSE: an unavailable checkpoint fails before event-stream headers are committed", async () => {
  const { server } = fixture({ replayError: new RunEventTransportError("missing checkpoint") });
  await withServer(server, async (origin) => {
    const response = await fetch(`${origin}/v1/runs/run-1/events`, {
      headers: { authorization: `Bearer ${token}`, "last-event-id": "missing-event" },
    });
    assert.equal(response.status, 409);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
    assert.equal(
      (await response.json() as { error: { code: string } }).error.code,
      "events.checkpoint-unavailable",
    );
  });
});

test("C1 HTTP: request parsing is bounded and rejects unknown fields", async () => {
  const { server } = fixture();
  await withServer(server, async (origin) => {
    const response = await fetch(`${origin}/v1/conversations/conversation-1/runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "client-command-0004",
      },
      body: JSON.stringify({ configKey: "local-qwen", message: "hello", maxTurns: 2, surprise: true }),
    });
    assert.equal(response.status, 400);
  });
});

test("C2 HTTP: run commands require a caller idempotency key", async () => {
  const { server, commands } = fixture();
  await withServer(server, async (origin) => {
    const response = await fetch(`${origin}/v1/conversations/conversation-1/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ configKey: "local-qwen", message: "hello", maxTurns: 2 }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { error: { code: string } }).error.code, "run.invalid-idempotency-key");
    assert.equal(commands.length, 0);
  });
});

test("C3 HTTP: admin access and session operations require the durable admin permission", async () => {
  const calls: string[] = [];
  const identity: NonNullable<SovereignHttpServerOptions["identity"]> = {
    async getUserAccess(_principal, userId) {
      calls.push(`get:${userId}`);
      return { userId, roles: ["member"], allowedConfigKeys: ["local-qwen"] };
    },
    async setUserAccess(_principal, input) { calls.push(`set:${input.userId}`); return input; },
    async issueSession(_principal, input) {
      calls.push(`issue:${input.userId}`);
      return { sessionId: "session-issued", userId: input.userId, token: "x".repeat(43), expiresAt: input.expiresAt };
    },
    async revokeSession(_principal, sessionId) { calls.push(`revoke:${sessionId}`); return true; },
  };

  const denied = fixture({ identity });
  await withServer(denied.server, async (origin) => {
    const response = await fetch(`${origin}/v1/admin/users/user-1/access`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 403);
  });

  const allowed = fixture({ identity, roles: ["admin"] });
  await withServer(allowed.server, async (origin) => {
    const access = await fetch(`${origin}/v1/admin/users/user-1/access`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(access.status, 200);
    const issued = await fetch(`${origin}/v1/admin/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ userId: "user-1", expiresAt: "2026-09-01T00:00:00.000Z" }),
    });
    assert.equal(issued.status, 201);
    assert.equal((await issued.json() as { token: string }).token, "x".repeat(43));
    const revoked = await fetch(`${origin}/v1/admin/sessions/session-issued/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(revoked.status, 200);
  });
  assert.deepEqual(calls, ["get:user-1", "issue:user-1", "revoke:session-issued"]);
});

test("C3 HTTP: approvals accept only an authenticated exact decision batch", async () => {
  const resolved: unknown[] = [];
  const approvals: NonNullable<SovereignHttpServerOptions["approvals"]> = {
    async list() { return [{
      approvalId: "approval-1", runId: "run-1", conversationId: "conversation-1",
      toolCallId: "call-1", toolName: "write_file", arguments: { path: "a.txt" },
      argumentsHash: "a".repeat(64), capability: "filesystem.write",
      capabilities: ["filesystem.write"], reasonCode: "policy.approval-required",
      requestedAt: "2026-08-25T12:00:00.000Z", expiresAt: "2026-08-25T13:00:00.000Z",
    }]; },
    async resolve(_principal, runId, decisions) {
      resolved.push(decisions);
      return { runId, replayed: false, resolutions: [] };
    },
  };
  const { server } = fixture({ approvals });
  await withServer(server, async (origin) => {
    const listed = await fetch(`${origin}/v1/approvals`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(listed.status, 200);
    const accepted = await fetch(`${origin}/v1/runs/run-1/approvals/resolve`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ decisions: [{ approvalId: "approval-1", decision: "approved" }] }),
    });
    assert.equal(accepted.status, 200);
    const conversational = await fetch(`${origin}/v1/runs/run-1/approvals/resolve`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ decisions: [{ approvalId: "approval-1", decision: "approved", text: "yes" }] }),
    });
    assert.equal(conversational.status, 400);
  });
  assert.deepEqual(resolved, [[{ approvalId: "approval-1", decision: "approved" }]]);
});

test("C3 HTTP: bearer-only mode rejects browser origins and cookies without CORS authority", async () => {
  const { server } = fixture();
  await withServer(server, async (origin) => {
    const crossOrigin = await fetch(`${origin}/healthz`, { headers: { origin: "https://untrusted.example" } });
    assert.equal(crossOrigin.status, 403);
    assert.equal(crossOrigin.headers.get("access-control-allow-origin"), null);
    const cookie = await fetch(`${origin}/healthz`, { headers: { cookie: "session=not-supported" } });
    assert.equal(cookie.status, 400);
  });
});

test("C4 HTTP: product reads are bounded, ownership-filtered, and metadata-safe", async () => {
  const calls: string[] = [];
  const reads: NonNullable<SovereignHttpServerOptions["reads"]> = {
    async listMessages(conversationId, after, limit) {
      calls.push(`messages:${conversationId}:${after}:${limit}`);
      return [{ sequence: 4, message: {
        schemaVersion: 1, messageId: "message-4", role: "user",
        createdAt: "2026-08-25T00:00:00.000Z", content: [{ type: "text", text: "hello" }],
      } }];
    },
    async listAttachments(conversationId, afterId, limit) {
      calls.push(`attachments:${conversationId}:${afterId ?? ""}:${limit}`);
      return [{ attachmentId: "attachment-2", conversationId, byteSize: 7, mimeType: "text/plain", createdAt: "2026-08-25T00:00:00.000Z" }];
    },
    async getRun(runId) {
      calls.push(`run:${runId}`);
      return { runId, conversationId: "conversation-1", configKey: "local-qwen", provider: "ollama", model: "qwen3:4b", status: "running", startedAt: "2026-08-25T00:00:00.000Z" };
    },
    async listAudit(after, limit) {
      calls.push(`audit:${after}:${limit}`);
      return [{ journalSequence: 9, eventId: "event-9", runId: "run-1", conversationId: "conversation-1", eventSequence: 1, eventType: "message.completed", metadata: { contentHash: "a".repeat(64) }, occurredAt: "2026-08-25T00:00:00.000Z", recordedAt: "2026-08-25T00:00:00.000Z" }];
    },
  };
  const { server } = fixture({ reads, roles: ["admin"] });
  await withServer(server, async (origin) => {
    const messages = await fetch(`${origin}/v1/conversations/conversation-1/messages?afterSequence=3&limit=10`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(messages.status, 200);
    assert.equal((await messages.json() as { nextAfterSequence: number }).nextAfterSequence, 4);

    const attachments = await fetch(`${origin}/v1/conversations/conversation-1/attachments?afterId=attachment-1&limit=5`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(attachments.status, 200);

    const run = await fetch(`${origin}/v1/runs/run-1`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(run.status, 200);

    const audit = await fetch(`${origin}/v1/admin/audit-events?afterJournalSequence=8&limit=2`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(audit.status, 200);
    const auditBody = await audit.text();
    assert.equal(auditBody.includes("hello"), false);
  });
  assert.deepEqual(calls, [
    "messages:conversation-1:3:10",
    "attachments:conversation-1:attachment-1:5",
    "run:run-1",
    "audit:8:2",
  ]);
});

test("C4 HTTP: audit is admin-only and read cursors fail closed", async () => {
  const reads = {
    async listMessages() { return []; }, async listAttachments() { return []; },
    async getRun() { return undefined; }, async listAudit() { return []; },
  } satisfies NonNullable<SovereignHttpServerOptions["reads"]>;
  const { server } = fixture({ reads });
  await withServer(server, async (origin) => {
    const audit = await fetch(`${origin}/v1/admin/audit-events`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(audit.status, 403);
    const invalid = await fetch(`${origin}/v1/conversations/conversation-1/messages?afterSequence=-1`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(invalid.status, 400);
  });
});

test("C4 HTTP: exhausted controls are stable 429 responses without command acceptance", async () => {
  const { server, commands } = fixture({
    commandError: new RunControlError("control.token-budget-exhausted"),
  });
  await withServer(server, async (origin) => {
    const response = await fetch(`${origin}/v1/conversations/conversation-1/runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": "client-command-c4-control",
      },
      body: JSON.stringify({ configKey: "local-qwen", message: "hello", maxTurns: 2 }),
    });
    assert.equal(response.status, 429);
    assert.equal(
      (await response.json() as { error: { code: string } }).error.code,
      "control.token-budget-exhausted",
    );
  });
  assert.equal(commands.length, 0);
});
