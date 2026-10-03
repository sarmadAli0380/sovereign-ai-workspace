import { parseRunEvent } from "../events.ts";
import { parseProductMessageEnvelope } from "../messages/codec.ts";
import { approvalArgumentsHash } from "../approval.ts";
import type { JournalDelivery } from "./durable-journal.ts";
import { jsonParameter, requireNonEmpty, type SqlExecutor } from "./sql.ts";

function turnId(runId: string, turn: number): string {
  return `${runId}:turn:${turn}`;
}

function terminalState(event: ReturnType<typeof parseRunEvent>): {
  status: "completed" | "failed" | "cancelled" | "needs_approval";
  reason: string;
  code: string | null;
  usage: string | null;
} | undefined {
  if (event.type === "run.completed") {
    return {
      status: event.payload.reason === "needsApproval" ? "needs_approval" : "completed",
      reason: event.payload.reason,
      code: null,
      usage: event.payload.usage ? jsonParameter(event.payload.usage) : null,
    };
  }
  if (event.type === "run.failed") {
    return { status: "failed", reason: "error", code: event.payload.code, usage: null };
  }
  if (event.type === "run.cancelled") {
    return { status: "cancelled", reason: "cancelled", code: event.payload.code, usage: null };
  }
  return undefined;
}

/**
 * Idempotent journal consumer for the run/turn/message read model.
 *
 * The canonical journal is already durable before this projection runs. Every
 * statement therefore accepts an at-least-once delivery only when the stored
 * value is identical; a conflicting replay fails closed instead of rewriting
 * history. The conversation row serializes message-sequence allocation across
 * direct user commands and projected assistant/tool messages.
 */
export class RunHistoryProjector {
  readonly #database: SqlExecutor;

  constructor(database: SqlExecutor) {
    this.#database = database;
  }

  async apply(delivery: JournalDelivery): Promise<void> {
    if (!Number.isSafeInteger(delivery.journalSeq) || delivery.journalSeq <= 0) {
      throw new TypeError("projection.journalSeq must be a positive safe integer");
    }
    const event = parseRunEvent(delivery.event);
    if (delivery.deliveryId !== event.eventId) {
      throw new TypeError("projection delivery identity does not match the event");
    }

    if (event.type === "run.started") {
      await this.#requireApplied(
         `WITH inserted AS (
           INSERT INTO runs (
             id, conversation_id, causation_id, correlation_id, config_key,
             provider, model, status, started_at, runtime_started_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'running', $8::timestamptz, $8::timestamptz)
           ON CONFLICT (id) DO NOTHING
           RETURNING id
         ), bound_command AS (
           UPDATE runs
           SET runtime_started_at = $8::timestamptz
           WHERE id = $1 AND command_id IS NOT NULL AND runtime_started_at IS NULL
             AND conversation_id = $2 AND causation_id = $3
             AND correlation_id IS NOT DISTINCT FROM $4 AND config_key = $5
             AND provider = $6 AND model = $7 AND started_at <= $8::timestamptz
           RETURNING id
         )
         SELECT id FROM inserted
         UNION ALL
         SELECT id FROM bound_command
         UNION ALL
         SELECT id FROM runs
         WHERE id = $1 AND conversation_id = $2 AND causation_id = $3
           AND correlation_id IS NOT DISTINCT FROM $4 AND config_key = $5
           AND provider = $6 AND model = $7 AND runtime_started_at = $8::timestamptz
         LIMIT 1`,
        [
          event.runId,
          event.conversationId,
          event.causationId,
          event.correlationId ?? null,
          event.payload.configKey,
          event.payload.provider,
          event.payload.model,
          event.occurredAt,
        ],
        "project run.started",
      );
      return;
    }

