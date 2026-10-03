import { approvalArgumentsHash, parseApprovalRequest, type ApprovalRequest } from "../../approval.ts";
import type { JsonObject, JsonValue } from "../../json.ts";
import {
  isoParameter,
  jsonParameter,
  oneRow,
  requireNonEmpty,
  type SqlExecutor,
} from "../sql.ts";

export class ToolRepository {
  readonly #database: SqlExecutor;

  constructor(database: SqlExecutor) {
    this.#database = database;
  }

  async recordRequest(input: {
    runId: string;
    toolCallId: string;
    turnId: string;
    conversationId: string;
    toolName: string;
    arguments: JsonObject;
    requestedAt: string;
  }): Promise<void> {
    await this.#database.query(
      `INSERT INTO tool_calls (
        run_id, tool_call_id, turn_id, conversation_id, tool_name,
        arguments, arguments_hash, requested_at
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::timestamptz)`,
      [
        requireNonEmpty(input.runId, "tool.runId"),
        requireNonEmpty(input.toolCallId, "tool.toolCallId"),
        requireNonEmpty(input.turnId, "tool.turnId"),
        requireNonEmpty(input.conversationId, "tool.conversationId"),
        requireNonEmpty(input.toolName, "tool.toolName"),
        jsonParameter(input.arguments),
        approvalArgumentsHash(input.arguments),
        isoParameter(input.requestedAt, "tool.requestedAt"),
      ],
    );
  }

  async recordDecision(input: {
    id: string;
    runId: string;
    toolCallId: string;
    capability: string;
    capabilities: readonly string[];
    decision: "allow" | "deny" | "requireApproval";
    reasonCode: string;
    detail?: string;
    decidedAt: string;
  }): Promise<void> {
    if (input.capabilities.length === 0 || input.capabilities.some((item) => item.length === 0)) {
      throw new TypeError("tool.capabilities must be a non-empty string array");
    }
    await this.#database.query(
      `INSERT INTO tool_decisions (
        id, run_id, tool_call_id, capability, capabilities,
        decision, reason_code, detail, decided_at
      ) VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9::timestamptz)`,
      [
        requireNonEmpty(input.id, "decision.id"),
        requireNonEmpty(input.runId, "decision.runId"),
        requireNonEmpty(input.toolCallId, "decision.toolCallId"),
        requireNonEmpty(input.capability, "decision.capability"),
        [...input.capabilities],
        input.decision,
        requireNonEmpty(input.reasonCode, "decision.reasonCode"),
        input.detail ?? null,
        isoParameter(input.decidedAt, "decision.decidedAt"),
      ],
    );
  }

  async recordStarted(runId: string, toolCallId: string, startedAt: string): Promise<void> {
    const result = await this.#database.query(
      `UPDATE tool_calls
       SET started_at = $3::timestamptz
       WHERE run_id = $1 AND tool_call_id = $2 AND started_at IS NULL
       RETURNING tool_call_id`,
      [
        requireNonEmpty(runId, "tool.runId"),
        requireNonEmpty(toolCallId, "tool.toolCallId"),
        isoParameter(startedAt, "tool.startedAt"),
      ],
    );
    oneRow(result, "start tool call");
  }

  async recordCompleted(input: {
    runId: string;
    toolCallId: string;
    isError: boolean;
    result: JsonValue;
    completedAt: string;
  }): Promise<void> {
    const result = await this.#database.query(
      `UPDATE tool_calls
       SET completed_at = $3::timestamptz,
           is_error = $4,
           result = $5::jsonb
       WHERE run_id = $1 AND tool_call_id = $2 AND completed_at IS NULL
       RETURNING tool_call_id`,
      [
        requireNonEmpty(input.runId, "tool.runId"),
        requireNonEmpty(input.toolCallId, "tool.toolCallId"),
        isoParameter(input.completedAt, "tool.completedAt"),
        input.isError,
        jsonParameter(input.result),
      ],
    );
    oneRow(result, "complete tool call");
  }
}

export class ApprovalRepository {
  readonly #database: SqlExecutor;

  constructor(database: SqlExecutor) {
    this.#database = database;
  }

  async createPending(value: ApprovalRequest): Promise<void> {
    const request = parseApprovalRequest(value);
    await this.#database.query(
      `INSERT INTO approvals (
        id, run_id, tool_call_id, arguments_hash, capability, capabilities,
        reason_code, status, requested_at, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6::text[], $7, 'pending', $8::timestamptz, $9::timestamptz)`,
      [
        request.approvalId,
        request.runId,
        request.toolCall.id,
        request.argumentsHash,
        request.capability,
        [...request.capabilities],
        request.reasonCode,
        request.requestedAt,
        request.expiresAt,
      ],
    );
  }

  async resolve(input: {
    approvalId: string;
    status: "approved" | "denied" | "expired";
    resolvedAt: string;
    resolvedBy?: string;
    resolutionSessionId?: string;
    resolutionRequestSha256?: string;
    reasonCode?: string;
  }): Promise<void> {
    const authenticated = input.status === "approved" || input.status === "denied";
    if (authenticated !== (
      input.resolvedBy !== undefined
      && input.resolutionSessionId !== undefined
      && input.resolutionRequestSha256 !== undefined
    )) {
      throw new TypeError("approved or denied resolutions require authenticated actor and session bindings");
    }
    if (input.resolutionRequestSha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.resolutionRequestSha256)) {
      throw new TypeError("approval.resolutionRequestSha256 must be lowercase SHA-256 hex");
    }
    const result = await this.#database.query(
      `UPDATE approvals
       SET status = $2,
           resolved_at = $3::timestamptz,
           resolved_by = $4,
           resolution_reason_code = $5,
           resolution_session_id = $6,
           resolution_request_sha256 = $7
       WHERE id = $1 AND status = 'pending'
       RETURNING id`,
      [
        requireNonEmpty(input.approvalId, "approval.id"),
        input.status,
        isoParameter(input.resolvedAt, "approval.resolvedAt"),
        input.resolvedBy ?? null,
        input.reasonCode ?? null,
        input.resolutionSessionId ?? null,
        input.resolutionRequestSha256 ?? null,
      ],
    );
    oneRow(result, "resolve approval");
  }
}
