import type { JsonObject } from "../../json.ts";
import {
  isoParameter,
  jsonParameter,
  requireTimestamp,
  requireWholeNumber,
  requireNonEmpty,
  type SqlExecutor,
} from "../sql.ts";

export class OutboxRepository {
  readonly #database: SqlExecutor;

  constructor(database: SqlExecutor) {
    this.#database = database;
  }

  async enqueue(input: {
    id: string;
    topic: string;
    aggregateType: string;
    aggregateId: string;
    idempotencyKey: string;
    payload: JsonObject;
    availableAt: string;
    createdAt: string;
  }): Promise<boolean> {
    const result = await this.#database.query(
      `INSERT INTO outbox_jobs (
        id, topic, aggregate_type, aggregate_id, idempotency_key,
        payload, available_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz, $8::timestamptz)
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id`,
      [
        requireNonEmpty(input.id, "outbox.id"),
        requireNonEmpty(input.topic, "outbox.topic"),
        requireNonEmpty(input.aggregateType, "outbox.aggregateType"),
        requireNonEmpty(input.aggregateId, "outbox.aggregateId"),
        requireNonEmpty(input.idempotencyKey, "outbox.idempotencyKey"),
        jsonParameter(input.payload),
        isoParameter(input.availableAt, "outbox.availableAt"),
        isoParameter(input.createdAt, "outbox.createdAt"),
      ],
    );
    return result.rows.length === 1;
  }

  /** @deprecated Use ConsumerCheckpointRepository for consumer progress. */
  async advanceCheckpoint(input: {
    consumerName: string;
    journalSeq: number;
    eventId: string;
    updatedAt: string;
  }): Promise<boolean> {
    return new ConsumerCheckpointRepository(this.#database).advance(input);
  }
}

export interface ConsumerCheckpoint {
  consumerName: string;
  journalSeq: number;
  eventId?: string;
  updatedAt: string;
}

export class ConsumerCheckpointRepository {
  readonly #database: SqlExecutor;

  constructor(database: SqlExecutor) {
    this.#database = database;
  }

  async get(consumerName: string): Promise<ConsumerCheckpoint | undefined> {
    const name = requireNonEmpty(consumerName, "checkpoint.consumerName");
    const result = await this.#database.query(
      `SELECT consumer_name, journal_seq, event_id, updated_at
       FROM consumer_checkpoints
       WHERE consumer_name = $1`,
      [name],
    );
    if (result.rows.length === 0) return undefined;
    if (result.rows.length !== 1) {
      throw new TypeError(`checkpoint read expected at most one row, received ${result.rows.length}`);
    }
    const row = result.rows[0]!;
    const sequence = requireWholeNumber(row["journal_seq"], "checkpoint.journalSeq");
    const eventId = row["event_id"] === null || row["event_id"] === undefined
      ? undefined
      : requireNonEmpty(row["event_id"], "checkpoint.eventId");
    if ((sequence === 0) !== (eventId === undefined)) {
      throw new TypeError("checkpoint sequence zero must have no event identity");
    }
    return {
      consumerName: requireNonEmpty(row["consumer_name"], "checkpoint.consumerName"),
      journalSeq: sequence,
      ...(eventId === undefined ? {} : { eventId }),
      updatedAt: requireTimestamp(row["updated_at"], "checkpoint.updatedAt"),
    };
  }

  async advance(input: {
    consumerName: string;
    journalSeq: number;
    eventId: string;
    updatedAt: string;
  }): Promise<boolean> {
    if (!Number.isSafeInteger(input.journalSeq) || input.journalSeq <= 0) {
      throw new TypeError("checkpoint.journalSeq must be a positive safe integer");
    }
    const result = await this.#database.query(
      `INSERT INTO consumer_checkpoints (
        consumer_name, journal_seq, event_id, updated_at
      ) VALUES ($1, $2, $3, $4::timestamptz)
      ON CONFLICT (consumer_name) DO UPDATE
      SET journal_seq = EXCLUDED.journal_seq,
          event_id = EXCLUDED.event_id,
          updated_at = EXCLUDED.updated_at
      WHERE consumer_checkpoints.journal_seq < EXCLUDED.journal_seq
      RETURNING journal_seq`,
      [
        requireNonEmpty(input.consumerName, "checkpoint.consumerName"),
        input.journalSeq,
        requireNonEmpty(input.eventId, "checkpoint.eventId"),
        isoParameter(input.updatedAt, "checkpoint.updatedAt"),
      ],
    );
    return result.rows.length === 1;
  }
}

