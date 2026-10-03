import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { withPgTransaction } from "../storage/pg.ts";
import {
  isoParameter,
  requireNonEmpty,
  requireTimestamp,
  requireWholeNumber,
  type SqlExecutor,
} from "../storage/sql.ts";

export interface RunControlPolicy {
  readonly maxConcurrentPerUser: number;
  readonly maxConcurrentPerModel: number;
  readonly maxRunsPerUserPerWindow: number;
  readonly rateWindowMs: number;
  readonly maxTokensPerUserPerWindow: number;
  readonly maxSpendUsdPerUserPerWindow: number;
  readonly budgetWindowMs: number;
  readonly leaseTtlMs: number;
}

export interface AcquireRunControlInput {
  readonly runId: string;
  readonly userId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly configKey: string;
  readonly provider: string;
  readonly model: string;
  readonly reservedTokens: number;
  readonly reservedCostUsd: number;
}

export interface SettledRunUsage {
  readonly tokens: number;
  readonly costUsd: number;
  readonly measured: boolean;
}

export interface RunControlLease {
  readonly runId: string;
  readonly created: boolean;
  settle(usage: SettledRunUsage): Promise<void>;
  release(): Promise<void>;
}

export interface RunControlGateway {
  acquire(input: AcquireRunControlInput): Promise<RunControlLease>;
}

export class RunControlError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "RunControlError";
    this.code = code;
  }
}

const SHA256 = /^[a-f0-9]{64}$/;

function positive(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${path} must be a positive safe integer`);
  }
  return value;
}

function nonNegative(value: number, path: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${path} must be finite and non-negative`);
  }
  return value;
}

function policy(input: RunControlPolicy): RunControlPolicy {
  return Object.freeze({
    maxConcurrentPerUser: positive(input.maxConcurrentPerUser, "controls.maxConcurrentPerUser"),
    maxConcurrentPerModel: positive(input.maxConcurrentPerModel, "controls.maxConcurrentPerModel"),
    maxRunsPerUserPerWindow: positive(input.maxRunsPerUserPerWindow, "controls.maxRunsPerUserPerWindow"),
    rateWindowMs: positive(input.rateWindowMs, "controls.rateWindowMs"),
    maxTokensPerUserPerWindow: positive(input.maxTokensPerUserPerWindow, "controls.maxTokensPerUserPerWindow"),
    maxSpendUsdPerUserPerWindow: nonNegative(
      input.maxSpendUsdPerUserPerWindow,
      "controls.maxSpendUsdPerUserPerWindow",
    ),
    budgetWindowMs: positive(input.budgetWindowMs, "controls.budgetWindowMs"),
    leaseTtlMs: positive(input.leaseTtlMs, "controls.leaseTtlMs"),
  });
}

