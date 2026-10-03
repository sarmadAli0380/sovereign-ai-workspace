import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export interface SingleNodeDeploymentConfig {
  database: {
    host: string;
    port: number;
    name: string;
    user: string;
    passwordFile: string;
  };
  inference: {
    baseUrl: string;
    expectedVersion: string;
    modelId: string;
    modelDigest: string;
    contextWindow: number;
    loadTimeoutMs: number;
  };
  storage: {
    attachmentRoot: string;
    spoolRoot: string;
    spoolKeyFile: string;
    spoolMaxEntries: number;
    spoolMaxBytes: number;
  };
}

export interface DeploymentSecrets {
  databasePassword: string;
  spoolKey: Buffer;
}

type DeploymentEnvironment = Readonly<Record<string, string | undefined>>;

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const HOSTNAME = /^[a-z][a-z0-9-]{0,62}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SAFE_PASSWORD = /^[A-Za-z0-9._-]{32,128}$/;
const HEX_256 = /^[a-f0-9]{64}$/;

function value(env: DeploymentEnvironment, name: string, fallback: string): string {
  const candidate = env[name] ?? fallback;
  if (candidate.trim() !== candidate || candidate.length === 0) {
    throw new TypeError(`${name} must be a non-empty value without surrounding whitespace`);
  }
  return candidate;
}

function positiveInteger(raw: string, name: string): number {
  if (!/^\d+$/.test(raw)) throw new TypeError(`${name} must be a positive whole number`);
  const candidate = Number(raw);
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return candidate;
}

function absolutePath(raw: string, name: string, within: string): string {
  if (!isAbsolute(raw) || resolve(raw) !== raw) throw new TypeError(`${name} must be a normalized absolute path`);
  if (raw !== within && !raw.startsWith(`${within}/`)) {
    throw new TypeError(`${name} must stay within ${within}`);
  }
  return raw;
}

function rejectDirectSecrets(env: DeploymentEnvironment): void {
  for (const name of ["DEPLOYMENT_DATABASE_PASSWORD", "DEPLOYMENT_SPOOL_KEY"]) {
    if (env[name] !== undefined) {
      throw new TypeError(`${name} is forbidden; inject the secret through its *_FILE setting`);
    }
  }
}

