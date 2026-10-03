import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { SqlExecutor, SqlQueryResult } from "./sql.ts";

export type PgQueryable = Pick<Pool | PoolClient, "query">;

/** Concrete node-postgres adapter kept separate from repository SQL. */
export class PgSqlExecutor implements SqlExecutor {
  readonly #client: PgQueryable;

  constructor(client: PgQueryable) {
    this.#client = client;
  }

  async query(sql: string, values: readonly unknown[] = []): Promise<SqlQueryResult> {
    const result = await this.#client.query<QueryResultRow>(sql, [...values]);
    return { rows: result.rows, rowCount: result.rowCount };
  }
}

export async function withPgTransaction<T>(
  pool: Pool,
  work: (database: SqlExecutor) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(new PgSqlExecutor(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
