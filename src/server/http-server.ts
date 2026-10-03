import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { encodeRunEventSse, RunEventTransportError } from "../event-transport.ts";
import { isTerminalRunEvent, parseRunEvent, type RunEvent } from "../events.ts";
import {
  AuthenticationError,
  hasPermission,
  type ServerPermission,
  type ServerPrincipal,
  type SessionAuthenticator,
} from "./auth.ts";
import { RunEventBroker } from "./event-broker.ts";
import { RunCommandConflictError } from "./command-store.ts";
import type {
  ApprovalDecisionInput,
  ApprovalGateway,
} from "./approval-gateway.ts";
import type { DurableUserAccess, IssuedSession } from "./identity-store.ts";
import type { ProductReadStore } from "./product-reads.ts";
import { RunControlError } from "./run-controls.ts";

export const DEFAULT_MAX_REQUEST_BYTES = 65_536;
export const DEFAULT_SSE_HEARTBEAT_MS = 15_000;

export interface ServerAccessController {
  authorizeConversation(principal: ServerPrincipal, conversationId: string): Promise<boolean>;
  authorizeRun(principal: ServerPrincipal, runId: string): Promise<boolean>;
}

export interface AcceptedRunCommand {
  readonly runId: string;
  readonly conversationId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly isAdmin: boolean;
  readonly roleId: string;
  readonly idempotencyKey: string;
  readonly configKey: string;
  readonly message: string;
  readonly maxTurns: number;
  readonly causationId: string;
  /** Publish only after the canonical event's durable acknowledgement succeeds. */
  readonly onDurableEvent: (event: RunEvent) => void;
}

export interface RunCommandAcceptance {
  readonly runId: string;
  readonly conversationId: string;
  readonly created: boolean;
}

export interface RunCommandGateway {
  /** Resolves when command ownership is durably accepted, not when inference finishes. */
  start(command: AcceptedRunCommand): Promise<RunCommandAcceptance>;
}

export interface RunEventReplayStore {
  listRunEvents(runId: string, afterEventId?: string): Promise<readonly RunEvent[]>;
}

export interface ServerReadinessProbe {
  check(): Promise<boolean>;
}

export interface SovereignHttpServerOptions {
  readonly authenticator: SessionAuthenticator;
  readonly access: ServerAccessController;
  readonly commands: RunCommandGateway;
  readonly replay: RunEventReplayStore;
  readonly readiness: ServerReadinessProbe;
  readonly identity?: {
    getUserAccess(principal: ServerPrincipal, userId: string): Promise<DurableUserAccess | undefined>;
    setUserAccess(principal: ServerPrincipal, input: {
      userId: string;
      roles: readonly ("member" | "admin")[];
      allowedConfigKeys: readonly string[];
    }): Promise<DurableUserAccess>;
    issueSession(principal: ServerPrincipal, input: {
      userId: string;
      expiresAt: string;
    }): Promise<IssuedSession>;
    revokeSession(principal: ServerPrincipal, sessionId: string): Promise<boolean>;
  };
  readonly approvals?: ApprovalGateway;
  readonly reads?: ProductReadStore;
  readonly broker?: RunEventBroker;
  readonly maxRequestBytes?: number;
  readonly sseHeartbeatMs?: number;
  readonly idFactory?: () => string;
}

interface RunBody {
  configKey: string;
  message: string;
  maxTurns: number;
}

interface AccessBody {
  roles: Array<"member" | "admin">;
  allowedConfigKeys: string[];
}

const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONFIG_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/;

class HttpProblem extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
}

function json(response: ServerResponse, status: number, value: unknown, requestId: string): void {
  securityHeaders(response);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("x-request-id", requestId);
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage, limit: number): Promise<unknown> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new HttpProblem(415, "request.content-type");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const owned = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += owned.byteLength;
    if (bytes > limit) throw new HttpProblem(413, "request.too-large");
    chunks.push(owned);
  }
  if (bytes === 0) throw new HttpProblem(400, "request.empty");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpProblem(400, "request.invalid-json");
  }
}

