import { randomBytes } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { parseSingleNodeDeploymentConfig, readDeploymentSecrets } from "../src/deployment/config.ts";
import { EncryptedEventSpool } from "../src/storage/durable-journal.ts";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function json(url: string, init?: RequestInit, timeoutMs = 120_000): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${new URL(url).pathname} returned HTTP ${response.status}`);
  return response.json();
}

async function writableVolume(root: string): Promise<void> {
  const canary = join(root, `.p3-readiness-${randomBytes(8).toString("hex")}`);
  const handle = await open(canary, "wx", 0o600);
  try {
    await handle.writeFile("deployment-readiness\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
    await unlink(canary);
  }
}

const config = parseSingleNodeDeploymentConfig();
const secrets = await readDeploymentSecrets(config);
const pool = new Pool({
  host: config.database.host,
  port: config.database.port,
  database: config.database.name,
  user: config.database.user,
  password: secrets.databasePassword,
  max: 1,
  connectionTimeoutMillis: 15_000,
  idleTimeoutMillis: 1_000,
  application_name: "sovereign-p3-readiness",
});

try {
  const database = await pool.query<{
    server_version_num: string;
    vector_version: string;
    migrations: string[];
  }>(`SELECT current_setting('server_version_num') AS server_version_num,
             (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS vector_version,
             ARRAY(SELECT version FROM schema_migrations ORDER BY version) AS migrations`);
  const databaseState = database.rows[0];
  if (!databaseState || !/^18\d{4}$/.test(databaseState.server_version_num)) {
    throw new Error("deployment database is not PostgreSQL 18.x");
  }
  if (databaseState.vector_version !== "0.8.6") throw new Error("deployment pgvector version is not 0.8.6");
  for (const migration of ["20260819000100", "20260821000200", "20260825000300", "20260825000400"]) {
    if (!databaseState.migrations.includes(migration)) throw new Error(`required migration ${migration} is absent`);
  }

  const versionPayload = await json(`${config.inference.baseUrl}/api/version`);
  if (!object(versionPayload) || versionPayload["version"] !== config.inference.expectedVersion) {
    throw new Error("deployment Ollama version does not match the frozen topology");
  }
  const tagsPayload = await json(`${config.inference.baseUrl}/api/tags`);
  const tags = object(tagsPayload) && Array.isArray(tagsPayload["models"]) ? tagsPayload["models"] : [];
  const expectedDigest = config.inference.modelDigest.slice("sha256:".length);
  const deployedModel = tags.find((entry) => object(entry) &&
    (entry["model"] === config.inference.modelId || entry["name"] === config.inference.modelId));
  if (!object(deployedModel) || deployedModel["digest"] !== expectedDigest) {
    throw new Error("deployment model tag is absent or does not match its pinned digest");
  }

  await json(`${config.inference.baseUrl}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: config.inference.modelId,
      prompt: "",
      stream: false,
      keep_alive: "5m",
      options: { num_ctx: config.inference.contextWindow, num_predict: 1 },
    }),
  }, config.inference.loadTimeoutMs);
  const processPayload = await json(`${config.inference.baseUrl}/api/ps`);
  const processes = object(processPayload) && Array.isArray(processPayload["models"])
    ? processPayload["models"]
    : [];
  const runningModel = processes.find((entry) => object(entry) &&
    (entry["model"] === config.inference.modelId || entry["name"] === config.inference.modelId));
  if (!object(runningModel) || runningModel["context_length"] !== config.inference.contextWindow) {
    throw new Error("deployment model did not load at the frozen context window");
  }

  await writableVolume(config.storage.attachmentRoot);
  const spool = new EncryptedEventSpool({
    directory: config.storage.spoolRoot,
    key: secrets.spoolKey,
    maxEntries: config.storage.spoolMaxEntries,
    maxBytes: config.storage.spoolMaxBytes,
  });
  const spoolState = await spool.stats();

  console.log(JSON.stringify({
    schemaVersion: 1,
    status: "ready",
    topology: "single-node-local-only",
    database: { major: 18, pgvector: databaseState.vector_version, migrations: databaseState.migrations },
    inference: {
      runtime: "ollama",
      version: config.inference.expectedVersion,
      modelId: config.inference.modelId,
      digest: config.inference.modelDigest,
      contextWindow: config.inference.contextWindow,
    },
    storage: { attachments: "writable", spool: "authenticated", pendingSpoolEntries: spoolState.entries },
  }, null, 2));
} finally {
  secrets.spoolKey.fill(0);
  await pool.end();
}
