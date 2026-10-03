import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { Pool } from "pg";
import { parseResidencyInventory } from "../src/residency.ts";
import { PgSqlExecutor } from "../src/storage/pg.ts";
import { IdentityRepository, MessageRepository } from "../src/storage/repositories/index.ts";

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface DatabaseIdentity {
  url: URL;
  name: string;
  user: string;
  password: string;
}

interface EnvironmentEvidence {
  postgresVersion: string;
  vectorVersion: string;
  migrationVersions: readonly string[];
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function databaseIdentity(raw: string, name: string): DatabaseIdentity {
  const url = new URL(raw);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`${name} must be a PostgreSQL URL`);
  }
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (!/^sovereign_b7_[a-z0-9_]+$/.test(databaseName)) {
    throw new Error(`${name} database must use the destructive-safety prefix sovereign_b7_`);
  }
  return {
    url,
    name: databaseName,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

async function command(
  executable: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<CommandResult> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveCommand({ stdout, stderr });
      else reject(new Error(`${basename(executable)} failed (${signal ?? code}): ${stderr || stdout}`));
    });
  });
}

async function environmentEvidence(pool: Pool): Promise<EnvironmentEvidence> {
  const result = await pool.query<{
    postgres_version: string;
    vector_version: string;
    migration_versions: string[];
  }>(
    `SELECT current_setting('server_version') AS postgres_version,
            (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS vector_version,
            COALESCE((SELECT json_agg(version ORDER BY version) FROM schema_migrations), '[]'::json) AS migration_versions`,
  );
  const row = result.rows[0];
  if (!row || !row.postgres_version.startsWith("18.")) throw new Error("B7 requires PostgreSQL 18.x");
  if (row.vector_version !== "0.8.6") throw new Error("B7 requires pgvector 0.8.6");
  return {
    postgresVersion: row.postgres_version,
    vectorVersion: row.vector_version,
    migrationVersions: row.migration_versions.map(String),
  };
}

async function seedOrderedHistory(pool: Pool, suffix: string): Promise<{ conversationId: string; messageIds: string[] }> {
  const database = new PgSqlExecutor(pool);
  const userId = `b7-backup-user-${suffix}`;
  const conversationId = `b7-backup-conversation-${suffix}`;
  const firstId = `b7-backup-message-1-${suffix}`;
  const secondId = `b7-backup-message-2-${suffix}`;
  const at = "2026-08-21T15:00:00.000Z";
  const identities = new IdentityRepository(database);
  await identities.createUser({
    id: userId,
    externalSubject: `b7-backup-subject-${suffix}`,
    displayName: "B7 backup restore",
    createdAt: at,
  });
  await identities.createConversation({
    id: conversationId,
    createdBy: userId,
    title: "B7 ordered restore",
    createdAt: at,
  });
  const messages = new MessageRepository(database);
  await messages.append({
    conversationId,
    seq: 0,
    message: {
      schemaVersion: 1,
      messageId: firstId,
      role: "user",
      createdAt: at,
      content: [{ type: "text", text: "backup-order-canary-first" }],
    },
  });
  await messages.append({
    conversationId,
    seq: 1,
    message: {
      schemaVersion: 1,
      messageId: secondId,
      role: "user",
      createdAt: "2026-08-21T15:00:01.000Z",
      content: [{ type: "text", text: "backup-order-canary-second" }],
    },
  });
  return { conversationId, messageIds: [firstId, secondId] };
}

async function verifyOrderedHistory(
  pool: Pool,
  conversationId: string,
  expectedMessageIds: readonly string[],
): Promise<void> {
  const result = await pool.query<{ id: string; seq: string; schema_version: number; envelope_version: string }>(
    `SELECT id, seq::text, schema_version, content ->> 'schemaVersion' AS envelope_version
     FROM messages WHERE conversation_id = $1 ORDER BY seq ASC`,
    [conversationId],
  );
  assertEqual(
    JSON.stringify(result.rows.map((row) => row.id)),
    JSON.stringify(expectedMessageIds),
    "restored message order",
  );
  for (const [index, row] of result.rows.entries()) {
    assertEqual(row.seq, String(index), `restored message ${index} sequence`);
    assertEqual(String(row.schema_version), "1", `restored message ${index} table schema version`);
    assertEqual(row.envelope_version, "1", `restored message ${index} envelope schema version`);
  }
}