export const ERASURE_STORES = [
  "attachments",
  "embeddings",
  "search",
  "cache",
  "temporary_derivatives",
  "provider_payloads",
  "postgres",
] as const;

export type ErasureStore = typeof ERASURE_STORES[number];
export type ErasureSubjectType = "user" | "conversation" | "message";
export type ErasureJobStatus = "pending" | "processing" | "reconciling" | "completed" | "failed";
export type ErasureTargetStatus = "pending" | "processing" | "verified" | "failed";

export interface ErasureTarget {
  readonly store: ErasureStore;
  readonly status: ErasureTargetStatus;
  readonly attempts: number;
  readonly lastErrorCode?: string;
  readonly verifiedAt?: string;
}

export interface ErasureJob {
  readonly id: string;
  readonly subjectType: ErasureSubjectType;
  readonly subjectId: string;
  readonly requestedBy?: string;
  readonly reasonCode: string;
  readonly status: ErasureJobStatus;
  readonly requestedAt: string;
  readonly completedAt?: string;
  readonly lastErrorCode?: string;
  readonly targets: readonly ErasureTarget[];
}

export interface ErasureScope {
  readonly jobId: string;
  readonly subjectType: ErasureSubjectType;
  readonly subjectId: string;
  readonly conversationIds: readonly string[];
  readonly messageIds: readonly string[];
  readonly attachments: readonly {
    attachmentId: string;
    objectKey: string;
  }[];
  readonly knowledgeSourceIds: readonly string[];
}

export interface ErasureRequestResult {
  readonly created: boolean;
  readonly job: ErasureJob;
}

const ERASURE_JOB_COLUMNS = `
  id, subject_type, subject_id, requested_by, reason_code, status,
  requested_at, completed_at, last_error_code
`;

export class ErasureRepository {
  readonly #database: SqlExecutor;

  constructor(database: SqlExecutor) {
    this.#database = database;
  }

