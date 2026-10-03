import type { ProductMessageEnvelope } from "../messages/envelope.ts";
import { parseProductMessageEnvelope } from "../messages/codec.ts";
import {
  isoParameter,
  jsonParameter,
  requireNonEmpty,
  requireTimestamp,
  type SqlExecutor,
} from "../storage/sql.ts";

export interface AcceptRunCommandInput {
  readonly commandId: string;
  readonly runId: string;
  readonly conversationId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly isAdmin: boolean;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly message: ProductMessageEnvelope;
  readonly configKey: string;
  readonly maxTurns: number;
  readonly causationId: string;
  readonly provider: string;
  readonly model: string;
  readonly acceptedAt: string;
}

export interface AcceptedRunOwnership {
  readonly created: boolean;
  readonly commandId: string;
  readonly runId: string;
  readonly conversationId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly messageId: string;
  readonly configKey: string;
  readonly maxTurns: number;
  readonly causationId: string;
  readonly acceptedAt: string;
}

export class RunCommandConflictError extends Error {
  readonly code = "run.idempotency-conflict" as const;

  constructor() {
    super("the idempotency key is already bound to a different run command");
    this.name = "RunCommandConflictError";
  }
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function wholeTurns(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 32) {
    throw new TypeError("maxTurns must be a positive safe integer no greater than 32");
  }
  return value;
}

function decode(row: Record<string, unknown>, created: boolean): AcceptedRunOwnership {
  const maxTurns = Number(row["max_turns"]);
  return {
    created,
    commandId: requireNonEmpty(row["id"], "runCommand.id"),
    runId: requireNonEmpty(row["run_id"], "runCommand.runId"),
    conversationId: requireNonEmpty(row["conversation_id"], "runCommand.conversationId"),
    userId: requireNonEmpty(row["user_id"], "runCommand.userId"),
    sessionId: requireNonEmpty(row["session_id"], "runCommand.sessionId"),
    idempotencyKey: requireNonEmpty(row["idempotency_key"], "runCommand.idempotencyKey"),
    requestSha256: requireNonEmpty(row["request_sha256"], "runCommand.requestSha256"),
    messageId: requireNonEmpty(row["message_id"], "runCommand.messageId"),
    configKey: requireNonEmpty(row["config_key"], "runCommand.configKey"),
    maxTurns: wholeTurns(maxTurns),
    causationId: requireNonEmpty(row["causation_id"], "runCommand.causationId"),
    acceptedAt: requireTimestamp(row["accepted_at"], "runCommand.acceptedAt"),
  };
}

const RETURNING_COLUMNS = `
  id, run_id, conversation_id, user_id, session_id, idempotency_key,
  request_sha256, message_id, config_key, max_turns, causation_id, accepted_at
`;

/**
 * Atomically owns a caller idempotency key, appends its user message, and
 * creates the run resource. The conversation row is the per-conversation
 * sequence lock, so direct user appends and projected assistant messages can
 * share one monotonic message sequence without races.
 */
export class PostgresRunCommandStore {
  readonly #database: SqlExecutor;

  constructor(database: SqlExecutor) {
    this.#database = database;
  }