function runBody(value: unknown): RunBody {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpProblem(400, "run.invalid");
  }
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).filter((key) => !new Set(["configKey", "message", "maxTurns"]).has(key));
  if (unknown.length > 0) throw new HttpProblem(400, "run.invalid");
  if (typeof input["configKey"] !== "string" || !CONFIG_KEY.test(input["configKey"])) {
    throw new HttpProblem(400, "run.invalid-config");
  }
  if (typeof input["message"] !== "string" || input["message"].trim().length === 0 || input["message"].length > 32_768) {
    throw new HttpProblem(400, "run.invalid-message");
  }
  if (!Number.isSafeInteger(input["maxTurns"]) || Number(input["maxTurns"]) <= 0 || Number(input["maxTurns"]) > 32) {
    throw new HttpProblem(400, "run.invalid-max-turns");
  }
  return { configKey: input["configKey"], message: input["message"], maxTurns: Number(input["maxTurns"]) };
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HttpProblem(400, code);
  return value as Record<string, unknown>;
}

function exact(input: Record<string, unknown>, fields: readonly string[], code: string): void {
  const allowed = new Set(fields);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new HttpProblem(400, code);
}

function accessBody(value: unknown): AccessBody {
  const input = record(value, "identity.access-invalid");
  exact(input, ["roles", "allowedConfigKeys"], "identity.access-invalid");
  if (!Array.isArray(input["roles"]) || input["roles"].length === 0
      || input["roles"].length > 2
      || input["roles"].some((role) => role !== "member" && role !== "admin")
      || new Set(input["roles"]).size !== input["roles"].length) {
    throw new HttpProblem(400, "identity.access-invalid");
  }
  if (!Array.isArray(input["allowedConfigKeys"]) || input["allowedConfigKeys"].length === 0
      || input["allowedConfigKeys"].length > 64
      || input["allowedConfigKeys"].some((key) => typeof key !== "string" || !CONFIG_KEY.test(key))
      || new Set(input["allowedConfigKeys"]).size !== input["allowedConfigKeys"].length) {
    throw new HttpProblem(400, "identity.access-invalid");
  }
  return {
    roles: input["roles"] as Array<"member" | "admin">,
    allowedConfigKeys: input["allowedConfigKeys"] as string[],
  };
}

function issueSessionBody(value: unknown): { userId: string; expiresAt: string } {
  const input = record(value, "identity.session-invalid");
  exact(input, ["userId", "expiresAt"], "identity.session-invalid");
  if (typeof input["userId"] !== "string" || !RESOURCE_ID.test(input["userId"])
      || typeof input["expiresAt"] !== "string" || Number.isNaN(Date.parse(input["expiresAt"]))) {
    throw new HttpProblem(400, "identity.session-invalid");
  }
  return { userId: input["userId"], expiresAt: input["expiresAt"] };
}

function approvalBody(value: unknown): ApprovalDecisionInput[] {
  const input = record(value, "approval.resolution-invalid");
  exact(input, ["decisions"], "approval.resolution-invalid");
  if (!Array.isArray(input["decisions"]) || input["decisions"].length === 0 || input["decisions"].length > 64) {
    throw new HttpProblem(400, "approval.resolution-invalid");
  }
  const decisions = input["decisions"].map((candidate) => {
    const decision = record(candidate, "approval.resolution-invalid");
    exact(decision, ["approvalId", "decision"], "approval.resolution-invalid");
    if (typeof decision["approvalId"] !== "string" || !RESOURCE_ID.test(decision["approvalId"])
        || (decision["decision"] !== "approved" && decision["decision"] !== "denied")) {
      throw new HttpProblem(400, "approval.resolution-invalid");
    }
    return {
      approvalId: decision["approvalId"],
      decision: decision["decision"] as "approved" | "denied",
    };
  });
  if (new Set(decisions.map((item) => item.approvalId)).size !== decisions.length) {
    throw new HttpProblem(400, "approval.resolution-invalid");
  }
  return decisions;
}

function pathId(pathname: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(pathname);
  if (!match) return undefined;
  const id = match[1];
  return id && RESOURCE_ID.test(id) ? id : undefined;
}

function pageQuery(
  url: URL,
  cursorName: "afterSequence" | "afterId" | "afterJournalSequence",
): { limit: number; cursor?: string } {
  const allowed = new Set([cursorName, "limit"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new HttpProblem(400, "request.invalid-query");
    }
  }
  const rawLimit = url.searchParams.get("limit") ?? "50";
  if (!/^\d+$/.test(rawLimit)) throw new HttpProblem(400, "request.invalid-query");
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
    throw new HttpProblem(400, "request.invalid-query");
  }
  const cursor = url.searchParams.get(cursorName) ?? undefined;
  if (cursor !== undefined && cursorName === "afterId" && !RESOURCE_ID.test(cursor)) {
    throw new HttpProblem(400, "request.invalid-query");
  }
  if (cursor !== undefined && cursorName !== "afterId" && !/^\d+$/.test(cursor)) {
    throw new HttpProblem(400, "request.invalid-query");
  }
  return { limit, ...(cursor === undefined ? {} : { cursor }) };
}