  async request(input: {
    id: string;
    subjectType: ErasureSubjectType;
    subjectId: string;
    requestedBy?: string;
    reasonCode: string;
    requestedAt: string;
    outboxJobId: string;
  }): Promise<ErasureRequestResult> {
    const requestedBy = input.requestedBy === undefined
      ? null
      : requireNonEmpty(input.requestedBy, "erasure.requestedBy");
    const result = await this.#database.query(
      `WITH RECURSIVE requested_subject AS (
        SELECT $2::text AS subject_type, $3::text AS subject_id
        WHERE EXISTS (
                SELECT 1 FROM erasure_jobs
                WHERE subject_type = $2 AND subject_id = $3
              )
           OR ($2 = 'user' AND EXISTS (SELECT 1 FROM users WHERE id = $3))
           OR ($2 = 'conversation' AND EXISTS (SELECT 1 FROM conversations WHERE id = $3))
           OR ($2 = 'message' AND EXISTS (SELECT 1 FROM messages WHERE id = $3))
      ), related_messages AS (
        SELECT message.id, message.conversation_id, message.supersedes_id
        FROM messages AS message
        JOIN requested_subject AS subject
          ON subject.subject_type = 'message' AND message.id = subject.subject_id
        UNION
        SELECT candidate.id, candidate.conversation_id, candidate.supersedes_id
        FROM messages AS candidate
        JOIN related_messages AS related
          ON candidate.supersedes_id = related.id OR candidate.id = related.supersedes_id
      ), scope_conversations AS (
        SELECT conversation.id AS conversation_id, true AS erase_all
        FROM conversations AS conversation
        JOIN requested_subject AS subject
          ON (subject.subject_type = 'conversation' AND conversation.id = subject.subject_id)
          OR (subject.subject_type = 'user' AND conversation.created_by = subject.subject_id)
        UNION
        SELECT related.conversation_id, false
        FROM related_messages AS related
      ), scope_messages AS (
        SELECT message.id AS message_id, message.conversation_id
        FROM messages AS message
        JOIN scope_conversations AS conversation
          ON conversation.erase_all AND conversation.conversation_id = message.conversation_id
        UNION
        SELECT related.id, related.conversation_id
        FROM related_messages AS related
      ), scope_attachments AS (
        SELECT attachment.id, attachment.object_key
        FROM attachments AS attachment
        WHERE EXISTS (
          SELECT 1 FROM scope_conversations AS conversation
          WHERE conversation.erase_all AND conversation.conversation_id = attachment.conversation_id
        ) OR EXISTS (
          SELECT 1 FROM scope_messages AS message
          WHERE message.message_id = attachment.message_id
        )
      ), scope_sources AS (
        SELECT source.id
        FROM knowledge_sources AS source
        WHERE EXISTS (
          SELECT 1 FROM scope_messages AS message
          WHERE message.message_id = source.message_id
        ) OR EXISTS (
          SELECT 1 FROM scope_attachments AS attachment
          WHERE attachment.id = source.attachment_id
        )
      ), inserted_job AS (
        INSERT INTO erasure_jobs (
          id, subject_type, subject_id, requested_by, reason_code, requested_at
        )
        SELECT $1, subject_type, subject_id, $4, $5, $6::timestamptz
        FROM requested_subject
        ON CONFLICT (subject_type, subject_id) DO NOTHING
        RETURNING ${ERASURE_JOB_COLUMNS}
      ), selected_job AS (
        SELECT inserted_job.*, true AS created
        FROM inserted_job
        UNION ALL
        SELECT existing.*, false AS created
        FROM erasure_jobs AS existing
        JOIN requested_subject AS subject
          ON existing.subject_type = subject.subject_type
         AND existing.subject_id = subject.subject_id
        WHERE NOT EXISTS (SELECT 1 FROM inserted_job)
      ), inserted_tombstone AS (
        INSERT INTO erasure_tombstones (
          erasure_job_id, subject_type, subject_id, tombstoned_at
        )
        SELECT id, subject_type, subject_id, requested_at
        FROM inserted_job
        RETURNING erasure_job_id
      ), inserted_conversations AS (
        INSERT INTO erasure_conversation_scope (
          erasure_job_id, conversation_id, erase_all
        )
        SELECT inserted_job.id, scope.conversation_id, scope.erase_all
        FROM inserted_job
        CROSS JOIN scope_conversations AS scope
        RETURNING conversation_id
      ), inserted_messages AS (
        INSERT INTO erasure_message_scope (
          erasure_job_id, message_id, conversation_id
        )
        SELECT inserted_job.id, scope.message_id, scope.conversation_id
        FROM inserted_job
        CROSS JOIN scope_messages AS scope
        RETURNING message_id
      ), inserted_attachments AS (
        INSERT INTO erasure_attachment_objects (
          erasure_job_id, attachment_id, object_key
        )
        SELECT inserted_job.id, scope.id, scope.object_key
        FROM inserted_job
        CROSS JOIN scope_attachments AS scope
        RETURNING attachment_id
      ), inserted_sources AS (
        INSERT INTO erasure_knowledge_sources (erasure_job_id, source_id)
        SELECT inserted_job.id, scope.id
        FROM inserted_job
        CROSS JOIN scope_sources AS scope
        RETURNING source_id
      ), tombstoned_attachments AS (
        UPDATE attachments AS attachment
        SET state = 'tombstoned', tombstoned_at = $6::timestamptz
        FROM inserted_job, scope_attachments AS scope
        WHERE attachment.id = scope.id
          AND attachment.state IN ('staging', 'available')
        RETURNING attachment.id
      ), tombstoned_sources AS (
        UPDATE knowledge_sources AS source
        SET tombstoned_at = $6::timestamptz
        FROM inserted_job, scope_sources AS scope
        WHERE source.id = scope.id AND source.tombstoned_at IS NULL
        RETURNING source.id
      ), tombstoned_chunks AS (
        UPDATE knowledge_chunks AS chunk
        SET tombstoned_at = $6::timestamptz
        FROM inserted_sources AS source
        WHERE chunk.source_id = source.source_id AND chunk.tombstoned_at IS NULL
        RETURNING chunk.id
      ), inserted_targets AS (
        INSERT INTO erasure_targets (erasure_job_id, store)
        SELECT inserted_job.id, store
        FROM inserted_job
        CROSS JOIN unnest($7::text[]) AS store
        RETURNING store
      ), inserted_outbox AS (
        INSERT INTO outbox_jobs (
          id, topic, aggregate_type, aggregate_id, idempotency_key,
          payload, available_at, created_at
        )
        SELECT $8, 'erasure.process.requested', 'erasure', id,
               'erasure:process:' || id,
               jsonb_build_object('erasureJobId', id),
               requested_at, requested_at
        FROM inserted_job
        RETURNING id
      )
      SELECT ${ERASURE_JOB_COLUMNS}, created
      FROM selected_job`,
      [
        requireNonEmpty(input.id, "erasure.id"),
        input.subjectType,
        requireNonEmpty(input.subjectId, "erasure.subjectId"),
        requestedBy,
        requireCode(input.reasonCode, "erasure.reasonCode"),
        isoParameter(input.requestedAt, "erasure.requestedAt"),
        [...ERASURE_STORES],
        requireNonEmpty(input.outboxJobId, "erasure.outboxJobId"),
      ],
    );
    if (result.rows.length === 0) {
      throw new TypeError("erasure subject does not exist");
    }
    const row = oneErasureRow(result.rows, "request erasure");
    const job = decodeErasureJob(row, []);
    return {
      created: row["created"] === true,
      job: { ...job, targets: await this.listTargets(job.id) },
    };
  }

  /** Compatibility shim for B1 callers; B6 callers must use request(). */
  async create(input: {
    id: string;
    subjectType: ErasureSubjectType;
    subjectId: string;
    requestedBy?: string;
    reasonCode: string;
    requestedAt: string;
  }): Promise<void> {
    await this.request({
      ...input,
      outboxJobId: `${requireNonEmpty(input.id, "erasure.id")}:process`,
    });
  }

  async get(id: string): Promise<ErasureJob | undefined> {
    const jobId = requireNonEmpty(id, "erasure.id");
    const result = await this.#database.query(
      `SELECT ${ERASURE_JOB_COLUMNS}
       FROM erasure_jobs
       WHERE id = $1`,
      [jobId],
    );
    if (result.rows.length === 0) return undefined;
    const job = decodeErasureJob(oneErasureRow(result.rows, "get erasure"), []);
    return { ...job, targets: await this.listTargets(job.id) };
  }

  async getScope(id: string): Promise<ErasureScope> {
    const job = await this.get(id);
    if (!job) throw new TypeError("erasure job does not exist");
    const [conversations, messages, attachments, sources] = await Promise.all([
      this.#database.query(
        `SELECT conversation_id
         FROM erasure_conversation_scope
         WHERE erasure_job_id = $1
         ORDER BY conversation_id`,
        [job.id],
      ),
      this.#database.query(
        `SELECT message_id
         FROM erasure_message_scope
         WHERE erasure_job_id = $1
         ORDER BY message_id`,
        [job.id],
      ),
      this.#database.query(
        `SELECT attachment_id, object_key
         FROM erasure_attachment_objects
         WHERE erasure_job_id = $1
         ORDER BY attachment_id`,
        [job.id],
      ),
      this.#database.query(
        `SELECT source_id
         FROM erasure_knowledge_sources
         WHERE erasure_job_id = $1
         ORDER BY source_id`,
        [job.id],
      ),
    ]);
    return {
      jobId: job.id,
      subjectType: job.subjectType,
      subjectId: job.subjectId,
      conversationIds: conversations.rows.map((row) =>
        requireNonEmpty(row["conversation_id"], "erasureScope.conversationId")),
      messageIds: messages.rows.map((row) =>
        requireNonEmpty(row["message_id"], "erasureScope.messageId")),
      attachments: attachments.rows.map((row) => ({
        attachmentId: requireNonEmpty(row["attachment_id"], "erasureScope.attachmentId"),
        objectKey: requireNonEmpty(row["object_key"], "erasureScope.objectKey"),
      })),
      knowledgeSourceIds: sources.rows.map((row) =>
        requireNonEmpty(row["source_id"], "erasureScope.sourceId")),
    };
  }

  async begin(id: string): Promise<void> {
    const result = await this.#database.query(
      `UPDATE erasure_jobs
       SET status = 'processing', completed_at = NULL, last_error_code = NULL
       WHERE id = $1 AND status IN ('pending', 'processing', 'reconciling', 'failed')
       RETURNING id`,
      [requireNonEmpty(id, "erasure.id")],
    );
    oneErasureRow(result.rows, "begin erasure");
  }

  async beginTarget(id: string, store: ErasureStore): Promise<void> {
    const result = await this.#database.query(
      `UPDATE erasure_targets
       SET status = 'processing', attempts = attempts + 1,
           last_error_code = NULL, verified_at = NULL
       WHERE erasure_job_id = $1 AND store = $2
       RETURNING store`,
      [requireNonEmpty(id, "erasure.id"), parseErasureStore(store)],
    );
    oneErasureRow(result.rows, "begin erasure target");
  }

  async verifyTarget(id: string, store: ErasureStore, verifiedAt: string): Promise<void> {
    const result = await this.#database.query(
      `UPDATE erasure_targets
       SET status = 'verified', last_error_code = NULL,
           verified_at = $3::timestamptz
       WHERE erasure_job_id = $1 AND store = $2
       RETURNING store`,
      [
        requireNonEmpty(id, "erasure.id"),
        parseErasureStore(store),
        isoParameter(verifiedAt, "erasure.verifiedAt"),
      ],
    );
    oneErasureRow(result.rows, "verify erasure target");
  }

  async failTarget(id: string, store: ErasureStore, errorCode: string): Promise<void> {
    await this.#database.query(
      `WITH failed_target AS (
        UPDATE erasure_targets
        SET status = 'failed', last_error_code = $3, verified_at = NULL
        WHERE erasure_job_id = $1 AND store = $2
        RETURNING erasure_job_id
      )
      UPDATE erasure_jobs
      SET status = 'failed', completed_at = NULL, last_error_code = $3
      WHERE id IN (SELECT erasure_job_id FROM failed_target)`,
      [
        requireNonEmpty(id, "erasure.id"),
        parseErasureStore(store),
        requireCode(errorCode, "erasure.errorCode"),
      ],
    );
  }

  async beginReconciliation(id: string): Promise<void> {
    const result = await this.#database.query(
      `UPDATE erasure_jobs
       SET status = 'reconciling', last_error_code = NULL
       WHERE id = $1 AND status = 'processing'
       RETURNING id`,
      [requireNonEmpty(id, "erasure.id")],
    );
    oneErasureRow(result.rows, "begin erasure reconciliation");
  }

  async complete(id: string, completedAt: string): Promise<void> {
    const result = await this.#database.query(
      `WITH completed AS (
        UPDATE erasure_jobs AS job
       SET status = 'completed', completed_at = $2::timestamptz,
           last_error_code = NULL
       WHERE job.id = $1
         AND job.status = 'reconciling'
         AND (SELECT count(*) FROM erasure_targets WHERE erasure_job_id = job.id) = $3
         AND NOT EXISTS (
           SELECT 1 FROM erasure_targets
           WHERE erasure_job_id = job.id AND status <> 'verified'
         )
        RETURNING id
      ), removed_object_scope AS (
        DELETE FROM erasure_attachment_objects
        WHERE erasure_job_id IN (SELECT id FROM completed)
      )
      SELECT id FROM completed`,
      [
        requireNonEmpty(id, "erasure.id"),
        isoParameter(completedAt, "erasure.completedAt"),
        ERASURE_STORES.length,
      ],
    );
    oneErasureRow(result.rows, "complete erasure");
  }

  async eraseSqlStore(id: string, store: "postgres" | "embeddings" | "search"): Promise<void> {
    const jobId = requireNonEmpty(id, "erasure.id");
    if (store === "embeddings") {
      await this.#database.query(
        `DELETE FROM chunk_embeddings AS embedding
         USING knowledge_chunks AS chunk, erasure_knowledge_sources AS source
         WHERE source.erasure_job_id = $1
           AND chunk.source_id = source.source_id
           AND embedding.chunk_id = chunk.id`,
        [jobId],
      );
      return;
    }
    if (store === "search") {
      await this.#database.query(
        `WITH deleted_chunks AS (
          DELETE FROM knowledge_chunks AS chunk
          USING erasure_knowledge_sources AS source
          WHERE source.erasure_job_id = $1 AND chunk.source_id = source.source_id
          RETURNING chunk.id
        )
        DELETE FROM knowledge_sources AS source
        USING erasure_knowledge_sources AS erased
        WHERE erased.erasure_job_id = $1 AND source.id = erased.source_id`,
        [jobId],
      );
      return;
    }
    await this.#database.query(
      `WITH scoped_conversations AS (
        SELECT conversation_id
        FROM erasure_conversation_scope
        WHERE erasure_job_id = $1 AND erase_all
      ), detached_commands AS (
        UPDATE runs AS run
        SET command_id = NULL
        FROM run_commands AS command
        WHERE run.command_id = command.id
          AND (
            command.conversation_id IN (SELECT conversation_id FROM scoped_conversations)
            OR command.message_id IN (
              SELECT message_id FROM erasure_message_scope WHERE erasure_job_id = $1
            )
          )
        RETURNING run.id
      ), deleted_commands AS (
        DELETE FROM run_commands AS command
        WHERE (SELECT count(*) FROM detached_commands) >= 0
          AND (
            command.conversation_id IN (SELECT conversation_id FROM scoped_conversations)
            OR command.message_id IN (
              SELECT message_id FROM erasure_message_scope WHERE erasure_job_id = $1
            )
          )
      ), deleted_approvals AS (
        DELETE FROM approvals
        WHERE (run_id, tool_call_id) IN (
          SELECT call.run_id, call.tool_call_id
          FROM tool_calls AS call
          JOIN scoped_conversations AS scope USING (conversation_id)
        )
      ), deleted_decisions AS (
        DELETE FROM tool_decisions
        WHERE (run_id, tool_call_id) IN (
          SELECT call.run_id, call.tool_call_id
          FROM tool_calls AS call
          JOIN scoped_conversations AS scope USING (conversation_id)
        )
      ), deleted_calls AS (
        DELETE FROM tool_calls AS call
        USING scoped_conversations AS scope
        WHERE call.conversation_id = scope.conversation_id
      ), deleted_journal AS (
        DELETE FROM event_journal AS journal
        WHERE journal.conversation_id IN (SELECT conversation_id FROM scoped_conversations)
           OR COALESCE(
                journal.event #>> '{payload,message,messageId}',
                journal.event #>> '{payload,messageId}'
              ) IN (
                SELECT message_id FROM erasure_message_scope WHERE erasure_job_id = $1
              )
      ), deleted_attachments AS (
        DELETE FROM attachments AS attachment
        USING erasure_attachment_objects AS erased
        WHERE erased.erasure_job_id = $1 AND attachment.id = erased.attachment_id
      ), deleted_messages AS (
        DELETE FROM messages AS message
        USING erasure_message_scope AS erased
        WHERE erased.erasure_job_id = $1 AND message.id = erased.message_id
      ), scrubbed_conversations AS (
        UPDATE conversations AS conversation
        SET title = NULL,
            archived_at = COALESCE(conversation.archived_at, transaction_timestamp())
        FROM erasure_tombstones AS erased
        WHERE erased.erasure_job_id = $1
          AND (
            (erased.subject_type = 'conversation' AND conversation.id = erased.subject_id)
            OR (erased.subject_type = 'user' AND conversation.created_by = erased.subject_id)
          )
        RETURNING conversation.id
      ), revoked_sessions AS (
        UPDATE server_sessions AS session
        SET token_sha256 = md5('erased-session-a:' || session.id)
                           || md5('erased-session-b:' || session.id),
            status = 'revoked',
            revoked_by = COALESCE(session.revoked_by, session.user_id),
            revoked_at = COALESCE(session.revoked_at, transaction_timestamp())
        FROM erasure_tombstones AS erased
        WHERE erased.erasure_job_id = $1
          AND erased.subject_type = 'user'
          AND session.user_id = erased.subject_id
      ), deleted_model_grants AS (
        DELETE FROM user_model_grants AS model_grant
        USING erasure_tombstones AS erased
        WHERE erased.erasure_job_id = $1
          AND erased.subject_type = 'user'
          AND model_grant.user_id = erased.subject_id
      ), deleted_roles AS (
        DELETE FROM user_roles AS role
        USING erasure_tombstones AS erased
        WHERE erased.erasure_job_id = $1
          AND erased.subject_type = 'user'
          AND role.user_id = erased.subject_id
      )
      UPDATE users AS account
      SET external_subject = 'erased:' || $1,
          display_name = '[erased]',
          status = 'disabled',
          disabled_at = COALESCE(account.disabled_at, transaction_timestamp())
      FROM erasure_tombstones AS erased
      WHERE erased.erasure_job_id = $1
        AND erased.subject_type = 'user'
        AND account.id = erased.subject_id`,
      [jobId],
    );
  }

  async findSqlResidue(
    id: string,
    store: "postgres" | "embeddings" | "search",
  ): Promise<readonly string[]> {
    const jobId = requireNonEmpty(id, "erasure.id");
    let sql: string;
    if (store === "embeddings") {
      sql = `SELECT 'embedding:' || embedding.chunk_id AS residue
             FROM chunk_embeddings AS embedding
             JOIN knowledge_chunks AS chunk ON chunk.id = embedding.chunk_id
             JOIN erasure_knowledge_sources AS source ON source.source_id = chunk.source_id
             WHERE source.erasure_job_id = $1
             ORDER BY residue LIMIT 100`;
    } else if (store === "search") {
      sql = `SELECT residue FROM (
               SELECT 'chunk:' || chunk.id AS residue
               FROM knowledge_chunks AS chunk
               JOIN erasure_knowledge_sources AS source ON source.source_id = chunk.source_id
               WHERE source.erasure_job_id = $1
               UNION ALL
               SELECT 'source:' || source.id
               FROM knowledge_sources AS source
               JOIN erasure_knowledge_sources AS erased ON erased.source_id = source.id
               WHERE erased.erasure_job_id = $1
             ) AS residue_rows
             ORDER BY residue LIMIT 100`;
    } else {
      sql = `WITH scoped_conversations AS (
               SELECT conversation_id
               FROM erasure_conversation_scope
               WHERE erasure_job_id = $1 AND erase_all
             )
             SELECT residue FROM (
               SELECT 'message:' || message.id AS residue
               FROM messages AS message
               JOIN erasure_message_scope AS erased ON erased.message_id = message.id
               WHERE erased.erasure_job_id = $1
               UNION ALL
               SELECT 'attachment:' || attachment.id
               FROM attachments AS attachment
               JOIN erasure_attachment_objects AS erased ON erased.attachment_id = attachment.id
               WHERE erased.erasure_job_id = $1
               UNION ALL
               SELECT 'journal:' || journal.event_id
               FROM event_journal AS journal
               WHERE journal.conversation_id IN (SELECT conversation_id FROM scoped_conversations)
                  OR COALESCE(
                       journal.event #>> '{payload,message,messageId}',
                       journal.event #>> '{payload,messageId}'
                     ) IN (
                       SELECT message_id FROM erasure_message_scope WHERE erasure_job_id = $1
                     )
               UNION ALL
               SELECT 'tool-call:' || call.run_id || ':' || call.tool_call_id
               FROM tool_calls AS call
               WHERE call.conversation_id IN (SELECT conversation_id FROM scoped_conversations)
               UNION ALL
               SELECT 'run-command:' || command.id
               FROM run_commands AS command
               WHERE command.conversation_id IN (SELECT conversation_id FROM scoped_conversations)
                  OR command.message_id IN (
                    SELECT message_id FROM erasure_message_scope WHERE erasure_job_id = $1
                  )
               UNION ALL
               SELECT 'conversation-title:' || conversation.id
               FROM conversations AS conversation
               JOIN erasure_tombstones AS erased ON erased.erasure_job_id = $1
               WHERE conversation.title IS NOT NULL
                 AND (
                   (erased.subject_type = 'conversation' AND conversation.id = erased.subject_id)
                   OR (erased.subject_type = 'user' AND conversation.created_by = erased.subject_id)
                 )
               UNION ALL
               SELECT 'user-profile:' || account.id
               FROM users AS account
               JOIN erasure_tombstones AS erased ON erased.erasure_job_id = $1
               WHERE erased.subject_type = 'user'
                 AND account.id = erased.subject_id
                 AND (account.external_subject <> 'erased:' || $1 OR account.display_name <> '[erased]')
               UNION ALL
               SELECT 'user-role:' || role.user_id || ':' || role.role
               FROM user_roles AS role
               JOIN erasure_tombstones AS erased ON erased.erasure_job_id = $1
               WHERE erased.subject_type = 'user' AND role.user_id = erased.subject_id
               UNION ALL
               SELECT 'user-model-grant:' || model_grant.user_id || ':' || model_grant.config_key
               FROM user_model_grants AS model_grant
               JOIN erasure_tombstones AS erased ON erased.erasure_job_id = $1
               WHERE erased.subject_type = 'user' AND model_grant.user_id = erased.subject_id
               UNION ALL
               SELECT 'active-session:' || session.id
               FROM server_sessions AS session
               JOIN erasure_tombstones AS erased ON erased.erasure_job_id = $1
               WHERE erased.subject_type = 'user' AND session.user_id = erased.subject_id
                 AND (
                   session.status <> 'revoked'
                   OR session.token_sha256 <> md5('erased-session-a:' || session.id)
                                             || md5('erased-session-b:' || session.id)
                 )
             ) AS residue_rows
             ORDER BY residue LIMIT 100`;
    }
    const result = await this.#database.query(sql, [jobId]);
    return result.rows.map((row) => requireNonEmpty(row["residue"], "erasure.residue"));
  }

  async markAttachmentDeleted(id: string): Promise<void> {
    await this.#database.query(
      `UPDATE attachments AS attachment
       SET state = 'deleted'
       FROM erasure_attachment_objects AS erased
       WHERE erased.erasure_job_id = $1
         AND attachment.id = erased.attachment_id
         AND attachment.state = 'tombstoned'`,
      [requireNonEmpty(id, "erasure.id")],
    );
  }

  private async listTargets(id: string): Promise<readonly ErasureTarget[]> {
    const result = await this.#database.query(
      `SELECT store, status, attempts, last_error_code, verified_at
       FROM erasure_targets
       WHERE erasure_job_id = $1
       ORDER BY array_position($2::text[], store)`,
      [requireNonEmpty(id, "erasure.id"), [...ERASURE_STORES]],
    );
    return result.rows.map(decodeErasureTarget);
  }
}