  async find(userId: string, idempotencyKey: string): Promise<AcceptedRunOwnership | undefined> {
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new TypeError("idempotencyKey must be 16-128 bounded identifier characters");
    }
    const result = await this.#database.query(
      `SELECT ${RETURNING_COLUMNS}
       FROM run_commands
       WHERE user_id = $1 AND idempotency_key = $2`,
      [requireNonEmpty(userId, "runCommand.userId"), idempotencyKey],
    );
    if (result.rows.length === 0) return undefined;
    if (result.rows.length !== 1) throw new Error("idempotency lookup returned ambiguous ownership");
    return decode(result.rows[0]!, false);
  }

  async accept(input: AcceptRunCommandInput): Promise<AcceptedRunOwnership> {
    if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      throw new TypeError("idempotencyKey must be 16-128 bounded identifier characters");
    }
    if (!SHA256.test(input.requestSha256)) throw new TypeError("requestSha256 must be lowercase SHA-256 hex");
    const message = parseProductMessageEnvelope(input.message);
    if (message.role !== "user") throw new TypeError("run command message must have role user");
    if (message.messageId.length === 0) throw new TypeError("run command messageId must be non-empty");
    const maxTurns = wholeTurns(input.maxTurns);
    const result = await this.#database.query(
      `WITH locked_conversation AS MATERIALIZED (
         SELECT conversation.id
         FROM conversations AS conversation
         JOIN users AS owner ON owner.id = conversation.created_by
         JOIN users AS initiator ON initiator.id = $3
         WHERE conversation.id = $2
           AND conversation.archived_at IS NULL
           AND owner.status = 'active'
           AND initiator.status = 'active'
           AND ($16::boolean OR conversation.created_by = $3)
         FOR UPDATE OF conversation
       ), existing AS MATERIALIZED (
         SELECT ${RETURNING_COLUMNS}
         FROM run_commands
         WHERE user_id = $3 AND idempotency_key = $5
       ), inserted_command AS (
         INSERT INTO run_commands (
           id, run_id, conversation_id, user_id, session_id, idempotency_key,
           request_sha256, message_id, config_key, max_turns, causation_id, accepted_at
         )
         SELECT $1, $4, locked.id, $3, $6, $5, $7, $8, $9, $10, $11, $12::timestamptz
         FROM locked_conversation AS locked
         WHERE NOT EXISTS (SELECT 1 FROM existing)
         ON CONFLICT (user_id, idempotency_key) DO NOTHING
         RETURNING ${RETURNING_COLUMNS}
       ), inserted_message AS (
         INSERT INTO messages (
           id, conversation_id, seq, schema_version, role, content,
           provider, model, config_key, usage, created_at
         )
         SELECT
           $8, command.conversation_id,
           COALESCE((SELECT MAX(message.seq) + 1 FROM messages AS message
                     WHERE message.conversation_id = command.conversation_id), 0),
           $13, 'user', $14::jsonb, NULL, NULL, NULL, NULL, $12::timestamptz
         FROM inserted_command AS command
         WHERE NOT EXISTS (
           SELECT 1
           FROM erasure_tombstones AS erased
           JOIN conversations AS conversation ON conversation.id = command.conversation_id
           WHERE (erased.subject_type = 'conversation' AND erased.subject_id = conversation.id)
              OR (erased.subject_type = 'user' AND erased.subject_id = conversation.created_by)
         )
         RETURNING id
       ), inserted_run AS (
         INSERT INTO runs (
           id, conversation_id, initiated_by, causation_id, config_key,
           provider, model, status, started_at, command_id
         )
         SELECT $4, command.conversation_id, $3, $11, $9,
                $15, $17, 'running', $12::timestamptz, command.id
         FROM inserted_command AS command
         WHERE EXISTS (SELECT 1 FROM inserted_message)
         RETURNING id
       )
       SELECT ${RETURNING_COLUMNS}, true AS created
       FROM inserted_command
       WHERE EXISTS (SELECT 1 FROM inserted_message)
         AND EXISTS (SELECT 1 FROM inserted_run)
       UNION ALL
       SELECT ${RETURNING_COLUMNS}, false AS created
       FROM existing
       LIMIT 1`,
      [
        requireNonEmpty(input.commandId, "runCommand.commandId"),
        requireNonEmpty(input.conversationId, "runCommand.conversationId"),
        requireNonEmpty(input.userId, "runCommand.userId"),
        requireNonEmpty(input.runId, "runCommand.runId"),
        input.idempotencyKey,
        requireNonEmpty(input.sessionId, "runCommand.sessionId"),
        input.requestSha256,
        message.messageId,
        requireNonEmpty(input.configKey, "runCommand.configKey"),
        maxTurns,
        requireNonEmpty(input.causationId, "runCommand.causationId"),
        isoParameter(input.acceptedAt, "runCommand.acceptedAt"),
        message.schemaVersion,
        jsonParameter(message),
        requireNonEmpty(input.provider, "runCommand.provider"),
        input.isAdmin,
        requireNonEmpty(input.model, "runCommand.model"),
      ],
    );

    let row = result.rows[0];
    let created = row?.["created"] === true;
    if (!row) {
      // A concurrent first use of the same key can win after this statement's
      // snapshot was taken. Read once more after ON CONFLICT has waited.
      const accepted = await this.find(input.userId, input.idempotencyKey);
      if (accepted) {
        if (accepted.requestSha256 !== input.requestSha256) throw new RunCommandConflictError();
        return accepted;
      }
      created = false;
    }
    if (!row) throw new Error("run command ownership was not durably accepted");
    const accepted = decode(row, created);
    if (accepted.requestSha256 !== input.requestSha256) throw new RunCommandConflictError();
    return accepted;
  }
}