    if (event.type === "turn.started") {
      const id = turnId(event.runId, event.turn);
      await this.#requireApplied(
        `WITH inserted AS (
           INSERT INTO turns (
             id, run_id, conversation_id, turn_number, input_message_id, started_at
           ) VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
           ON CONFLICT (run_id, turn_number) DO NOTHING
           RETURNING id
         )
         SELECT id FROM inserted
         UNION ALL
         SELECT id FROM turns
         WHERE id = $1 AND run_id = $2 AND conversation_id = $3
           AND turn_number = $4 AND input_message_id IS NOT DISTINCT FROM $5
           AND started_at = $6::timestamptz
         LIMIT 1`,
        [
          id,
          event.runId,
          event.conversationId,
          event.turn,
          event.payload.inputMessageId ?? null,
          event.occurredAt,
        ],
        "project turn.started",
      );
      return;
    }

    if (event.type === "message.completed") {
      const message = parseProductMessageEnvelope(event.payload.message);
      const provider = message.provider;
      await this.#requireApplied(
        `WITH locked_conversation AS MATERIALIZED (
           SELECT id FROM conversations WHERE id = $2 FOR UPDATE
         ), inserted AS (
           INSERT INTO messages (
             id, conversation_id, seq, schema_version, role, content,
             provider, model, config_key, usage, created_at
           )
           SELECT $1, locked.id,
             COALESCE((SELECT MAX(existing_message.seq) + 1
                       FROM messages AS existing_message
                       WHERE existing_message.conversation_id = locked.id), 0),
             $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb, $10::timestamptz
           FROM locked_conversation AS locked
           WHERE NOT EXISTS (
             SELECT 1 FROM erasure_tombstones AS erased
             JOIN conversations AS conversation ON conversation.id = locked.id
             WHERE (erased.subject_type = 'conversation' AND erased.subject_id = conversation.id)
                OR (erased.subject_type = 'user' AND erased.subject_id = conversation.created_by)
           )
           AND NOT EXISTS (
             SELECT 1 FROM erasure_message_scope AS erased WHERE erased.message_id = $1
           )
           ON CONFLICT (id) DO NOTHING
           RETURNING id
         )
         SELECT id FROM inserted
         UNION ALL
         SELECT id FROM messages
         WHERE id = $1 AND conversation_id = $2
           AND schema_version = $3 AND role = $4 AND content = $5::jsonb
         LIMIT 1`,
        [
          message.messageId,
          event.conversationId,
          message.schemaVersion,
          message.role,
          jsonParameter(message),
          provider?.provider ?? null,
          provider?.model ?? null,
          provider?.configKey ?? null,
          message.usage ? jsonParameter(message.usage) : null,
          message.createdAt,
        ],
        "project message.completed",
      );
      return;
    }

    if (event.type === "tool.requested") {
      const argumentsJson = jsonParameter(event.payload.arguments);
      await this.#requireApplied(
        `WITH inserted AS (
           INSERT INTO tool_calls (
             run_id, tool_call_id, turn_id, conversation_id, tool_name,
             arguments, arguments_hash, requested_at
           ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::timestamptz)
           ON CONFLICT (run_id, tool_call_id) DO NOTHING
           RETURNING tool_call_id AS id
         )
         SELECT id FROM inserted
         UNION ALL
         SELECT tool_call_id AS id FROM tool_calls
         WHERE run_id = $1 AND tool_call_id = $2 AND turn_id = $3
           AND conversation_id = $4 AND tool_name = $5
           AND arguments = $6::jsonb AND arguments_hash = $7
           AND requested_at = $8::timestamptz
         LIMIT 1`,
        [
          event.runId,
          event.payload.toolCallId,
          turnId(event.runId, event.turn),
          event.conversationId,
          event.payload.toolName,
          argumentsJson,
          approvalArgumentsHash(event.payload.arguments),
          event.occurredAt,
        ],
        "project tool.requested",
      );
      return;
    }

    if (event.type === "tool.decision") {
      await this.#requireApplied(
        `WITH inserted AS (
           INSERT INTO tool_decisions (
             id, run_id, tool_call_id, capability, capabilities,
             decision, reason_code, decided_at
           ) VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8::timestamptz)
           ON CONFLICT (run_id, tool_call_id) DO NOTHING
           RETURNING id
         )
         SELECT id FROM inserted
         UNION ALL
         SELECT id FROM tool_decisions
         WHERE run_id = $2 AND tool_call_id = $3 AND capability = $4
           AND capabilities = $5::text[] AND decision = $6
           AND reason_code = $7 AND decided_at = $8::timestamptz
         LIMIT 1`,
        [
          event.eventId,
          event.runId,
          event.payload.toolCallId,
          event.payload.capability,
          [...event.payload.capabilities],
          event.payload.decision,
          event.payload.reasonCode,
          event.occurredAt,
        ],
        "project tool.decision",
      );
      return;
    }

    if (event.type === "approval.requested") {
      await this.#requireApplied(
        `WITH inserted AS (
           INSERT INTO approvals (
             id, run_id, tool_call_id, arguments_hash, capability, capabilities,
             reason_code, status, requested_at, expires_at
           )
           SELECT $1, $2, $3, $4, $5, decision.capabilities,
                  decision.reason_code, 'pending', $6::timestamptz, $7::timestamptz
           FROM tool_decisions AS decision
           WHERE decision.run_id = $2 AND decision.tool_call_id = $3
             AND decision.decision = 'requireApproval'
             AND decision.capability = $5
           ON CONFLICT (id) DO NOTHING
           RETURNING id
         )
         SELECT id FROM inserted
         UNION ALL
         SELECT id FROM approvals
         WHERE id = $1 AND run_id = $2 AND tool_call_id = $3
           AND arguments_hash = $4 AND capability = $5
           AND requested_at = $6::timestamptz AND expires_at = $7::timestamptz
         LIMIT 1`,
        [
          event.payload.approvalId,
          event.runId,
          event.payload.toolCallId,
          event.payload.argumentsHash,
          event.payload.capability,
          event.occurredAt,
          event.payload.expiresAt,
        ],
        "project approval.requested",
      );
      return;
    }

    if (event.type === "turn.completed") {
      await this.#requireApplied(
        `UPDATE turns
         SET stop_reason = $2, budget_tokens = $3, budget_source = $4,
             usage = $5::jsonb, completed_at = $6::timestamptz
         WHERE id = $1
           AND (
             completed_at IS NULL
             OR (
               stop_reason = $2 AND budget_tokens = $3 AND budget_source = $4
               AND usage IS NOT DISTINCT FROM $5::jsonb AND completed_at = $6::timestamptz
             )
           )
         RETURNING id`,
        [
          turnId(event.runId, event.turn),
          event.payload.stopReason,
          event.payload.budget.tokens,
          event.payload.budget.source,
          event.payload.usage ? jsonParameter(event.payload.usage) : null,
          event.occurredAt,
        ],
        "project turn.completed",
      );
      return;
    }

    const terminal = terminalState(event);
    if (terminal) {
      await this.#requireApplied(
        `UPDATE runs
         SET status = $2, terminal_reason = $3, terminal_code = $4,
             usage = $5::jsonb, completed_at = $6::timestamptz
         WHERE id = $1
           AND (
             status = 'running'
             OR (
               status = $2 AND terminal_reason = $3
               AND terminal_code IS NOT DISTINCT FROM $4
               AND usage IS NOT DISTINCT FROM $5::jsonb
               AND completed_at = $6::timestamptz
             )
           )
         RETURNING id`,
        [event.runId, terminal.status, terminal.reason, terminal.code, terminal.usage, event.occurredAt],
        `project ${event.type}`,
      );
    }
  }

  async #requireApplied(sql: string, values: readonly unknown[], operation: string): Promise<void> {
    const result = await this.#database.query(sql, values);
    if (result.rows.length !== 1 || requireNonEmpty(result.rows[0]?.["id"], `${operation}.id`).length === 0) {
      throw new Error(`${operation} conflicted with the existing durable projection`);
    }
  }
}
