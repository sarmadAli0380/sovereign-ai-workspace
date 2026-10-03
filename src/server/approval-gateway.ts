import { createHash } from "node:crypto";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
  ApprovalResumeController,
  parseApprovalRequest,
  type ApprovalRequest,
  type ApprovalResolution,
} from "../approval.ts";
import { ConversationManager } from "../conversation-manager.ts";
import { runtimeMessageToProductEnvelope } from "../messages/codec.ts";
import type { ToolExecutionController } from "../tool-execution.ts";
import type { ToolRegistry } from "../tool-registry.ts";
import { parseJsonColumn, requireNonEmpty, type SqlExecutor } from "../storage/sql.ts";
import type { MessageRepository } from "../storage/repositories/messages.ts";
import type { ServerPrincipal } from "./auth.ts";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

function requestHash(runId: string, decisions: readonly ApprovalDecisionInput[]): string {
  return createHash("sha256").update(canonical({ runId, decisions })).digest("hex");
}

function timestamp(value: unknown, path: string): string {
  const serialized = value instanceof Date ? value.toISOString() : value;
  if (typeof serialized !== "string" || Number.isNaN(Date.parse(serialized))) {
    throw new TypeError(`${path} must be a timestamp`);
  }
  return new Date(serialized).toISOString();
}

export interface PendingApprovalView {
  readonly approvalId: string;
  readonly runId: string;
  readonly conversationId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly argumentsHash: string;
  readonly capability: string;
  readonly capabilities: readonly string[];
  readonly reasonCode: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
}

export interface ApprovalDecisionInput {
  readonly approvalId: string;
  readonly decision: "approved" | "denied";
}

export interface ApprovalResolutionResult {
  readonly runId: string;
  readonly resolutions: readonly ApprovalResolution[];
  readonly replayed: boolean;
}

interface StoredApprovalBatch {
  requests: ApprovalRequest[];
  statuses: Array<"pending" | "approved" | "denied" | "expired">;
  resolutionSessionIds: Array<string | undefined>;
  resolutionRequestHashes: Array<string | undefined>;
}

export class PostgresApprovalStore {
  readonly #database: SqlExecutor;

  constructor(database: SqlExecutor) {
    this.#database = database;
  }

  async listPending(principal: ServerPrincipal, limit = 100): Promise<PendingApprovalView[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) throw new TypeError("approval limit is invalid");
    const rows = await this.#rows(principal, undefined, true, limit);
    return rows.map((row) => this.#view(this.#request(row)));
  }