function noQuery(url: URL): void {
  if (url.search.length > 0) throw new HttpProblem(400, "request.query-unsupported");
}

async function principalFor(
  request: IncomingMessage,
  authenticator: SessionAuthenticator,
  permission: ServerPermission,
): Promise<ServerPrincipal> {
  const authorization = Array.isArray(request.headers.authorization)
    ? undefined
    : request.headers.authorization;
  const principal = await authenticator.authenticate(authorization);
  if (!hasPermission(principal, permission)) throw new HttpProblem(403, "authorization.denied");
  return principal;
}

export function createSovereignHttpServer(options: SovereignHttpServerOptions): Server {
  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const heartbeatMs = options.sseHeartbeatMs ?? DEFAULT_SSE_HEARTBEAT_MS;
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes <= 0) throw new TypeError("maxRequestBytes must be positive");
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs <= 0) throw new TypeError("sseHeartbeatMs must be positive");
  const idFactory = options.idFactory ?? randomUUID;
  const broker = options.broker ?? new RunEventBroker();

  return createServer(async (request, response) => {
    const requestId = idFactory();
    try {
      const url = new URL(request.url ?? "/", "http://sovereign.invalid");
      if (request.headers.origin !== undefined) throw new HttpProblem(403, "origin.not-allowed");
      if (request.headers.cookie !== undefined) throw new HttpProblem(400, "authentication.cookies-unsupported");

      if (request.method === "GET" && url.pathname === "/healthz") {
        noQuery(url);
        json(response, 200, { status: "ok" }, requestId);
        return;
      }
      if (request.method === "GET" && url.pathname === "/readyz") {
        noQuery(url);
        const ready = await options.readiness.check();
        json(response, ready ? 200 : 503, { status: ready ? "ready" : "not-ready" }, requestId);
        return;
      }

      const accessUserId = pathId(url.pathname, /^\/v1\/admin\/users\/([^/]+)\/access$/);
      if ((request.method === "GET" || request.method === "PUT") && accessUserId) {
        noQuery(url);
        if (!options.identity) throw new HttpProblem(503, "identity.unavailable");
        const principal = await principalFor(request, options.authenticator, "identity.admin");
        if (request.method === "GET") {
          const access = await options.identity.getUserAccess(principal, accessUserId);
          if (!access) throw new HttpProblem(404, "resource.not-found");
          json(response, 200, access, requestId);
          return;
        }
        const access = await options.identity.setUserAccess(principal, {
          userId: accessUserId,
          ...accessBody(await body(request, maxRequestBytes)),
        });
        json(response, 200, access, requestId);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/admin/sessions") {
        noQuery(url);
        if (!options.identity) throw new HttpProblem(503, "identity.unavailable");
        const principal = await principalFor(request, options.authenticator, "identity.admin");
        const issued = await options.identity.issueSession(
          principal,
          issueSessionBody(await body(request, maxRequestBytes)),
        );
        json(response, 201, issued, requestId);
        return;
      }

      const revokedSessionId = pathId(url.pathname, /^\/v1\/admin\/sessions\/([^/]+)\/revoke$/);
      if (request.method === "POST" && revokedSessionId) {
        noQuery(url);
        if (!options.identity) throw new HttpProblem(503, "identity.unavailable");
        const principal = await principalFor(request, options.authenticator, "identity.admin");
        const revokeBody = record(await body(request, maxRequestBytes), "identity.session-invalid");
        exact(revokeBody, [], "identity.session-invalid");
        if (!await options.identity.revokeSession(principal, revokedSessionId)) {
          throw new HttpProblem(404, "resource.not-found");
        }
        json(response, 200, { sessionId: revokedSessionId, status: "revoked" }, requestId);
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/approvals") {
        noQuery(url);
        if (!options.approvals) throw new HttpProblem(503, "approval.unavailable");
        const principal = await principalFor(request, options.authenticator, "approval.list");
        json(response, 200, { approvals: await options.approvals.list(principal) }, requestId);
        return;
      }

      const approvalRunId = pathId(url.pathname, /^\/v1\/runs\/([^/]+)\/approvals\/resolve$/);
      if (request.method === "POST" && approvalRunId) {
        noQuery(url);
        if (!options.approvals) throw new HttpProblem(503, "approval.unavailable");
        const principal = await principalFor(request, options.authenticator, "approval.resolve");
        if (!await options.access.authorizeRun(principal, approvalRunId)) {
          throw new HttpProblem(404, "resource.not-found");
        }
        const resolved = await options.approvals.resolve(
          principal,
          approvalRunId,
          approvalBody(await body(request, maxRequestBytes)),
        );
        json(response, 200, resolved, requestId);
        return;
      }

      const messageConversationId = pathId(url.pathname, /^\/v1\/conversations\/([^/]+)\/messages$/);
      if (request.method === "GET" && messageConversationId) {
        if (!options.reads) throw new HttpProblem(503, "reads.unavailable");
        const principal = await principalFor(request, options.authenticator, "conversation.read");
        if (!await options.access.authorizeConversation(principal, messageConversationId)) {
          throw new HttpProblem(404, "resource.not-found");
        }
        const page = pageQuery(url, "afterSequence");
        const messages = await options.reads.listMessages(
          messageConversationId,
          page.cursor === undefined ? -1 : Number(page.cursor),
          page.limit,
        );
        json(response, 200, {
          messages,
          nextAfterSequence: messages.at(-1)?.sequence ?? null,
        }, requestId);
        return;
      }

      const attachmentConversationId = pathId(url.pathname, /^\/v1\/conversations\/([^/]+)\/attachments$/);
      if (request.method === "GET" && attachmentConversationId) {
        if (!options.reads) throw new HttpProblem(503, "reads.unavailable");
        const principal = await principalFor(request, options.authenticator, "attachment.read");
        if (!await options.access.authorizeConversation(principal, attachmentConversationId)) {
          throw new HttpProblem(404, "resource.not-found");
        }
        const page = pageQuery(url, "afterId");
        const attachments = await options.reads.listAttachments(
          attachmentConversationId,
          page.cursor,
          page.limit,
        );
        json(response, 200, {
          attachments,
          nextAfterId: attachments.at(-1)?.attachmentId ?? null,
        }, requestId);
        return;
      }

      const statusRunId = pathId(url.pathname, /^\/v1\/runs\/([^/]+)$/);
      if (request.method === "GET" && statusRunId) {
        noQuery(url);
        if (!options.reads) throw new HttpProblem(503, "reads.unavailable");
        const principal = await principalFor(request, options.authenticator, "run.read");
        if (!await options.access.authorizeRun(principal, statusRunId)) {
          throw new HttpProblem(404, "resource.not-found");
        }
        const run = await options.reads.getRun(statusRunId);
        if (!run) throw new HttpProblem(404, "resource.not-found");
        json(response, 200, run, requestId);
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/admin/audit-events") {
        if (!options.reads) throw new HttpProblem(503, "reads.unavailable");
        await principalFor(request, options.authenticator, "audit.read");
        const page = pageQuery(url, "afterJournalSequence");
        const events = await options.reads.listAudit(
          page.cursor === undefined ? 0 : Number(page.cursor),
          page.limit,
        );
        json(response, 200, {
          events,
          nextAfterJournalSequence: events.at(-1)?.journalSequence ?? null,
        }, requestId);
        return;
      }

      const conversationId = pathId(url.pathname, /^\/v1\/conversations\/([^/]+)\/runs$/);
      if (request.method === "POST" && conversationId) {
        noQuery(url);
        const principal = await principalFor(request, options.authenticator, "conversation.run");
        if (!await options.access.authorizeConversation(principal, conversationId)) {
          throw new HttpProblem(404, "resource.not-found");
        }
        const commandBody = runBody(await body(request, maxRequestBytes));
        if (!principal.allowedConfigKeys.includes(commandBody.configKey)) {
          throw new HttpProblem(403, "model.access-denied");
        }
        const idempotencyHeader = request.headers["idempotency-key"];
        const idempotencyKey = Array.isArray(idempotencyHeader) ? undefined : idempotencyHeader;
        if (idempotencyKey === undefined || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
          throw new HttpProblem(400, "run.invalid-idempotency-key");
        }
        const runId = idFactory();
        const causationId = requestId;
        const accepted = await options.commands.start({
          runId,
          conversationId,
          userId: principal.userId,
          sessionId: principal.sessionId,
          isAdmin: principal.roles.includes("admin"),
          roleId: principal.roles.slice().sort()[0] ?? "member",
          idempotencyKey,
          ...commandBody,
          causationId,
          onDurableEvent: (event) => broker.publish(event),
        });
        json(response, 202, {
          runId: accepted.runId,
          conversationId: accepted.conversationId,
          status: "accepted",
        }, requestId);
        return;
      }

      const runId = pathId(url.pathname, /^\/v1\/runs\/([^/]+)\/events$/);
      if (request.method === "GET" && runId) {
        noQuery(url);
        const principal = await principalFor(request, options.authenticator, "run.events");
        if (!await options.access.authorizeRun(principal, runId)) {
          throw new HttpProblem(404, "resource.not-found");
        }
        const lastEventIdHeader = request.headers["last-event-id"];
        const lastEventId = Array.isArray(lastEventIdHeader) ? undefined : lastEventIdHeader;
        if (lastEventId !== undefined && (!RESOURCE_ID.test(lastEventId) || /[\0\r\n]/.test(lastEventId))) {
          throw new HttpProblem(400, "events.invalid-checkpoint");
        }

        let closed = false;
        let highestSequence = -1;
        const pending: RunEvent[] = [];
        let replaying = true;
        const write = (candidate: RunEvent): boolean => {
          const event = parseRunEvent(candidate);
          if (event.runId !== runId) throw new Error("event replay changed run identity");
          if (event.sequence <= highestSequence) return false;
          highestSequence = event.sequence;
          response.write(encodeRunEventSse(event));
          if (isTerminalRunEvent(event)) {
            closed = true;
            response.end();
          }
          return true;
        };
        const unsubscribe = broker.subscribe(runId, (event) => {
          if (replaying) pending.push(event);
          else {
            try {
              write(event);
            } catch {
              response.destroy();
            }
          }
        });
        let replay: readonly RunEvent[];
        try {
          replay = await options.replay.listRunEvents(runId, lastEventId);
        } catch (error) {
          unsubscribe();
          if (error instanceof RunEventTransportError) {
            throw new HttpProblem(409, "events.checkpoint-unavailable");
          }
          throw error;
        }

        securityHeaders(response);
        response.statusCode = 200;
        response.setHeader("content-type", "text/event-stream; charset=utf-8");
        response.setHeader("connection", "keep-alive");
        response.setHeader("x-accel-buffering", "no");
        response.setHeader("x-request-id", requestId);
        response.flushHeaders();

        const close = (): void => {
          closed = true;
          unsubscribe();
        };
        response.once("close", close);
        const heartbeat = setInterval(() => {
          if (!closed) response.write(": keepalive\n\n");
        }, heartbeatMs);
        heartbeat.unref();
        try {
          for (const event of replay) {
            if (closed) break;
            write(event);
          }
          for (const event of pending) {
            if (closed) break;
            write(event);
          }
          replaying = false;
        } finally {
          if (closed) {
            clearInterval(heartbeat);
            unsubscribe();
          } else {
            response.once("close", () => {
              clearInterval(heartbeat);
              unsubscribe();
            });
          }
        }
        return;
      }

      throw new HttpProblem(404, "route.not-found");
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof AuthenticationError) {
        response.setHeader("www-authenticate", 'Bearer realm="sovereign"');
        json(response, 401, { error: { code: error.code }, requestId }, requestId);
        return;
      }
      if (error instanceof HttpProblem) {
        json(response, error.status, { error: { code: error.code }, requestId }, requestId);
        return;
      }
      if (error instanceof RunCommandConflictError) {
        json(response, 409, { error: { code: error.code }, requestId }, requestId);
        return;
      }
      if (error instanceof RunControlError) {
        const status = error.code === "run.idempotency-conflict"
          ? 409
          : error.code === "control.provider-unaccountable"
            ? 503
            : 429;
        json(response, status, { error: { code: error.code }, requestId }, requestId);
        return;
      }
      if (error instanceof Error && error.message === "approval.not-found") {
        json(response, 404, { error: { code: "resource.not-found" }, requestId }, requestId);
        return;
      }
      if (error instanceof Error && new Set([
        "approval.batch-incomplete", "approval.resolution-conflict", "approval.expired",
      ]).has(error.message)) {
        json(response, 409, { error: { code: error.message }, requestId }, requestId);
        return;
      }
      if (error instanceof Error && new Set([
        "identity.access-update-denied", "identity.session-issue-denied",
      ]).has(error.message)) {
        json(response, 404, { error: { code: "resource.not-found" }, requestId }, requestId);
        return;
      }
      json(response, 503, { error: { code: "server.unavailable" }, requestId }, requestId);
    }
  });
}
