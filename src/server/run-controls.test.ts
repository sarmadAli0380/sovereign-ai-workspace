import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { PostgresRunControlGateway, RunControlError, type RunControlPolicy } from "./run-controls.ts";

const basePolicy: RunControlPolicy = {
  maxConcurrentPerUser: 1,
  maxConcurrentPerModel: 1,
  maxRunsPerUserPerWindow: 10,
  rateWindowMs: 60_000,
  maxTokensPerUserPerWindow: 100_000,
  maxSpendUsdPerUserPerWindow: 5,
  budgetWindowMs: 86_400_000,
  leaseTtlMs: 120_000,
};

const input = {
  runId: "run-1", userId: "user-1", idempotencyKey: "caller-command-0001",
  requestSha256: "a".repeat(64), configKey: "local-qwen",
  provider: "ollama", model: "qwen3:4b", reservedTokens: 16_384,
  reservedCostUsd: 0,
};

function fakePool(options: {
  existing?: readonly Record<string, unknown>[];
  counters?: Record<string, unknown>;
} = {}): { pool: Pool; calls: string[] } {
  const calls: string[] = [];
  const query = async (sql: string) => {
    calls.push(sql);
    if (/SELECT run_id, request_sha256/.test(sql)) return { rows: options.existing ?? [], rowCount: 0 };
    if (/AS user_concurrent/.test(sql)) return { rows: [{
      user_concurrent: "0", model_concurrent: "0", rate_runs: "0", tokens: "0", cost_usd: "0",
      ...options.counters,
    }], rowCount: 1 };
    if (/RETURNING run_id/.test(sql)) return { rows: [{ run_id: "run-1" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const client = { query, release() {} };
  return { pool: { connect: async () => client, query } as unknown as Pool, calls };
}

test("C4 controls: a durable reservation settles measured token and spend usage", async () => {
  const { pool, calls } = fakePool();
  const controls = new PostgresRunControlGateway({
    pool, policy: basePolicy, now: () => Date.parse("2026-08-25T00:00:00.000Z"), idFactory: () => "control-1",
  });
  const lease = await controls.acquire(input);
  assert.equal(lease.created, true);
  await lease.settle({ tokens: 42, costUsd: 0, measured: true });
  assert.ok(calls.some((sql) => /pg_advisory_xact_lock/.test(sql)));
  assert.ok(calls.some((sql) => /INSERT INTO run_control_reservations/.test(sql)));
  assert.ok(calls.some((sql) => /accounting_state = CASE/.test(sql)));
});

test("C4 controls: concurrency, rate, token, and spend decisions fail closed", async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ user_concurrent: "1" }, "control.user-concurrency-exhausted"],
    [{ model_concurrent: "1" }, "control.model-concurrency-exhausted"],
    [{ rate_runs: "10" }, "control.rate-exhausted"],
    [{ tokens: "90000" }, "control.token-budget-exhausted"],
    [{ cost_usd: "5" }, "control.spend-budget-exhausted"],
  ];
  for (const [counters, code] of cases) {
    const controls = new PostgresRunControlGateway({ pool: fakePool({ counters }).pool, policy: basePolicy });
    await assert.rejects(controls.acquire({ ...input, reservedCostUsd: code.includes("spend") ? 0.01 : 0 }), (error: unknown) => {
      assert.ok(error instanceof RunControlError);
      assert.equal(error.code, code);
      return true;
    });
  }
});

test("C4 controls: caller idempotency returns the same reservation without charging twice", async () => {
  const { pool, calls } = fakePool({ existing: [{ run_id: "run-existing", request_sha256: "a".repeat(64) }] });
  const controls = new PostgresRunControlGateway({ pool, policy: basePolicy });
  const lease = await controls.acquire(input);
  assert.equal(lease.created, false);
  assert.equal(lease.runId, "run-existing");
  assert.equal(calls.some((sql) => /INSERT INTO run_control_reservations/.test(sql)), false);
});
