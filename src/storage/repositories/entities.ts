import type { JsonObject } from "../../json.ts";
import {
  isoParameter,
  jsonParameter,
  oneRow,
  requireNonEmpty,
  requireTimestamp,
  requireWholeNumber,
  StorageDecodeError,
  type SqlExecutor,
} from "../sql.ts";

function optionalNonEmpty(value: string | undefined, path: string): string | null {
  return value === undefined ? null : requireNonEmpty(value, path);
}

function nonNegativeInteger(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${path} must be a non-negative safe integer`);
  }
  return value;
}

export class IdentityRepository {
  readonly #database: SqlExecutor;

  constructor(database: SqlExecutor) {
    this.#database = database;
  }

  async createUser(input: {
    id: string;
    externalSubject: string;
    displayName: string;
    createdAt: string;
  }): Promise<void> {
    await this.#database.query(
      `INSERT INTO users (id, external_subject, display_name, created_at)
       VALUES ($1, $2, $3, $4::timestamptz)`,
      [
        requireNonEmpty(input.id, "user.id"),
        requireNonEmpty(input.externalSubject, "user.externalSubject"),
        requireNonEmpty(input.displayName, "user.displayName"),
        isoParameter(input.createdAt, "user.createdAt"),
      ],
    );
  }

  async createConversation(input: {
    id: string;
    createdBy: string;
    title?: string;
    createdAt: string;
  }): Promise<void> {
    await this.#database.query(
      `INSERT INTO conversations (id, created_by, title, created_at)
       VALUES ($1, $2, $3, $4::timestamptz)`,
      [
        requireNonEmpty(input.id, "conversation.id"),
        requireNonEmpty(input.createdBy, "conversation.createdBy"),
        optionalNonEmpty(input.title, "conversation.title"),
        isoParameter(input.createdAt, "conversation.createdAt"),
      ],
    );
  }
}

export type StoredRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "needs_approval"
  | "persistence_unavailable";

export class RunRepository {
  readonly #database: SqlExecutor;

  constructor(database: SqlExecutor) {
    this.#database = database;
  }

  async start(input: {
    id: string;
    conversationId: string;
    initiatedBy?: string;
    causationId: string;
    correlationId?: string;
    configKey: string;
    provider: string;
    model: string;
    startedAt: string;
  }): Promise<void> {
    await this.#database.query(
      `INSERT INTO runs (
        id, conversation_id, initiated_by, causation_id, correlation_id,
        config_key, provider, model, status, started_at, runtime_started_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'running', $9::timestamptz, $9::timestamptz)`,
      [
        requireNonEmpty(input.id, "run.id"),
        requireNonEmpty(input.conversationId, "run.conversationId"),
        optionalNonEmpty(input.initiatedBy, "run.initiatedBy"),
        requireNonEmpty(input.causationId, "run.causationId"),
        optionalNonEmpty(input.correlationId, "run.correlationId"),
        requireNonEmpty(input.configKey, "run.configKey"),
        requireNonEmpty(input.provider, "run.provider"),
        requireNonEmpty(input.model, "run.model"),
        isoParameter(input.startedAt, "run.startedAt"),
      ],
    );
  }

  async finish(input: {
    id: string;
    status: Exclude<StoredRunStatus, "running">;
    terminalReason: string;
    terminalCode?: string;
    usage?: JsonObject;
    completedAt: string;
  }): Promise<void> {
    const result = await this.#database.query(
      `UPDATE runs
       SET status = $2,
           terminal_reason = $3,
           terminal_code = $4,
           usage = $5::jsonb,
           completed_at = $6::timestamptz
       WHERE id = $1 AND status = 'running'
       RETURNING id`,
      [
        requireNonEmpty(input.id, "run.id"),
        input.status,
        requireNonEmpty(input.terminalReason, "run.terminalReason"),
        optionalNonEmpty(input.terminalCode, "run.terminalCode"),
        input.usage ? jsonParameter(input.usage) : null,
        isoParameter(input.completedAt, "run.completedAt"),
      ],
    );
    oneRow(result, "finish run");
  }

  async startTurn(input: {
    id: string;
    runId: string;
    conversationId: string;
    turnNumber: number;
    inputMessageId?: string;
    startedAt: string;
  }): Promise<void> {
    await this.#database.query(
      `INSERT INTO turns (
        id, run_id, conversation_id, turn_number, input_message_id, started_at
      ) VALUES ($1, $2, $3, $4, $5, $6::timestamptz)`,
      [
        requireNonEmpty(input.id, "turn.id"),
        requireNonEmpty(input.runId, "turn.runId"),
        requireNonEmpty(input.conversationId, "turn.conversationId"),
        nonNegativeInteger(input.turnNumber, "turn.turnNumber"),
        optionalNonEmpty(input.inputMessageId, "turn.inputMessageId"),
        isoParameter(input.startedAt, "turn.startedAt"),
      ],
    );
  }

  async completeTurn(input: {
    id: string;
    stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
    budgetTokens: number;
    budgetSource: "anchored" | "estimated";
    usage?: JsonObject;
    completedAt: string;
  }): Promise<void> {
    const result = await this.#database.query(
      `UPDATE turns
       SET stop_reason = $2,
           budget_tokens = $3,
           budget_source = $4,
           usage = $5::jsonb,
           completed_at = $6::timestamptz
       WHERE id = $1 AND completed_at IS NULL
       RETURNING id`,
      [
        requireNonEmpty(input.id, "turn.id"),
        input.stopReason,
        nonNegativeInteger(input.budgetTokens, "turn.budgetTokens"),
        input.budgetSource,
        input.usage ? jsonParameter(input.usage) : null,
        isoParameter(input.completedAt, "turn.completedAt"),
      ],
    );
    oneRow(result, "complete turn");
  }
}

export class AttachmentRepository {
  readonly #database: SqlExecutor;

  constructor(database: SqlExecutor) {
    this.#database = database;
  }

  async create(input: {
    id: string;
    conversationId: string;
    messageId?: string;
    objectKey: string;
    sha256: string;
    byteSize: number;
    mimeType: string;
    originalName?: string;
    state?: "staging" | "available";
    createdAt: string;
  }): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(input.sha256)) {
      throw new TypeError("attachment.sha256 must be lowercase SHA-256 hex");
    }
    const result = await this.#database.query(
      `INSERT INTO attachments (
        id, conversation_id, message_id, object_key, sha256,
        byte_size, mime_type, original_name, state, created_at
      )
      SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz
      WHERE (
        $3::text IS NULL OR EXISTS (
          SELECT 1 FROM current_messages WHERE id = $3 AND conversation_id = $2
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM conversations AS conversation
        JOIN erasure_tombstones AS erased
          ON (erased.subject_type = 'conversation' AND erased.subject_id = conversation.id)
          OR (erased.subject_type = 'user' AND erased.subject_id = conversation.created_by)
        WHERE conversation.id = $2
      )
      RETURNING id`,
      [
        requireNonEmpty(input.id, "attachment.id"),
        requireNonEmpty(input.conversationId, "attachment.conversationId"),
        optionalNonEmpty(input.messageId, "attachment.messageId"),
        requireNonEmpty(input.objectKey, "attachment.objectKey"),
        input.sha256,
        nonNegativeInteger(input.byteSize, "attachment.byteSize"),
        requireNonEmpty(input.mimeType, "attachment.mimeType"),
        optionalNonEmpty(input.originalName, "attachment.originalName"),
        input.state ?? "available",
        isoParameter(input.createdAt, "attachment.createdAt"),
      ],
    );
    oneRow(result, "create attachment");
  }

  async get(id: string): Promise<StoredAttachment | undefined> {
    const result = await this.#database.query(
      `SELECT id, conversation_id, message_id, object_key, sha256,
              byte_size, mime_type, original_name, state, created_at,
              tombstoned_at
       FROM attachments
       WHERE id = $1`,
      [requireNonEmpty(id, "attachment.id")],
    );
    if (result.rows.length === 0) return undefined;
    if (result.rows.length !== 1) {
      throw new StorageDecodeError(
        `attachment read expected at most one row, received ${result.rows.length}`,
      );
    }
    return decodeAttachment(result.rows[0]!);
  }

  async tombstoneAndEnqueueDeletion(input: {
    id: string;
    outboxJobId: string;
    tombstonedAt: string;
  }): Promise<boolean> {
    const id = requireNonEmpty(input.id, "attachment.id");
    const at = isoParameter(input.tombstonedAt, "attachment.tombstonedAt");
    const result = await this.#database.query(
      `WITH tombstoned AS (
         UPDATE attachments
         SET state = 'tombstoned', tombstoned_at = $2::timestamptz
         WHERE id = $1 AND state = 'available'
         RETURNING id
       ), queued AS (
         INSERT INTO outbox_jobs (
           id, topic, aggregate_type, aggregate_id, idempotency_key,
           payload, available_at, created_at
         )
         SELECT $3, 'attachment.delete.requested', 'attachment', id,
                'attachment:delete:' || id,
                jsonb_build_object('attachmentId', id),
                $2::timestamptz, $2::timestamptz
         FROM tombstoned
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id
       )
       SELECT id FROM tombstoned`,
      [id, at, requireNonEmpty(input.outboxJobId, "attachment.outboxJobId")],
    );
    return result.rows.length === 1;
  }

  async markDeleted(id: string): Promise<boolean> {
    const result = await this.#database.query(
      `UPDATE attachments
       SET state = 'deleted'
       WHERE id = $1 AND state = 'tombstoned'
       RETURNING id`,
      [requireNonEmpty(id, "attachment.id")],
    );
    return result.rows.length === 1;
  }
}

export type StoredAttachmentState = "staging" | "available" | "tombstoned" | "deleted";

export interface StoredAttachment {
  id: string;
  conversationId: string;
  messageId?: string;
  objectKey: string;
  sha256: string;
  byteSize: number;
  mimeType: string;
  originalName?: string;
  state: StoredAttachmentState;
  createdAt: string;
  tombstonedAt?: string;
}

function decodeAttachment(row: Record<string, unknown>): StoredAttachment {
  const optional = (value: unknown, path: string): string | undefined =>
    value === null || value === undefined ? undefined : requireNonEmpty(value, path);
  const state = requireNonEmpty(row["state"], "attachment.state");
  if (!["staging", "available", "tombstoned", "deleted"].includes(state)) {
    throw new StorageDecodeError(`attachment.state has unsupported value ${JSON.stringify(state)}`);
  }
  const sha256 = requireNonEmpty(row["sha256"], "attachment.sha256");
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new StorageDecodeError("attachment.sha256 must be lowercase SHA-256 hex");
  }
  const tombstonedAt = row["tombstoned_at"] === null || row["tombstoned_at"] === undefined
    ? undefined
    : requireTimestamp(row["tombstoned_at"], "attachment.tombstonedAt");
  if ((state === "tombstoned" || state === "deleted") !== (tombstonedAt !== undefined)) {
    throw new StorageDecodeError("attachment tombstone state is inconsistent");
  }
  return {
    id: requireNonEmpty(row["id"], "attachment.id"),
    conversationId: requireNonEmpty(row["conversation_id"], "attachment.conversationId"),
    ...(optional(row["message_id"], "attachment.messageId") === undefined
      ? {}
      : { messageId: optional(row["message_id"], "attachment.messageId") }),
    objectKey: requireNonEmpty(row["object_key"], "attachment.objectKey"),
    sha256,
    byteSize: requireWholeNumber(row["byte_size"], "attachment.byteSize"),
    mimeType: requireNonEmpty(row["mime_type"], "attachment.mimeType"),
    ...(optional(row["original_name"], "attachment.originalName") === undefined
      ? {}
      : { originalName: optional(row["original_name"], "attachment.originalName") }),
    state: state as StoredAttachmentState,
    createdAt: requireTimestamp(row["created_at"], "attachment.createdAt"),
    ...(tombstonedAt === undefined ? {} : { tombstonedAt }),
  };
}