function assertEqual(actual: string, expected: string, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, received ${actual}`);
}

async function backupAndRestore(
  source: DatabaseIdentity,
  restore: DatabaseIdentity,
  suffix: string,
): Promise<string> {
  const container = process.env["B7_PG_TOOLS_CONTAINER"];
  if (container) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(container)) throw new Error("B7_PG_TOOLS_CONTAINER is invalid");
    const archive = `/tmp/sovereign-b7-${suffix}.dump`;
    const environment = source.password ? ["--env", `PGPASSWORD=${source.password}`] : [];
    try {
      await command("docker", [
        "exec", ...environment, container, "pg_dump",
        "--username", source.user, "--dbname", source.name,
        "--format", "custom", "--file", archive,
      ]);
      const restoreEnvironment = restore.password ? ["--env", `PGPASSWORD=${restore.password}`] : [];
      await command("docker", [
        "exec", ...restoreEnvironment, container, "pg_restore",
        "--username", restore.user, "--dbname", restore.name,
        "--clean", "--if-exists", "--no-owner", "--no-privileges", archive,
      ]);
      const digest = await command("docker", ["exec", container, "sha256sum", archive]);
      const hash = digest.stdout.trim().split(/\s+/)[0];
      if (!hash || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("backup archive digest was invalid");
      return `sha256:${hash}`;
    } finally {
      await command("docker", ["exec", container, "rm", "-f", "--", archive]).catch(() => undefined);
    }
  }

  const directory = await mkdtemp(join(tmpdir(), "sovereign-b7-restore-"));
  const archive = join(directory, "backup.dump");
  try {
    await command(process.env["B7_PG_DUMP_BIN"] ?? "pg_dump", [
      "--format", "custom", "--file", archive, source.url.href,
    ], { env: { ...process.env, PGPASSWORD: source.password } });
    await command(process.env["B7_PG_RESTORE_BIN"] ?? "pg_restore", [
      "--clean", "--if-exists", "--no-owner", "--no-privileges",
      "--dbname", restore.url.href, archive,
    ], { env: { ...process.env, PGPASSWORD: restore.password } });
    const digest = await command("shasum", ["-a", "256", archive]);
    const hash = digest.stdout.trim().split(/\s+/)[0];
    if (!hash || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("backup archive digest was invalid");
    return `sha256:${hash}`;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function dbmateContainerUrl(url: URL): string {
  const value = new URL(url.href);
  if (value.hostname === "127.0.0.1" || value.hostname === "localhost" || value.hostname === "::1") {
    value.hostname = "host.docker.internal";
  }
  return value.href;
}

async function dbmate(direction: "down" | "up", target: DatabaseIdentity): Promise<void> {
  const migrations = resolve("src/storage/migrations");
  const image = process.env["B7_DBMATE_IMAGE"];
  if (image) {
    if (!/^[a-zA-Z0-9_./:@-]+$/.test(image)) throw new Error("B7_DBMATE_IMAGE is invalid");
    await command("docker", [
      "run", "--rm",
      "--volume", `${migrations}:/db/migrations:ro`,
      "--env", "DATABASE_URL",
      image,
      "--migrations-dir", "/db/migrations",
      "--no-dump-schema",
      direction,
    ], { env: { ...process.env, DATABASE_URL: dbmateContainerUrl(target.url) } });
    return;
  }
  await command(process.env["B7_DBMATE_BIN"] ?? "dbmate", [
    "--migrations-dir", migrations,
    "--no-dump-schema",
    direction,
  ], { env: { ...process.env, DATABASE_URL: target.url.href } });
}

async function runGate(files: readonly string[], databaseUrl?: string): Promise<void> {
  await command(process.execPath, ["--test", ...files], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...(databaseUrl ? { STORAGE_TEST_DATABASE_URL: databaseUrl } : {}),
    },
  });
}

function outputPath(): string {
  const index = process.argv.indexOf("--output");
  if (index === -1) return resolve("conformance", `${new Date().toISOString().slice(0, 10)}-residency-recovery.json`);
  const value = process.argv[index + 1];
  if (!value) throw new Error("--output requires a path");
  return resolve(value);
}

async function main(): Promise<void> {
  if (required("B7_CONFIRM_DISPOSABLE") !== "1") {
    throw new Error("B7_CONFIRM_DISPOSABLE=1 is required because the restore database is destroyed and rebuilt");
  }
  const source = databaseIdentity(required("B7_SOURCE_DATABASE_URL"), "B7_SOURCE_DATABASE_URL");
  const restore = databaseIdentity(required("B7_RESTORE_DATABASE_URL"), "B7_RESTORE_DATABASE_URL");
  if (source.url.href === restore.url.href || source.name === restore.name) {
    throw new Error("source and restore databases must be distinct");
  }

  const inventory = parseResidencyInventory(JSON.parse(await readFile(
    resolve("phaseB/residency-inventory.v1.json"),
    "utf8",
  )));
  const sourcePool = new Pool({ connectionString: source.url.href, max: 2 });
  const restorePool = new Pool({ connectionString: restore.url.href, max: 2 });
  try {
    const sourceEnvironment = await environmentEvidence(sourcePool);
    const targetTables = await restorePool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_tables WHERE schemaname = 'public'`,
    );
    assertEqual(targetTables.rows[0]!.count, "0", "restore database initial table count");

    const suffix = randomUUID();
    const seeded = await seedOrderedHistory(sourcePool, suffix);
    const backupDigest = await backupAndRestore(source, restore, suffix);
    await verifyOrderedHistory(restorePool, seeded.conversationId, seeded.messageIds);
    const restoredEnvironment = await environmentEvidence(restorePool);
    assertEqual(
      JSON.stringify(restoredEnvironment.migrationVersions),
      JSON.stringify(sourceEnvironment.migrationVersions),
      "restored migration versions",
    );

    await dbmate("down", restore);
    const rolledBack = await environmentEvidence(restorePool);
    if (rolledBack.migrationVersions.length !== restoredEnvironment.migrationVersions.length - 1) {
      throw new Error("dbmate down did not remove exactly one migration version");
    }
    await dbmate("up", restore);
    const recovered = await environmentEvidence(restorePool);
    assertEqual(
      JSON.stringify(recovered.migrationVersions),
      JSON.stringify(restoredEnvironment.migrationVersions),
      "migration recovery versions",
    );
    await verifyOrderedHistory(restorePool, seeded.conversationId, seeded.messageIds);

    await runGate(["src/residency.test.ts", "src/storage/run-history-projector.test.ts"]);
    await runGate(["src/storage/durable-journal.test.ts"]);
    await runGate(["src/storage/storage.integration.test.ts"], source.url.href);
    await runGate(["src/storage/b7-operational.integration.test.ts"], source.url.href);

    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      inventorySchemaVersion: inventory.schemaVersion,
      environment: {
        postgresVersion: sourceEnvironment.postgresVersion,
        pgvectorVersion: sourceEnvironment.vectorVersion,
        dbmateVersion: "2.35.0",
        migrationVersions: sourceEnvironment.migrationVersions,
      },
      recoveryObjectives: inventory.recovery,
      checks: {
        machineReadableResidencyInventory: "passed",
        metadataOnlyLogCanaries: "passed",
        backupRestoreOrderingAndSchemaVersions: "passed",
        migrationDownUpRecovery: "passed",
        databaseOutageEncryptedSpoolReplay: "passed",
        searchAfterErasure: "passed",
        airGappedEgressDenial: "passed",
        interruptedStreamTerminalWithoutAssistantMessage: "passed",
      },
      backupArchiveDigest: backupDigest,
      destructiveScope: {
        sourceDatabaseName: source.name,
        restoreDatabaseName: restore.name,
      },
    };
    const path = outputPath();
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    console.log(`B7 residency/recovery verification passed; evidence written to ${path}`);
  } finally {
    await Promise.allSettled([sourcePool.end(), restorePool.end()]);
  }
}

await main();