/** Strict runtime parsing for the supported P3.1 single-node topology. */
export function parseSingleNodeDeploymentConfig(
  env: DeploymentEnvironment = process.env,
): SingleNodeDeploymentConfig {
  rejectDirectSecrets(env);

  const databaseHost = value(env, "DEPLOYMENT_DATABASE_HOST", "database");
  const databaseName = value(env, "DEPLOYMENT_DATABASE_NAME", "sovereign_ai");
  const databaseUser = value(env, "DEPLOYMENT_DATABASE_USER", "sovereign_app");
  if (!HOSTNAME.test(databaseHost)) throw new TypeError("DEPLOYMENT_DATABASE_HOST must be one internal service hostname");
  if (!IDENTIFIER.test(databaseName)) throw new TypeError("DEPLOYMENT_DATABASE_NAME must be a lowercase PostgreSQL identifier");
  if (!IDENTIFIER.test(databaseUser)) throw new TypeError("DEPLOYMENT_DATABASE_USER must be a lowercase PostgreSQL identifier");

  const inferenceUrl = new URL(value(env, "DEPLOYMENT_OLLAMA_URL", "http://inference:11434"));
  if (
    inferenceUrl.protocol !== "http:" || inferenceUrl.hostname !== "inference" ||
    inferenceUrl.port !== "11434" || inferenceUrl.pathname !== "/" ||
    inferenceUrl.username || inferenceUrl.password || inferenceUrl.search || inferenceUrl.hash
  ) {
    throw new TypeError("DEPLOYMENT_OLLAMA_URL must be exactly the internal http://inference:11434 origin");
  }

  const expectedVersion = value(env, "DEPLOYMENT_OLLAMA_VERSION", "0.32.5");
  const modelId = value(env, "DEPLOYMENT_MODEL_ID", "qwen3:4b");
  const modelDigest = value(
    env,
    "DEPLOYMENT_MODEL_DIGEST",
    "sha256:359d7dd4bcdab3d86b87d73ac27966f4dbb9f5efdfcc75d34a8764a09474fae7",
  );
  if (!VERSION.test(expectedVersion)) throw new TypeError("DEPLOYMENT_OLLAMA_VERSION must be an exact semantic version");
  if (!MODEL_ID.test(modelId)) throw new TypeError("DEPLOYMENT_MODEL_ID is invalid");
  if (!SHA256.test(modelDigest)) throw new TypeError("DEPLOYMENT_MODEL_DIGEST must be a full sha256 digest");

  return Object.freeze({
    database: Object.freeze({
      host: databaseHost,
      port: positiveInteger(value(env, "DEPLOYMENT_DATABASE_PORT", "5432"), "DEPLOYMENT_DATABASE_PORT"),
      name: databaseName,
      user: databaseUser,
      passwordFile: absolutePath(
        value(env, "DEPLOYMENT_DATABASE_PASSWORD_FILE", "/run/secrets/database_password"),
        "DEPLOYMENT_DATABASE_PASSWORD_FILE",
        "/run/secrets",
      ),
    }),
    inference: Object.freeze({
      baseUrl: inferenceUrl.origin,
      expectedVersion,
      modelId,
      modelDigest,
      contextWindow: positiveInteger(
        value(env, "DEPLOYMENT_MODEL_CONTEXT_WINDOW", "8192"),
        "DEPLOYMENT_MODEL_CONTEXT_WINDOW",
      ),
      loadTimeoutMs: positiveInteger(
        value(env, "DEPLOYMENT_MODEL_LOAD_TIMEOUT_MS", "600000"),
        "DEPLOYMENT_MODEL_LOAD_TIMEOUT_MS",
      ),
    }),
    storage: Object.freeze({
      attachmentRoot: absolutePath(
        value(env, "DEPLOYMENT_ATTACHMENT_ROOT", "/var/lib/sovereign/attachments"),
        "DEPLOYMENT_ATTACHMENT_ROOT",
        "/var/lib/sovereign",
      ),
      spoolRoot: absolutePath(
        value(env, "DEPLOYMENT_SPOOL_ROOT", "/var/lib/sovereign/spool"),
        "DEPLOYMENT_SPOOL_ROOT",
        "/var/lib/sovereign",
      ),
      spoolKeyFile: absolutePath(
        value(env, "DEPLOYMENT_SPOOL_KEY_FILE", "/run/secrets/spool_key"),
        "DEPLOYMENT_SPOOL_KEY_FILE",
        "/run/secrets",
      ),
      spoolMaxEntries: positiveInteger(
        value(env, "DEPLOYMENT_SPOOL_MAX_ENTRIES", "10000"),
        "DEPLOYMENT_SPOOL_MAX_ENTRIES",
      ),
      spoolMaxBytes: positiveInteger(
        value(env, "DEPLOYMENT_SPOOL_MAX_BYTES", "536870912"),
        "DEPLOYMENT_SPOOL_MAX_BYTES",
      ),
    }),
  });
}

async function regularSecret(path: string, label: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new TypeError(`${label} must be a regular non-symbolic file`);
  }
  const raw = await readFile(path, "utf8");
  if (!raw.endsWith("\n") || raw.slice(0, -1).includes("\n") || raw.includes("\r")) {
    throw new TypeError(`${label} must contain exactly one newline-terminated value`);
  }
  return raw.slice(0, -1);
}

/** Reads deployment secrets without placing their values in process arguments or reports. */
export async function readDeploymentSecrets(config: SingleNodeDeploymentConfig): Promise<DeploymentSecrets> {
  const [databasePassword, spoolKeyHex] = await Promise.all([
    regularSecret(config.database.passwordFile, "database password secret"),
    regularSecret(config.storage.spoolKeyFile, "spool key secret"),
  ]);
  if (!SAFE_PASSWORD.test(databasePassword)) {
    throw new TypeError("database password must be 32-128 characters from the base64url-safe deployment alphabet");
  }
  if (!HEX_256.test(spoolKeyHex)) throw new TypeError("spool key must be exactly 32 lowercase-hex bytes");
  return { databasePassword, spoolKey: Buffer.from(spoolKeyHex, "hex") };
}