  async loadRun(principal: ServerPrincipal, runId: string): Promise<StoredApprovalBatch | undefined> {
    const rows = await this.#rows(principal, requireNonEmpty(runId, "approval.runId"), false, 100);
    if (rows.length === 0) return undefined;
    return {
      requests: rows.map((row) => this.#request(row)),
      statuses: rows.map((row) => {
        const status = row["status"];
        if (status !== "pending" && status !== "approved" && status !== "denied" && status !== "expired") {
          throw new TypeError("approval.status is invalid");
        }
        return status;
      }),
      resolutionSessionIds: rows.map((row) => typeof row["resolution_session_id"] === "string"
        ? row["resolution_session_id"] : undefined),
      resolutionRequestHashes: rows.map((row) => typeof row["resolution_request_sha256"] === "string"
        ? row["resolution_request_sha256"] : undefined),
    };
  }

  async resolveBatch(input: {
    runId: string;
    actorUserId: string;
    actorSessionId: string;
    requestSha256: string;
    resolutions: readonly ApprovalResolution[];
    resolvedAt: string;
  }): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(input.requestSha256)) throw new TypeError("approval request hash is invalid");
    if (input.resolutions.length === 0
        || new Set(input.resolutions.map((item) => item.approvalId)).size !== input.resolutions.length
        || input.resolutions.some((item) => item.decision !== "approved" && item.decision !== "denied")) {
      throw new TypeError("approval resolutions must be a non-empty unique decision batch");
    }
    const payload = input.resolutions.map((resolution) => ({
      approvalId: resolution.approvalId,
      status: resolution.decision,
      reasonCode: resolution.reasonCode ?? "approval.authenticated",
    }));
    const result = await this.#database.query(
      `WITH submitted AS MATERIALIZED (
         SELECT * FROM jsonb_to_recordset($2::jsonb) AS input(
           "approvalId" text, status text, "reasonCode" text
         )
       ), eligible AS MATERIALIZED (
         SELECT count(*) = (SELECT count(*) FROM submitted) AS complete
         FROM approvals AS approval
         JOIN submitted ON submitted."approvalId" = approval.id
         WHERE approval.run_id = $1 AND approval.status = 'pending'
       ), updated AS (
         UPDATE approvals AS approval
         SET status = submitted.status,
             resolved_at = $6::timestamptz,
             resolved_by = $3,
             resolution_session_id = $4,
             resolution_request_sha256 = $5,
             resolution_reason_code = submitted."reasonCode"
         FROM submitted, eligible
         WHERE eligible.complete
           AND approval.id = submitted."approvalId"
           AND approval.run_id = $1
           AND approval.status = 'pending'
           AND submitted.status IN ('approved', 'denied')
         RETURNING approval.id
       )
       SELECT count(*)::text AS resolved FROM updated`,
      [
        requireNonEmpty(input.runId, "approval.runId"),
        JSON.stringify(payload),
        requireNonEmpty(input.actorUserId, "approval.actorUserId"),
        requireNonEmpty(input.actorSessionId, "approval.actorSessionId"),
        input.requestSha256,
        timestamp(input.resolvedAt, "approval.resolvedAt"),
      ],
    );
    if (Number(result.rows[0]?.["resolved"] ?? 0) !== payload.length) {
      throw new Error("approval.resolution-conflict");
    }
  }

  async appendToolResults(input: {
    conversationId: string;
    approvalIds: readonly string[];
    results: readonly ToolResultMessage[];
  }): Promise<void> {
    if (input.approvalIds.length !== input.results.length || input.results.length === 0) return;
    const payload = input.results.map((result, index) => {
      const approvalId = requireNonEmpty(input.approvalIds[index], "approval.id");
      const message = runtimeMessageToProductEnvelope(result, {
        messageId: `approval-result:${approvalId}`,
      });
      return {
        position: index,
        id: message.messageId,
        schemaVersion: message.schemaVersion,
        role: message.role,
        content: message,
        createdAt: message.createdAt,
      };
    });
    const result = await this.#database.query(
      `WITH locked AS MATERIALIZED (
         SELECT id FROM conversations WHERE id = $1 FOR UPDATE
       ), base AS MATERIALIZED (
         SELECT COALESCE(MAX(message.seq) + 1, 0) AS next_seq
         FROM messages AS message, locked
         WHERE message.conversation_id = locked.id
       ), submitted AS MATERIALIZED (
         SELECT * FROM jsonb_to_recordset($2::jsonb) AS input(
           position integer, id text, "schemaVersion" smallint, role text,
           content jsonb, "createdAt" timestamptz
         )
       ), inserted AS (
         INSERT INTO messages (
           id, conversation_id, seq, schema_version, role, content, created_at
         )
         SELECT submitted.id, locked.id, base.next_seq + submitted.position,
                submitted."schemaVersion", submitted.role, submitted.content,
                submitted."createdAt"
         FROM submitted, locked, base
         ON CONFLICT (id) DO NOTHING
         RETURNING id
       )
       SELECT count(*)::text AS inserted FROM inserted`,
      [requireNonEmpty(input.conversationId, "approval.conversationId"), JSON.stringify(payload)],
    );
    const inserted = Number(result.rows[0]?.["inserted"] ?? 0);
    if (inserted !== 0 && inserted !== payload.length) throw new Error("approval.tool-result-partial-write");
    if (inserted === 0) {
      const existing = await this.#database.query(
        `SELECT count(*)::text AS existing FROM messages
         WHERE conversation_id = $1 AND id = ANY($2::text[])`,
        [input.conversationId, payload.map((item) => item.id)],
      );
      if (Number(existing.rows[0]?.["existing"] ?? 0) !== payload.length) {
        throw new Error("approval.tool-result-conflict");
      }
    }
  }

  async #rows(
    principal: ServerPrincipal,
    runId: string | undefined,
    pendingOnly: boolean,
    limit: number,
  ): Promise<readonly Record<string, unknown>[]> {
    const result = await this.#database.query(
      `WITH expired AS (
         UPDATE approvals
         SET status = 'expired', resolved_at = expires_at
         WHERE status = 'pending' AND expires_at <= transaction_timestamp()
       )
       SELECT approval.id, approval.run_id, run.conversation_id,
              approval.tool_call_id, tool.tool_name, tool.arguments,
              approval.arguments_hash, approval.capability, approval.capabilities,
              approval.reason_code, approval.status, approval.requested_at,
              approval.expires_at, approval.resolution_session_id,
              approval.resolution_request_sha256
       FROM approvals AS approval
       JOIN runs AS run ON run.id = approval.run_id
       JOIN conversations AS conversation ON conversation.id = run.conversation_id
       JOIN users AS owner ON owner.id = conversation.created_by
       JOIN tool_calls AS tool
         ON tool.run_id = approval.run_id AND tool.tool_call_id = approval.tool_call_id
       WHERE owner.status = 'active' AND conversation.archived_at IS NULL
         AND ($1::boolean OR conversation.created_by = $2)
         AND ($3::text IS NULL OR approval.run_id = $3)
         AND (NOT $4::boolean OR approval.status = 'pending')
       ORDER BY approval.requested_at, approval.id
       LIMIT $5`,
      [principal.roles.includes("admin"), principal.userId, runId ?? null, pendingOnly, limit],
    );
    return result.rows;
  }

  #request(row: Record<string, unknown>): ApprovalRequest {
    const capabilities = row["capabilities"];
    if (!Array.isArray(capabilities)) throw new TypeError("approval.capabilities must be an array");
    return parseApprovalRequest({
      schemaVersion: 1,
      approvalId: requireNonEmpty(row["id"], "approval.id"),
      runId: requireNonEmpty(row["run_id"], "approval.runId"),
      conversationId: requireNonEmpty(row["conversation_id"], "approval.conversationId"),
      toolCall: {
        type: "toolCall",
        id: requireNonEmpty(row["tool_call_id"], "approval.toolCallId"),
        name: requireNonEmpty(row["tool_name"], "approval.toolName"),
        arguments: parseJsonColumn(row["arguments"], "approval.arguments"),
      },
      argumentsHash: requireNonEmpty(row["arguments_hash"], "approval.argumentsHash"),
      capability: requireNonEmpty(row["capability"], "approval.capability"),
      capabilities,
      reasonCode: requireNonEmpty(row["reason_code"], "approval.reasonCode"),
      requestedAt: timestamp(row["requested_at"], "approval.requestedAt"),
      expiresAt: timestamp(row["expires_at"], "approval.expiresAt"),
    });
  }

  #view(request: ApprovalRequest): PendingApprovalView {
    return Object.freeze({
      approvalId: request.approvalId,
      runId: request.runId,
      conversationId: request.conversationId,
      toolCallId: request.toolCall.id,
      toolName: request.toolCall.name,
      arguments: Object.freeze({ ...request.toolCall.arguments }),
      argumentsHash: request.argumentsHash,
      capability: request.capability,
      capabilities: Object.freeze([...request.capabilities]),
      reasonCode: request.reasonCode,
      requestedAt: request.requestedAt,
      expiresAt: request.expiresAt,
    });
  }
}

