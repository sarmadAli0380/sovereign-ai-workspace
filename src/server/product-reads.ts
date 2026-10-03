import { parseProductMessageEnvelope } from "../messages/codec.ts";
import type { ProductMessageEnvelope } from "../messages/envelope.ts";
import {
  parseJsonColumn,
  requireNonEmpty,
  requireTimestamp,
  requireWholeNumber,
  type SqlExecutor,
} from "../storage/sql.ts";
import type { JsonObject } from "../json.ts";

export interface ProductMessageRead {
  readonly sequence: number;
  readonly message: ProductMessageEnvelope;
}

export interface ProductAttachmentRead {
  readonly attachmentId: string;
  readonly conversationId: string;
  readonly messageId?: string;
  readonly byteSize: number;
  readonly mimeType: string;
  readonly originalName?: string;
  readonly createdAt: string;
}

export interface ProductRunRead {
  readonly runId: string;
  readonly conversationId: string;
  readonly configKey: string;
  readonly provider: string;
  readonly model: string;
  readonly status: "running" | "completed" | "failed" | "cancelled" | "needs_approval" | "persistence_unavailable";
  readonly terminalReason?: string;
  readonly terminalCode?: string;
  readonly usage?: JsonObject;
  readonly startedAt: string;
  readonly completedAt?: string;
}

export interface ProductAuditRead {
  readonly journalSequence: number;
  readonly eventId: string;
  readonly runId: string;
  readonly conversationId: string;
  readonly eventSequence: number;
  readonly eventType: string;
  readonly actorId?: string;
  readonly metadata: JsonObject;
  readonly occurredAt: string;
  readonly recordedAt: string;
}

export interface ProductReadStore {
  listMessages(conversationId: string, afterSequence: number, limit: number): Promise<readonly ProductMessageRead[]>;
  listAttachments(conversationId: string, afterId: string | undefined, limit: number): Promise<readonly ProductAttachmentRead[]>;
  getRun(runId: string): Promise<ProductRunRead | undefined>;
  listAudit(afterJournalSequence: number, limit: number): Promise<readonly ProductAuditRead[]>;
}

function optional(value: unknown, path: string): string | undefined {
  return value === null || value === undefined ? undefined : requireNonEmpty(value, path);
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 100) {
    throw new TypeError("reads.limit must be a positive safe integer no greater than 100");
  }
  return value;
}

function jsonObject(value: unknown, path: string): JsonObject {
  const parsed = parseJsonColumn(value, path);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`${path} must be an object`);
  }
  return parsed as JsonObject;
}

/** Ownership is checked by the HTTP boundary before these bounded queries. */
export class PostgresProductReadStore implements ProductReadStore {
  readonly #database: SqlExecutor;

  constructor(database: SqlExecutor) {
    this.#database = database;
  }

