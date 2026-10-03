import type { ProductMessageEnvelope } from "../../messages/envelope.ts";
import { parseProductMessageEnvelope } from "../../messages/codec.ts";
import {
  isoParameter,
  jsonParameter,
  oneRow,
  parseJsonColumn,
  requireNonEmpty,
  requireTimestamp,
  requireWholeNumber,
  type SqlExecutor,
} from "../sql.ts";

export interface StoredMessage {
  readonly conversationId: string;
  readonly seq: number;
  readonly message: ProductMessageEnvelope;
  readonly supersedesId?: string;
  readonly storedAt: string;
}

export interface AppendMessageInput {
  readonly conversationId: string;
  readonly seq: number;
  readonly message: ProductMessageEnvelope;
  readonly supersedesId?: string;
}

const MESSAGE_COLUMNS = `
  conversation_id,
  seq,
  content,
  supersedes_id,
  created_at AS stored_at
`;

function decodeStoredMessage(row: Record<string, unknown>): StoredMessage {
  const parsed = parseProductMessageEnvelope(parseJsonColumn(row["content"], "messages.content"));
  return {
    conversationId: requireNonEmpty(row["conversation_id"], "messages.conversation_id"),
    seq: requireWholeNumber(row["seq"], "messages.seq"),
    message: parsed,
    ...(row["supersedes_id"] === null || row["supersedes_id"] === undefined
      ? {}
      : { supersedesId: requireNonEmpty(row["supersedes_id"], "messages.supersedes_id") }),
    storedAt: requireTimestamp(row["stored_at"], "messages.stored_at"),
  };
}

/** Append-only product history. All SQL is static and parameterized. */
export class MessageRepository {
  readonly #database: SqlExecutor;

  constructor(database: SqlExecutor) {
    this.#database = database;
  }

  async append(input: AppendMessageInput): Promise<StoredMessage> {
    const conversationId = requireNonEmpty(input.conversationId, "conversationId");
    if (!Number.isSafeInteger(input.seq) || input.seq < 0) {
      throw new TypeError("seq must be a non-negative safe integer");
    }
    const message = parseProductMessageEnvelope(input.message);
    const provider = message.provider;
    const result = await this.#database.query(
      `INSERT INTO messages (
        id, conversation_id, seq, schema_version, role, content,
        provider, model, config_key, usage, created_at, supersedes_id
      )
      SELECT
        $1, $2, $3, $4, $5, $6::jsonb,
        $7, $8, $9, $10::jsonb, $11::timestamptz, $12
      WHERE NOT EXISTS (
        SELECT 1
        FROM conversations AS conversation
        JOIN erasure_tombstones AS erased
          ON (erased.subject_type = 'conversation' AND erased.subject_id = conversation.id)
          OR (erased.subject_type = 'user' AND erased.subject_id = conversation.created_by)
        WHERE conversation.id = $2
      )
      AND NOT EXISTS (
        SELECT 1 FROM erasure_message_scope
        WHERE message_id = $1 OR message_id = $12
      )
      RETURNING ${MESSAGE_COLUMNS}`,
      [
        message.messageId,
        conversationId,
        input.seq,
        message.schemaVersion,
        message.role,
        jsonParameter(message),
        provider?.provider ?? null,
        provider?.model ?? null,
        provider?.configKey ?? null,
        message.usage ? jsonParameter(message.usage) : null,
        isoParameter(message.createdAt, "message.createdAt"),
        input.supersedesId ?? null,
      ],
    );
    return decodeStoredMessage(oneRow(result, "append message"));
  }

  async supersede(input: AppendMessageInput & { readonly supersedesId: string }): Promise<StoredMessage> {
    requireNonEmpty(input.supersedesId, "supersedesId");
    return this.append(input);
  }

  async getById(messageId: string): Promise<StoredMessage | null> {
    const result = await this.#database.query(
      `SELECT ${MESSAGE_COLUMNS}
       FROM current_messages
       WHERE id = $1`,
      [requireNonEmpty(messageId, "messageId")],
    );
    return result.rows.length === 0 ? null : decodeStoredMessage(oneRow(result, "get message"));
  }

  async listCurrent(conversationId: string, options: { afterSeq?: number; limit?: number } = {}): Promise<StoredMessage[]> {
    const afterSeq = options.afterSeq ?? -1;
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(afterSeq) || afterSeq < -1) {
      throw new TypeError("afterSeq must be a safe integer at least -1");
    }
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
      throw new TypeError("limit must be a positive safe integer no greater than 1000");
    }
    const result = await this.#database.query(
      `SELECT ${MESSAGE_COLUMNS}
       FROM current_messages
       WHERE conversation_id = $1 AND seq > $2
       ORDER BY seq ASC
       LIMIT $3`,
      [requireNonEmpty(conversationId, "conversationId"), afterSeq, limit],
    );
    return result.rows.map(decodeStoredMessage);
  }

  /** Load the complete current (unsuperseded) history in bounded SQL pages. */
  async listAllCurrent(conversationId: string, pageSize = 1_000): Promise<StoredMessage[]> {
    if (!Number.isSafeInteger(pageSize) || pageSize <= 0 || pageSize > 1_000) {
      throw new TypeError("pageSize must be a positive safe integer no greater than 1000");
    }
    const rows: StoredMessage[] = [];
    let afterSeq = -1;
    while (true) {
      const page = await this.listCurrent(conversationId, { afterSeq, limit: pageSize });
      rows.push(...page);
      if (page.length < pageSize) return rows;
      const next = page.at(-1)!.seq;
      if (next <= afterSeq) {
        throw new Error("current-history pagination did not advance");
      }
      afterSeq = next;
    }
  }
}