export interface ApprovalGateway {
  list(principal: ServerPrincipal): Promise<readonly PendingApprovalView[]>;
  resolve(
    principal: ServerPrincipal,
    runId: string,
    decisions: readonly ApprovalDecisionInput[],
  ): Promise<ApprovalResolutionResult>;
}

export class DurableApprovalGateway implements ApprovalGateway {
  readonly #store: PostgresApprovalStore;
  readonly #messages: MessageRepository;
  readonly #controller: ApprovalResumeController;
  readonly #registry: ToolRegistry;
  readonly #executionController: ToolExecutionController;
  readonly #deploymentId: string;
  readonly #contextWindow: number;
  readonly #now: () => number;

  constructor(options: {
    store: PostgresApprovalStore;
    messages: MessageRepository;
    controller?: ApprovalResumeController;
    registry: ToolRegistry;
    executionController: ToolExecutionController;
    deploymentId: string;
    contextWindow: number;
    now?: () => number;
  }) {
    this.#store = options.store;
    this.#messages = options.messages;
    this.#controller = options.controller ?? new ApprovalResumeController();
    this.#registry = options.registry;
    this.#executionController = options.executionController;
    this.#deploymentId = requireNonEmpty(options.deploymentId, "approval.deploymentId");
    if (!Number.isSafeInteger(options.contextWindow) || options.contextWindow <= 0) {
      throw new TypeError("approval contextWindow must be positive");
    }
    this.#contextWindow = options.contextWindow;
    this.#now = options.now ?? Date.now;
  }

