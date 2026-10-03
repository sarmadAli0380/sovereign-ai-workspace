import { projectRunEvent } from "../../event-projections.ts";
import { RunEventTransportError } from "../../event-transport.ts";
import { parseRunEvent, type RunEvent } from "../../events.ts";
import {
  jsonParameter,
  requireNonEmpty,
  requireTimestamp,
  requireWholeNumber,
  type SqlExecutor,
} from "../sql.ts";

export interface JournalAppendResult {
  inserted: boolean;
  journalSeq?: number;
}

export interface StoredJournalEvent {
  journalSeq: number;
  event: RunEvent;
}

/**
 * Writes the canonical persistence event and its metadata-only audit projection
 * in one SQL statement. Ephemeral message deltas are intentionally not stored.
 */
export class EventJournalRepository {
  readonly #database: SqlExecutor;

  constructor(database: SqlExecutor) {
    this.#database = database;
  }

  async append(value: RunEvent): Promise<boolean> {
    return (await this.appendWithOutbox(value)).inserted;
  }

  /**
   * Commits the canonical event, audit projection, and durable delivery job in
   * one PostgreSQL statement. A duplicate event is an acknowledged no-op.
   */
  async appendWithOutbox(value: RunEvent): Promise<JournalAppendResult> {
    const event = parseRunEvent(value);
    if (event.type === "message.delta") return { inserted: false };

    const audit = projectRunEvent(event, "audit");
    if (audit === null) return { inserted: false };

    const result = await this.#database.query(
      `WITH inserted_event AS (
        INSERT INTO event_journal (
          event_id, schema_version, run_id, conversation_id, event_sequence,
          turn_number, event_type, sensitivity, event, occurred_at
        )
        SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::timestamptz
        WHERE NOT EXISTS (
          SELECT 1
          FROM conversations AS conversation
          JOIN erasure_tombstones AS erased
            ON (erased.subject_type = 'conversation' AND erased.subject_id = conversation.id)
            OR (erased.subject_type = 'user' AND erased.subject_id = conversation.created_by)
          WHERE conversation.id = $4
        )
        AND NOT EXISTS (
          SELECT 1 FROM erasure_message_scope AS erased
          WHERE erased.message_id = COALESCE(
            $9::jsonb #>> '{payload,message,messageId}',
            $9::jsonb #>> '{payload,messageId}'
          )
        )
        ON CONFLICT (event_id) DO NOTHING
        RETURNING event_id, journal_seq
      ), inserted_audit AS (
        INSERT INTO audit_events (
          event_id, run_id, conversation_id, event_sequence, event_type,
          actor_id, metadata, occurred_at
        )
        SELECT $1, $3, $4, $5, $7, NULL, $11::jsonb, $10::timestamptz
        FROM inserted_event
        RETURNING event_id
      ), inserted_outbox AS (
        INSERT INTO outbox_jobs (
          id, topic, aggregate_type, aggregate_id, idempotency_key,
          payload, available_at, created_at
        )
        SELECT
          $12, 'journal.event.appended', 'run', $3, $13,
          jsonb_build_object('eventId', event_id, 'journalSeq', journal_seq),
          $10::timestamptz, $10::timestamptz
        FROM inserted_event
        RETURNING id
      )
      SELECT event_id, journal_seq
      FROM inserted_event
      WHERE EXISTS (SELECT 1 FROM inserted_audit)
        AND EXISTS (SELECT 1 FROM inserted_outbox)`,
      [
        event.eventId,
        event.schemaVersion,
        event.runId,
        event.conversationId,
        event.sequence,
        event.turn,
        event.type,
        event.sensitivity,
        jsonParameter(event),
        event.occurredAt,
        jsonParameter(audit),
        `journal:${event.eventId}`,
        `journal:${event.eventId}`,
      ],
    );
    if (result.rows.length === 0) return { inserted: false };
    if (result.rows.length !== 1) {
      throw new TypeError(`append journal expected at most one row, received ${result.rows.length}`);
    }
    return {
      inserted: true,
      journalSeq: requireWholeNumber(result.rows[0]!["journal_seq"], "journal.journalSeq"),
    };
  }

  async listAfter(journalSeq: number, limit = 100): Promise<StoredJournalEvent[]> {
    if (!Number.isSafeInteger(journalSeq) || journalSeq < 0) {
      throw new TypeError("journal.journalSeq must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new TypeError("journal.limit must be a positive safe integer");
    }
    const result = await this.#database.query(
      `SELECT journal_seq, event_id, event
       FROM retrievable_event_journal
       WHERE journal_seq > $1
       ORDER BY journal_seq ASC
       LIMIT $2`,
      [journalSeq, limit],
    );
    let previous = journalSeq;
    return result.rows.map((row, index) => {
      const sequence = requireWholeNumber(row["journal_seq"], `journal.rows[${index}].journalSeq`);
      if (sequence <= previous) {
        throw new TypeError("journal rows must be strictly ordered by journal sequence");
      }
      previous = sequence;
      const eventId = requireNonEmpty(row["event_id"], `journal.rows[${index}].eventId`);
      const event = parseRunEvent(row["event"]);
      if (event.eventId !== eventId) {
        throw new TypeError(`journal row ${sequence} event identity does not match its envelope`);
      }
      requireTimestamp(event.occurredAt, `journal.rows[${index}].event.occurredAt`);
      return { journalSeq: sequence, event };
    });
  }

  /** Bounded Phase C replay for one already-authorized run. */
  async listRunEvents(runId: string, afterEventId?: string, limit = 10_000): Promise<RunEvent[]> {
    const ownedRunId = requireNonEmpty(runId, "journal.runId");
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) {
      throw new TypeError("journal.limit must be a positive safe integer no greater than 10000");
    }
    let afterSequence = -1;
    if (afterEventId !== undefined) {
      const checkpoint = await this.#database.query(
        `SELECT event_sequence
         FROM retrievable_event_journal
         WHERE run_id = $1 AND event_id = $2`,
        [ownedRunId, requireNonEmpty(afterEventId, "journal.afterEventId")],
      );
      if (checkpoint.rows.length !== 1) {
        throw new RunEventTransportError("checkpoint eventId is not available for this run");
      }
      afterSequence = requireWholeNumber(checkpoint.rows[0]!["event_sequence"], "journal.checkpointSequence");
    }
    const result = await this.#database.query(
      `SELECT event_id, event_sequence, event
       FROM retrievable_event_journal
       WHERE run_id = $1 AND event_sequence > $2
       ORDER BY event_sequence ASC
       LIMIT $3`,
      [ownedRunId, afterSequence, limit],
    );
    let previous = afterSequence;
    return result.rows.map((row, index) => {
      const sequence = requireWholeNumber(row["event_sequence"], `journal.rows[${index}].eventSequence`);
      const eventId = requireNonEmpty(row["event_id"], `journal.rows[${index}].eventId`);
      const event = parseRunEvent(row["event"]);
      if (event.runId !== ownedRunId || event.eventId !== eventId || event.sequence !== sequence) {
        throw new TypeError("run event replay identity does not match its stored envelope");
      }
      if (sequence <= previous) throw new TypeError("run event replay is not strictly ordered");
      previous = sequence;
      return event;
    });
  }
}