function decimal(row: Record<string, unknown>, field: string): number {
  const value = typeof row[field] === "string" ? Number(row[field]) : row[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must decode to a finite non-negative number`);
  }
  return value;
}

class PostgresRunControlLease implements RunControlLease {
  readonly runId: string;
  readonly created: boolean;
  readonly #pool: Pool;

  constructor(pool: Pool, runId: string, created: boolean) {
    this.#pool = pool;
    this.runId = runId;
    this.created = created;
  }

  async settle(usage: SettledRunUsage): Promise<void> {
    const tokens = requireWholeNumber(usage.tokens, "controls.usage.tokens");
    const cost = nonNegative(usage.costUsd, "controls.usage.costUsd");
    const result = await this.#pool.query(
      `UPDATE run_control_reservations
       SET status = 'settled',
           observed_tokens = CASE WHEN $2 THEN $3 ELSE reserved_tokens END,
           observed_cost_usd = CASE WHEN $2 THEN $4::numeric ELSE reserved_cost_usd END,
           accounting_state = CASE WHEN $2 THEN 'measured' ELSE 'conservative' END,
           settled_at = transaction_timestamp()
       WHERE run_id = $1 AND status = 'active'
       RETURNING run_id`,
      [this.runId, usage.measured, tokens, cost],
    );
    if (result.rows.length > 1) throw new Error("control settlement was ambiguous");
  }

  async release(): Promise<void> {
    const result = await this.#pool.query(
      `UPDATE run_control_reservations
       SET status = 'released', settled_at = transaction_timestamp()
       WHERE run_id = $1 AND status = 'active'
       RETURNING run_id`,
      [this.runId],
    );
    if (result.rows.length > 1) throw new Error("control release was ambiguous");
  }
}

/**
 * C4 durable control plane. Advisory transaction locks serialize the two
 * affected scopes before fresh statements inspect counters and reservations.
 * Expired leases are still charged conservatively to the budget window, but
 * no longer consume concurrency.
 */
export class PostgresRunControlGateway implements RunControlGateway {
  readonly #pool: Pool;
  readonly #policy: RunControlPolicy;
  readonly #now: () => number;
  readonly #idFactory: () => string;

  constructor(options: {
    pool: Pool;
    policy: RunControlPolicy;
    now?: () => number;
    idFactory?: () => string;
  }) {
    this.#pool = options.pool;
    this.#policy = policy(options.policy);
    this.#now = options.now ?? Date.now;
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  async acquire(input: AcquireRunControlInput): Promise<RunControlLease> {
    if (!SHA256.test(input.requestSha256)) throw new TypeError("controls.requestSha256 is invalid");
    const reservedTokens = requireWholeNumber(input.reservedTokens, "controls.reservedTokens");
    const reservedCost = nonNegative(input.reservedCostUsd, "controls.reservedCostUsd");
    const nowMs = this.#now();
    if (!Number.isFinite(nowMs)) throw new TypeError("controls.now must be finite");
    const now = new Date(nowMs).toISOString();
    const rateCutoff = new Date(nowMs - this.#policy.rateWindowMs).toISOString();
    const budgetCutoff = new Date(nowMs - this.#policy.budgetWindowMs).toISOString();
    const expiresAt = new Date(nowMs + this.#policy.leaseTtlMs).toISOString();
    const modelScope = `${requireNonEmpty(input.provider, "controls.provider")}/${requireNonEmpty(input.model, "controls.model")}`;

    const created = await withPgTransaction(this.#pool, async (database) => {
      const lockKeys = [`c4:model:${modelScope}`, `c4:user:${input.userId}`].sort();
      for (const key of lockKeys) {
        await database.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
      }

      const existing = await database.query(
        `SELECT run_id, request_sha256
         FROM run_control_reservations
         WHERE user_id = $1 AND idempotency_key = $2`,
        [requireNonEmpty(input.userId, "controls.userId"), requireNonEmpty(input.idempotencyKey, "controls.idempotencyKey")],
      );
      if (existing.rows.length > 0) {
        const row = existing.rows[0]!;
        if (requireNonEmpty(row["request_sha256"], "controls.existing.requestSha256") !== input.requestSha256) {
          throw new RunControlError("run.idempotency-conflict");
        }
        return { runId: requireNonEmpty(row["run_id"], "controls.existing.runId"), created: false };
      }

      const counters = await this.#counters(database, input.userId, modelScope, now, rateCutoff, budgetCutoff);
      if (counters.userConcurrent >= this.#policy.maxConcurrentPerUser) {
        throw new RunControlError("control.user-concurrency-exhausted");
      }
      if (counters.modelConcurrent >= this.#policy.maxConcurrentPerModel) {
        throw new RunControlError("control.model-concurrency-exhausted");
      }
      if (counters.rateRuns >= this.#policy.maxRunsPerUserPerWindow) {
        throw new RunControlError("control.rate-exhausted");
      }
      if (counters.tokens + reservedTokens > this.#policy.maxTokensPerUserPerWindow) {
        throw new RunControlError("control.token-budget-exhausted");
      }
      if (counters.costUsd + reservedCost > this.#policy.maxSpendUsdPerUserPerWindow) {
        throw new RunControlError("control.spend-budget-exhausted");
      }

      await database.query(
        `INSERT INTO run_control_reservations (
           id, run_id, user_id, idempotency_key, request_sha256, config_key,
           model_scope, reserved_tokens, reserved_cost_usd, status,
           accounting_state, accepted_at, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric,
                   'active', 'reserved', $10::timestamptz, $11::timestamptz)`,
        [
          requireNonEmpty(this.#idFactory(), "controls.id"),
          requireNonEmpty(input.runId, "controls.runId"),
          input.userId,
          input.idempotencyKey,
          input.requestSha256,
          requireNonEmpty(input.configKey, "controls.configKey"),
          modelScope,
          reservedTokens,
          reservedCost,
          isoParameter(now, "controls.acceptedAt"),
          isoParameter(expiresAt, "controls.expiresAt"),
        ],
      );
      return { runId: input.runId, created: true };
    });
    return new PostgresRunControlLease(this.#pool, created.runId, created.created);
  }

  async #counters(
    database: SqlExecutor,
    userId: string,
    modelScope: string,
    now: string,
    rateCutoff: string,
    budgetCutoff: string,
  ): Promise<{
    userConcurrent: number;
    modelConcurrent: number;
    rateRuns: number;
    tokens: number;
    costUsd: number;
  }> {
    const result = await database.query(
      `SELECT
         count(*) FILTER (
           WHERE user_id = $1 AND status = 'active' AND expires_at > $3::timestamptz
         )::text AS user_concurrent,
         count(*) FILTER (
           WHERE model_scope = $2 AND status = 'active' AND expires_at > $3::timestamptz
         )::text AS model_concurrent,
         count(*) FILTER (
           WHERE user_id = $1 AND status <> 'released' AND accepted_at >= $4::timestamptz
         )::text AS rate_runs,
         COALESCE(sum(
           CASE WHEN status = 'settled' THEN observed_tokens ELSE reserved_tokens END
         ) FILTER (
           WHERE user_id = $1 AND status <> 'released' AND accepted_at >= $5::timestamptz
         ), 0)::text AS tokens,
         COALESCE(sum(
           CASE WHEN status = 'settled' THEN observed_cost_usd ELSE reserved_cost_usd END
         ) FILTER (
           WHERE user_id = $1 AND status <> 'released' AND accepted_at >= $5::timestamptz
         ), 0)::text AS cost_usd
       FROM run_control_reservations`,
      [userId, modelScope, requireTimestamp(now, "controls.now"), rateCutoff, budgetCutoff],
    );
    const row = result.rows[0] ?? {};
    return {
      userConcurrent: requireWholeNumber(row["user_concurrent"] ?? "0", "controls.userConcurrent"),
      modelConcurrent: requireWholeNumber(row["model_concurrent"] ?? "0", "controls.modelConcurrent"),
      rateRuns: requireWholeNumber(row["rate_runs"] ?? "0", "controls.rateRuns"),
      tokens: requireWholeNumber(row["tokens"] ?? "0", "controls.tokens"),
      costUsd: decimal({ cost_usd: row["cost_usd"] ?? "0" }, "cost_usd"),
    };
  }
}