  list(principal: ServerPrincipal): Promise<readonly PendingApprovalView[]> {
    return this.#store.listPending(principal);
  }

  async resolve(
    principal: ServerPrincipal,
    runId: string,
    decisions: readonly ApprovalDecisionInput[],
  ): Promise<ApprovalResolutionResult> {
    if (decisions.length === 0 || decisions.length > 64) throw new TypeError("approval decisions are invalid");
    const normalized = decisions.map((item) => {
      const unknown = Object.keys(item).filter((key) => key !== "approvalId" && key !== "decision");
      if (unknown.length > 0) throw new TypeError("approval decision has unknown fields");
      const approvalId = requireNonEmpty(item.approvalId, "approval.id");
      if (item.decision !== "approved" && item.decision !== "denied") throw new TypeError("approval decision is invalid");
      return { approvalId, decision: item.decision };
    });
    if (new Set(normalized.map((item) => item.approvalId)).size !== normalized.length) {
      throw new TypeError("approval decisions must be unique");
    }
    const batch = await this.#store.loadRun(principal, runId);
    if (!batch) throw new Error("approval.not-found");
    if (batch.requests.length !== normalized.length
      || batch.requests.some((request) => !normalized.some((item) => item.approvalId === request.approvalId))) {
      throw new Error("approval.batch-incomplete");
    }
    const ordered = batch.requests.map((request) => normalized.find((item) => item.approvalId === request.approvalId)!);
    const fingerprint = requestHash(runId, ordered);
    if (batch.statuses.some((status) => status === "expired")) throw new Error("approval.expired");
    if (batch.statuses.every((status) => status !== "pending")) {
      const replayed = batch.statuses.every((status, index) => status === ordered[index]!.decision)
        && batch.resolutionSessionIds.every((sessionId) => sessionId === principal.sessionId)
        && batch.resolutionRequestHashes.every((hash) => hash === fingerprint);
      if (!replayed) throw new Error("approval.resolution-conflict");
      return {
        runId,
        replayed: true,
        resolutions: batch.requests.map((request, index) => ({
          approvalId: request.approvalId,
          toolCallId: request.toolCall.id,
          decision: ordered[index]!.decision,
          actorId: principal.userId,
          reasonCode: "approval.authenticated",
        })),
      };
    }
    if (batch.statuses.some((status) => status !== "pending")) throw new Error("approval.resolution-conflict");

    const conversation = await ConversationManager.loadCurrent({
      conversationId: batch.requests[0]!.conversationId,
      repository: this.#messages,
      contextWindow: this.#contextWindow,
      tools: this.#registry.getToolDefinitions(),
    });
    const collected: ApprovalResolution[] = [];
    const result = await this.#controller.resume({
      runId,
      conversationId: batch.requests[0]!.conversationId,
      requests: batch.requests,
      submissions: ordered.map((item) => ({
        ...item,
        authorization: principal.sessionId,
      })),
      authority: { async verify(_request, submission) {
        if (submission.authorization !== principal.sessionId) throw new Error("approval.unauthorized");
        return { actorId: principal.userId, reasonCode: "approval.authenticated" };
      } },
      onResolved: async (resolution) => {
        collected.push(resolution);
        if (collected.length === batch.requests.length) {
          await this.#store.resolveBatch({
            runId,
            actorUserId: principal.userId,
            actorSessionId: principal.sessionId,
            requestSha256: fingerprint,
            resolutions: collected,
            resolvedAt: new Date(this.#now()).toISOString(),
          });
        }
      },
      registry: this.#registry,
      executionController: this.#executionController,
      policyContext: {
        deploymentId: this.#deploymentId,
        roleId: principal.roles.slice().sort()[0] ?? "member",
        workspaceId: batch.requests[0]!.conversationId,
      },
      conversation,
      now: this.#now,
    });
    await this.#store.appendToolResults({
      conversationId: batch.requests[0]!.conversationId,
      approvalIds: batch.requests.map((request) => request.approvalId),
      results: result.toolResults,
    });
    return Object.freeze({ runId, resolutions: result.resolutions, replayed: result.replayed });
  }
}
