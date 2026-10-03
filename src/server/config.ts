import { isAbsolute, resolve } from "node:path";

export interface ServerDeploymentConfig {
  readonly host: "0.0.0.0";
  readonly port: number;
  readonly deploymentId: string;
  readonly sessionRegistryFile: string;
  readonly runTimeoutMs: number;
  readonly projectionIntervalMs: number;
  readonly admissionFreeBytes: number;
  readonly admissionHeadroomBytes: number;
  readonly maxConcurrentRunsPerUser: number;
  readonly maxConcurrentRunsPerModel: number;
  readonly maxRunsPerUserPerWindow: number;
  readonly rateWindowMs: number;
  readonly maxTokensPerUserPerWindow: number;
  readonly maxSpendUsdPerUserPerWindow: number;
  readonly budgetWindowMs: number;
  readonly controlLeaseTtlMs: number;
}

type Environment = Readonly<Record<string, string | undefined>>;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function value(env: Environment, name: string, fallback?: string): string {
  const candidate = env[name] ?? fallback;
  if (candidate === undefined || candidate.length === 0 || candidate.trim() !== candidate) {
    throw new TypeError(`${name} must be a non-empty value without surrounding whitespace`);
  }
  return candidate;
}

function positive(raw: string, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!/^\d+$/.test(raw)) throw new TypeError(`${name} must be a positive whole number`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new TypeError(`${name} must be a positive safe integer no greater than ${maximum}`);
  }
  return parsed;
}

function nonNegativeDecimal(raw: string, name: string): number {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,10})?$/.test(raw)) {
    throw new TypeError(`${name} must be a non-negative decimal with at most 10 fractional digits`);
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) throw new TypeError(`${name} must be finite and non-negative`);
  return parsed;
}

function secretPath(raw: string): string {
  if (!isAbsolute(raw) || resolve(raw) !== raw || !raw.startsWith("/run/secrets/")) {
    throw new TypeError("DEPLOYMENT_SESSION_REGISTRY_FILE must be a normalized /run/secrets path");
  }
  return raw;
}

/** Strict C2 process configuration; bearer tokens are forbidden in environment variables. */
export function parseServerDeploymentConfig(env: Environment = process.env): ServerDeploymentConfig {
  for (const forbidden of ["DEPLOYMENT_BEARER_TOKEN", "DEPLOYMENT_SESSION_TOKEN"]) {
    if (env[forbidden] !== undefined) throw new TypeError(`${forbidden} is forbidden; use the session registry file`);
  }
  const deploymentId = value(env, "DEPLOYMENT_ID", "single-node");
  if (!IDENTIFIER.test(deploymentId)) throw new TypeError("DEPLOYMENT_ID is invalid");
  const host = value(env, "DEPLOYMENT_SERVER_HOST", "0.0.0.0");
  if (host !== "0.0.0.0") throw new TypeError("DEPLOYMENT_SERVER_HOST must be the container wildcard address");
  const admissionFree = positive(
    value(env, "DEPLOYMENT_ADMISSION_FREE_BYTES"),
    "DEPLOYMENT_ADMISSION_FREE_BYTES",
  );
  const admissionHeadroom = positive(
    value(env, "DEPLOYMENT_ADMISSION_HEADROOM_BYTES", "536870912"),
    "DEPLOYMENT_ADMISSION_HEADROOM_BYTES",
  );
  if (admissionHeadroom >= admissionFree) {
    throw new TypeError("DEPLOYMENT_ADMISSION_HEADROOM_BYTES must be smaller than measured free bytes");
  }
  const runTimeoutMs = positive(
    value(env, "DEPLOYMENT_RUN_TIMEOUT_MS", "600000"),
    "DEPLOYMENT_RUN_TIMEOUT_MS",
    3_600_000,
  );
  const controlLeaseTtlMs = positive(
    value(env, "DEPLOYMENT_CONTROL_LEASE_TTL_MS", "660000"),
    "DEPLOYMENT_CONTROL_LEASE_TTL_MS",
    3_900_000,
  );
  if (controlLeaseTtlMs <= runTimeoutMs) {
    throw new TypeError("DEPLOYMENT_CONTROL_LEASE_TTL_MS must exceed DEPLOYMENT_RUN_TIMEOUT_MS");
  }
  return Object.freeze({
    host: "0.0.0.0",
    port: positive(value(env, "DEPLOYMENT_SERVER_PORT", "8080"), "DEPLOYMENT_SERVER_PORT", 65_535),
    deploymentId,
    sessionRegistryFile: secretPath(value(
      env,
      "DEPLOYMENT_SESSION_REGISTRY_FILE",
      "/run/secrets/session_registry",
    )),
    runTimeoutMs,
    projectionIntervalMs: positive(
      value(env, "DEPLOYMENT_PROJECTION_INTERVAL_MS", "1000"),
      "DEPLOYMENT_PROJECTION_INTERVAL_MS",
      60_000,
    ),
    admissionFreeBytes: admissionFree,
    admissionHeadroomBytes: admissionHeadroom,
    maxConcurrentRunsPerUser: positive(
      value(env, "DEPLOYMENT_MAX_CONCURRENT_RUNS_PER_USER", "1"),
      "DEPLOYMENT_MAX_CONCURRENT_RUNS_PER_USER",
      1_000,
    ),
    maxConcurrentRunsPerModel: positive(
      value(env, "DEPLOYMENT_MAX_CONCURRENT_RUNS_PER_MODEL", "1"),
      "DEPLOYMENT_MAX_CONCURRENT_RUNS_PER_MODEL",
      1_000,
    ),
    maxRunsPerUserPerWindow: positive(
      value(env, "DEPLOYMENT_MAX_RUNS_PER_USER_PER_WINDOW", "60"),
      "DEPLOYMENT_MAX_RUNS_PER_USER_PER_WINDOW",
      1_000_000,
    ),
    rateWindowMs: positive(
      value(env, "DEPLOYMENT_RATE_WINDOW_MS", "3600000"),
      "DEPLOYMENT_RATE_WINDOW_MS",
      86_400_000,
    ),
    maxTokensPerUserPerWindow: positive(
      value(env, "DEPLOYMENT_MAX_TOKENS_PER_USER_PER_WINDOW", "1000000"),
      "DEPLOYMENT_MAX_TOKENS_PER_USER_PER_WINDOW",
      Number.MAX_SAFE_INTEGER,
    ),
    maxSpendUsdPerUserPerWindow: nonNegativeDecimal(
      value(env, "DEPLOYMENT_MAX_SPEND_USD_PER_USER_PER_WINDOW", "0"),
      "DEPLOYMENT_MAX_SPEND_USD_PER_USER_PER_WINDOW",
    ),
    budgetWindowMs: positive(
      value(env, "DEPLOYMENT_BUDGET_WINDOW_MS", "86400000"),
      "DEPLOYMENT_BUDGET_WINDOW_MS",
      2_592_000_000,
    ),
    controlLeaseTtlMs,
  });
}