  async listMessages(conversationId: string, afterSequence: number, limit: number): Promise<ProductMessageRead[]> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < -1) {
      throw new TypeError("reads.afterSequence must be a safe integer at least -1");
    }
    const result = await this.#database.query(
      `SELECT seq, content
       FROM current_messages
       WHERE conversation_id = $1 AND seq > $2
       ORDER BY seq ASC
       LIMIT $3`,
      [requireNonEmpty(conversationId, "reads.conversationId"), afterSequence, boundedLimit(limit)],
    );
    return result.rows.map((row) => ({
      sequence: requireWholeNumber(row["seq"], "reads.message.sequence"),
      message: parseProductMessageEnvelope(parseJsonColumn(row["content"], "reads.message.content")),
    }));
  }

  async listAttachments(conversationId: string, afterId: string | undefined, limit: number): Promise<ProductAttachmentRead[]> {
    const result = await this.#database.query(
      `SELECT id, conversation_id, message_id, byte_size, mime_type,
              original_name, created_at
       FROM attachments
       WHERE conversation_id = $1 AND state = 'available'
         AND ($2::text IS NULL OR id > $2)
       ORDER BY id ASC
       LIMIT $3`,
      [
        requireNonEmpty(conversationId, "reads.conversationId"),
        afterId === undefined ? null : requireNonEmpty(afterId, "reads.afterId"),
        boundedLimit(limit),
      ],
    );
    return result.rows.map((row) => ({
      attachmentId: requireNonEmpty(row["id"], "reads.attachment.id"),
      conversationId: requireNonEmpty(row["conversation_id"], "reads.attachment.conversationId"),
      ...(optional(row["message_id"], "reads.attachment.messageId") === undefined
        ? {}
        : { messageId: optional(row["message_id"], "reads.attachment.messageId") }),
      byteSize: requireWholeNumber(row["byte_size"], "reads.attachment.byteSize"),
      mimeType: requireNonEmpty(row["mime_type"], "reads.attachment.mimeType"),
      ...(optional(row["original_name"], "reads.attachment.originalName") === undefined
        ? {}
        : { originalName: optional(row["original_name"], "reads.attachment.originalName") }),
      createdAt: requireTimestamp(row["created_at"], "reads.attachment.createdAt"),
    }));
  }

  async getRun(runId: string): Promise<ProductRunRead | undefined> {
    const result = await this.#database.query(
      `SELECT id, conversation_id, config_key, provider, model, status,
              terminal_reason, terminal_code, usage, started_at, completed_at
       FROM runs
       WHERE id = $1`,
      [requireNonEmpty(runId, "reads.runId")],
    );
    if (result.rows.length === 0) return undefined;
    if (result.rows.length !== 1) throw new Error("run read was ambiguous");
    const row = result.rows[0]!;
    const status = requireNonEmpty(row["status"], "reads.run.status");
    if (!new Set(["running", "completed", "failed", "cancelled", "needs_approval", "persistence_unavailable"]).has(status)) {
      throw new TypeError("reads.run.status is unsupported");
    }
    return {
      runId: requireNonEmpty(row["id"], "reads.run.id"),
      conversationId: requireNonEmpty(row["conversation_id"], "reads.run.conversationId"),
      configKey: requireNonEmpty(row["config_key"], "reads.run.configKey"),
      provider: requireNonEmpty(row["provider"], "reads.run.provider"),
      model: requireNonEmpty(row["model"], "reads.run.model"),
      status: status as ProductRunRead["status"],
      ...(optional(row["terminal_reason"], "reads.run.terminalReason") === undefined
        ? {}
        : { terminalReason: optional(row["terminal_reason"], "reads.run.terminalReason") }),
      ...(optional(row["terminal_code"], "reads.run.terminalCode") === undefined
        ? {}
        : { terminalCode: optional(row["terminal_code"], "reads.run.terminalCode") }),
      ...(row["usage"] === null || row["usage"] === undefined
        ? {}
        : { usage: jsonObject(row["usage"], "reads.run.usage") }),
      startedAt: requireTimestamp(row["started_at"], "reads.run.startedAt"),
      ...(row["completed_at"] === null || row["completed_at"] === undefined
        ? {}
        : { completedAt: requireTimestamp(row["completed_at"], "reads.run.completedAt") }),
    };
  }

  async listAudit(afterJournalSequence: number, limit: number): Promise<ProductAuditRead[]> {
    if (!Number.isSafeInteger(afterJournalSequence) || afterJournalSequence < 0) {
      throw new TypeError("reads.afterJournalSequence must be a non-negative safe integer");
    }
    const result = await this.#database.query(
      `SELECT journal.journal_seq, audit.event_id, audit.run_id,
              audit.conversation_id, audit.event_sequence, audit.event_type,
              audit.actor_id, audit.metadata, audit.occurred_at, audit.recorded_at
       FROM audit_events AS audit
       JOIN event_journal AS journal ON journal.event_id = audit.event_id
       WHERE journal.journal_seq > $1
       ORDER BY journal.journal_seq ASC
       LIMIT $2`,
      [afterJournalSequence, boundedLimit(limit)],
    );
    return result.rows.map((row) => ({
      journalSequence: requireWholeNumber(row["journal_seq"], "reads.audit.journalSequence"),
      eventId: requireNonEmpty(row["event_id"], "reads.audit.eventId"),
      runId: requireNonEmpty(row["run_id"], "reads.audit.runId"),
      conversationId: requireNonEmpty(row["conversation_id"], "reads.audit.conversationId"),
      eventSequence: requireWholeNumber(row["event_sequence"], "reads.audit.eventSequence"),
      eventType: requireNonEmpty(row["event_type"], "reads.audit.eventType"),
      ...(optional(row["actor_id"], "reads.audit.actorId") === undefined
        ? {}
        : { actorId: optional(row["actor_id"], "reads.audit.actorId") }),
      metadata: jsonObject(row["metadata"], "reads.audit.metadata"),
      occurredAt: requireTimestamp(row["occurred_at"], "reads.audit.occurredAt"),
      recordedAt: requireTimestamp(row["recorded_at"], "reads.audit.recordedAt"),
    }));
  }
}