function oneErasureRow(
  rows: readonly Record<string, unknown>[],
  operation: string,
): Record<string, unknown> {
  if (rows.length !== 1) {
    throw new TypeError(`${operation} expected exactly one row, received ${rows.length}`);
  }
  return rows[0]!;
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === null || value === undefined ? undefined : requireNonEmpty(value, path);
}

function optionalCode(value: unknown, path: string): string | undefined {
  return value === null || value === undefined ? undefined : requireCode(value, path);
}

function parseErasureStore(value: unknown): ErasureStore {
  if (typeof value === "string" && (ERASURE_STORES as readonly string[]).includes(value)) {
    return value as ErasureStore;
  }
  throw new TypeError("erasure store is not supported");
}

function parseErasureSubjectType(value: unknown): ErasureSubjectType {
  if (value === "user" || value === "conversation" || value === "message") return value;
  throw new TypeError("erasure subject type is not supported");
}

function parseErasureJobStatus(value: unknown): ErasureJobStatus {
  if (["pending", "processing", "reconciling", "completed", "failed"].includes(String(value))) {
    return value as ErasureJobStatus;
  }
  throw new TypeError("erasure job status is not supported");
}

function parseErasureTargetStatus(value: unknown): ErasureTargetStatus {
  if (["pending", "processing", "verified", "failed"].includes(String(value))) {
    return value as ErasureTargetStatus;
  }
  throw new TypeError("erasure target status is not supported");
}

