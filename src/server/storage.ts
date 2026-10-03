import type { SqlExecutor } from "../storage/sql.ts";
import type { ServerPrincipal } from "./auth.ts";
import type { ServerAccessController } from "./http-server.ts";

function nonEmpty(value: string, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${path} must be non-empty`);
  return value;
}

/** PostgreSQL ownership checks for the single-tenant C1 ingress. */
export class PostgresServerAccessController implements ServerAccessController {
  readonly #database: SqlExecutor;

  constructor(database: SqlExecutor) {
    this.#database = database;
  }

  async authorizeConversation(principal: ServerPrincipal, conversationId: string): Promise<boolean> {
    const result = await this.#database.query(
      `SELECT 1
       FROM conversations AS conversation
       JOIN users AS owner ON owner.id = conversation.created_by
       WHERE conversation.id = $1
         AND conversation.archived_at IS NULL
         AND owner.status = 'active'
         AND ($2::boolean OR conversation.created_by = $3)
       LIMIT 1`,
      [
        nonEmpty(conversationId, "conversationId"),
        principal.roles.includes("admin"),
        nonEmpty(principal.userId, "principal.userId"),
      ],
    );
    return result.rows.length === 1;
  }

  async authorizeRun(principal: ServerPrincipal, runId: string): Promise<boolean> {
    const result = await this.#database.query(
      `SELECT 1
       FROM runs AS run
       JOIN conversations AS conversation ON conversation.id = run.conversation_id
       JOIN users AS owner ON owner.id = conversation.created_by
       WHERE run.id = $1
         AND conversation.archived_at IS NULL
         AND owner.status = 'active'
         AND ($2::boolean OR conversation.created_by = $3)
       LIMIT 1`,
      [
        nonEmpty(runId, "runId"),
        principal.roles.includes("admin"),
        nonEmpty(principal.userId, "principal.userId"),
      ],
    );
    return result.rows.length === 1;
  }
}