function decodeErasureTarget(row: Record<string, unknown>): ErasureTarget {
  const verifiedAt = row["verified_at"] === null || row["verified_at"] === undefined
    ? undefined
    : requireTimestamp(row["verified_at"], "erasureTarget.verifiedAt");
  const status = parseErasureTargetStatus(row["status"]);
  if ((status === "verified") !== (verifiedAt !== undefined)) {
    throw new TypeError("erasure target verification state is inconsistent");
  }
  return {
    store: parseErasureStore(row["store"]),
    status,
    attempts: requireWholeNumber(row["attempts"], "erasureTarget.attempts"),
    ...(optionalCode(row["last_error_code"], "erasureTarget.lastErrorCode") === undefined
      ? {}
      : { lastErrorCode: optionalCode(row["last_error_code"], "erasureTarget.lastErrorCode") }),
    ...(verifiedAt === undefined ? {} : { verifiedAt }),
  };
}

function decodeErasureJob(
  row: Record<string, unknown>,
  targets: readonly ErasureTarget[],
): ErasureJob {
  const completedAt = row["completed_at"] === null || row["completed_at"] === undefined
    ? undefined
    : requireTimestamp(row["completed_at"], "erasure.completedAt");
  const status = parseErasureJobStatus(row["status"]);
  if ((status === "completed") !== (completedAt !== undefined)) {
    throw new TypeError("erasure completion state is inconsistent");
  }
  const requestedBy = optionalString(row["requested_by"], "erasure.requestedBy");
  const lastErrorCode = optionalCode(row["last_error_code"], "erasure.lastErrorCode");
  return {
    id: requireNonEmpty(row["id"], "erasure.id"),
    subjectType: parseErasureSubjectType(row["subject_type"]),
    subjectId: requireNonEmpty(row["subject_id"], "erasure.subjectId"),
    ...(requestedBy === undefined ? {} : { requestedBy }),
    reasonCode: requireCode(row["reason_code"], "erasure.reasonCode"),
    status,
    requestedAt: requireTimestamp(row["requested_at"], "erasure.requestedAt"),
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(lastErrorCode === undefined ? {} : { lastErrorCode }),
    targets,
  };
}

function requireCode(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value)) {
    throw new TypeError(`${path} must be a bounded machine-readable code`);
  }
  return value;
}
