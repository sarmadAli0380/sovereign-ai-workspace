import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import { Pool } from "pg";
import {
  DurableJournalSink,
  EncryptedEventSpool,
  JournalConsumer,
} from "./durable-journal.ts";
import { PgSqlExecutor } from "./pg.ts";
import { IdentityRepository, RunRepository } from "./repositories/entities.ts";
import { EventJournalRepository } from "./repositories/journal.ts";
import { ConsumerCheckpointRepository } from "./repositories/work.ts";
import {
  RUN_EVENT_SCHEMA_VERSION,
  RUN_EVENT_SENSITIVITY,
  type RunEventOf,
} from "../events.ts";

const databaseUrl = process.env["STORAGE_TEST_DATABASE_URL"];
const occurredAt = "2026-08-21T12:00:00.000Z";
const workerPath = fileURLToPath(new URL("./fixtures/durable-journal-worker.ts", import.meta.url));

interface BoundaryMessage {
  type: "boundary";
  name: string;
}

function isBoundaryMessage(value: unknown): value is BoundaryMessage {
  return typeof value === "object" && value !== null
    && (value as { type?: unknown }).type === "boundary"
    && typeof (value as { name?: unknown }).name === "string";
}

function startWorker(input: {
  mode: string;
  event: RunEventOf<"run.started">;
  applicationName: string;
  extraEnv?: Record<string, string>;
}): ChildProcess {
  return fork(workerPath, [], {
    execArgv: [],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      STORAGE_TEST_DATABASE_URL: databaseUrl,
      B3_WORKER_MODE: input.mode,
      B3_EVENT_JSON: JSON.stringify(input.event),
      B3_APPLICATION_NAME: input.applicationName,
      ...input.extraEnv,
    },
  });
}

async function waitForBoundary(child: ChildProcess, name: string): Promise<void> {
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`worker did not reach ${name}: ${stderr}`)), 10_000);
    const onMessage = (message: unknown): void => {
      if (!isBoundaryMessage(message) || message.name !== name) return;
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
      resolve();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      reject(new Error(`worker exited before ${name} (code=${code}, signal=${signal}): ${stderr}`));
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

async function killWorker(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = waitForExit(child);
  child.kill("SIGKILL");
  await exited;
}

async function eventCounts(pool: Pool, eventId: string): Promise<[number, number, number]> {
  const result = await pool.query<{
    journal_count: string;
    audit_count: string;
    outbox_count: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM event_journal WHERE event_id = $1) AS journal_count,
       (SELECT count(*)::text FROM audit_events WHERE event_id = $1) AS audit_count,
       (SELECT count(*)::text FROM outbox_jobs WHERE idempotency_key = 'journal:' || $1) AS outbox_count`,
    [eventId],
  );
  const row = result.rows[0]!;
  return [Number(row.journal_count), Number(row.audit_count), Number(row.outbox_count)];
}

async function createRun(database: PgSqlExecutor, suffix: string): Promise<RunEventOf<"run.started">> {
  const userId = `b3-user-${suffix}`;
  const conversationId = `b3-conversation-${suffix}`;
  const runId = `b3-run-${suffix}`;
  const identities = new IdentityRepository(database);
  await identities.createUser({
    id: userId,
    externalSubject: `b3-subject-${suffix}`,
    displayName: "B3 Process Test",
    createdAt: occurredAt,
  });
  await identities.createConversation({
    id: conversationId,
    createdBy: userId,
    createdAt: occurredAt,
  });
  await new RunRepository(database).start({
    id: runId,
    conversationId,
    causationId: `b3-command-${suffix}`,
    configKey: "local",
    provider: "ollama",
    model: "qwen3:4b",
    startedAt: occurredAt,
  });
  return {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    eventId: `b3-event-${suffix}`,
    runId,
    conversationId,
    sequence: 0,
    turn: 0,
    occurredAt,
    type: "run.started",
    causationId: `b3-command-${suffix}`,
    audience: "persistence",
    sensitivity: RUN_EVENT_SENSITIVITY["run.started"],
    payload: { configKey: "local", provider: "ollama", model: "qwen3:4b" },
  };
}

async function waitForSleepingBackend(pool: Pool, applicationName: string): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await pool.query<{ pid: number }>(
      `SELECT pid
       FROM pg_stat_activity
       WHERE application_name = $1 AND wait_event = 'PgSleep'`,
      [applicationName],
    );
    if (result.rows[0]) return result.rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`database worker ${applicationName} did not reach the outbox sleep boundary`);
}

test("B3 process kills preserve atomicity, replay, and monotonic checkpoints", {
  skip: databaseUrl ? false : "set STORAGE_TEST_DATABASE_URL to a disposable migrated database",
}, async (context) => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  context.after(() => pool.end());
  const database = new PgSqlExecutor(pool);
  const children = new Set<ChildProcess>();
  context.after(async () => {
    await Promise.all([...children].map((child) => killWorker(child)));
  });
  await database.query(
    `CREATE TABLE IF NOT EXISTS b3_process_effects (
       effect_id text PRIMARY KEY,
       event_id text NOT NULL
     )`,
  );

  const atomicSuffix = randomUUID().replaceAll("-", "");
  const atomicEvent = await createRun(database, atomicSuffix);
  const functionName = `b3_sleep_outbox_${atomicSuffix}`;
  const triggerName = `b3_sleep_outbox_trigger_${atomicSuffix}`;
  await database.query(
    `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       IF NEW.idempotency_key = current_setting('b3.test_event', true) THEN
         PERFORM pg_sleep(30);
       END IF;
       RETURN NEW;
     END
     $$`,
  );
  await database.query(
    `CREATE TRIGGER ${triggerName}
     BEFORE INSERT ON outbox_jobs
     FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
  );
  try {
    const applicationName = `b3-atomic-${atomicSuffix}`;
    const child = startWorker({ mode: "atomic-outbox", event: atomicEvent, applicationName });
    children.add(child);
    await waitForBoundary(child, "append-started");
    const backendPid = await waitForSleepingBackend(pool, applicationName);
    const termination = await pool.query<{ terminated: boolean }>(
      "SELECT pg_terminate_backend($1) AS terminated",
      [backendPid],
    );
    assert.equal(termination.rows[0]?.terminated, true);
    await waitForExit(child);
    children.delete(child);
    assert.deepEqual(await eventCounts(pool, atomicEvent.eventId), [0, 0, 0]);
  } finally {
    await database.query(`DROP TRIGGER IF EXISTS ${triggerName} ON outbox_jobs`);
    await database.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
  }

  const acknowledgementSuffix = randomUUID().replaceAll("-", "");
  const acknowledgementEvent = await createRun(database, acknowledgementSuffix);
  const acknowledgementChild = startWorker({
    mode: "append-after-commit",
    event: acknowledgementEvent,
    applicationName: `b3-ack-${acknowledgementSuffix}`,
  });
  children.add(acknowledgementChild);
  await waitForBoundary(acknowledgementChild, "journal-committed");
  await killWorker(acknowledgementChild);
  children.delete(acknowledgementChild);
  assert.deepEqual(await eventCounts(pool, acknowledgementEvent.eventId), [1, 1, 1]);
  assert.equal(await new EventJournalRepository(database).append(acknowledgementEvent), false);
  assert.deepEqual(await eventCounts(pool, acknowledgementEvent.eventId), [1, 1, 1]);

  const spoolSuffix = randomUUID().replaceAll("-", "");
  const spoolEvent = await createRun(database, spoolSuffix);
  const spoolDirectory = await mkdtemp(join(tmpdir(), "sovereign-b3-process-"));
  context.after(() => rm(spoolDirectory, { recursive: true, force: true }));
  const spoolKey = randomBytes(32);
  const spool = new EncryptedEventSpool({
    directory: spoolDirectory,
    key: spoolKey,
    maxEntries: 10,
    maxBytes: 1_000_000,
  });
  await spool.append(spoolEvent);
  const spoolChild = startWorker({
    mode: "flush-after-commit",
    event: spoolEvent,
    applicationName: `b3-spool-${spoolSuffix}`,
    extraEnv: {
      B3_SPOOL_DIRECTORY: spoolDirectory,
      B3_SPOOL_KEY_HEX: spoolKey.toString("hex"),
    },
  });
  children.add(spoolChild);
  await waitForBoundary(spoolChild, "journal-committed");
  await killWorker(spoolChild);
  children.delete(spoolChild);
  assert.equal((await spool.stats()).entries, 1);
  assert.deepEqual(await eventCounts(pool, spoolEvent.eventId), [1, 1, 1]);
  assert.equal(await new DurableJournalSink({
    journal: new EventJournalRepository(database),
    spool,
  }).flush(), 1);
  assert.deepEqual(await spool.stats(), { entries: 0, bytes: 0 });
  assert.deepEqual(await eventCounts(pool, spoolEvent.eventId), [1, 1, 1]);

  for (const mode of ["consumer-after-effect", "consumer-before-checkpoint"] as const) {
    const consumerSuffix = randomUUID().replaceAll("-", "");
    const consumerEvent = await createRun(database, consumerSuffix);
    const appendResult = await new EventJournalRepository(database).appendWithOutbox(consumerEvent);
    assert.equal(appendResult.inserted, true);
    assert.ok(appendResult.journalSeq);
    const consumerName = `b3-consumer-${mode}-${consumerSuffix}`;
    const effectId = `b3-effect-${mode}-${consumerSuffix}`;
    const prior = await pool.query<{ journal_seq: string; event_id: string }>(
      `SELECT journal_seq::text, event_id
       FROM event_journal
       WHERE journal_seq < $1
       ORDER BY journal_seq DESC
       LIMIT 1`,
      [appendResult.journalSeq],
    );
    assert.ok(prior.rows[0]);
    await new ConsumerCheckpointRepository(database).advance({
      consumerName,
      journalSeq: Number(prior.rows[0].journal_seq),
      eventId: prior.rows[0].event_id,
      updatedAt: occurredAt,
    });
    const consumerChild = startWorker({
      mode,
      event: consumerEvent,
      applicationName: `b3-consumer-${consumerSuffix}`,
      extraEnv: {
        B3_CONSUMER_NAME: consumerName,
        B3_EFFECT_ID: effectId,
      },
    });
    children.add(consumerChild);
    await waitForBoundary(
      consumerChild,
      mode === "consumer-after-effect" ? "effect-committed" : "before-checkpoint",
    );
    await killWorker(consumerChild);
    children.delete(consumerChild);

    const effectBeforeReplay = await pool.query<{ count: string; event_id: string }>(
      `SELECT count(*)::text AS count, min(event_id) AS event_id
       FROM b3_process_effects
       WHERE effect_id = $1`,
      [effectId],
    );
    assert.equal(effectBeforeReplay.rows[0]?.count, "1");
    assert.equal(effectBeforeReplay.rows[0]?.event_id, consumerEvent.eventId);
    assert.equal(
      (await new ConsumerCheckpointRepository(database).get(consumerName))?.journalSeq,
      Number(prior.rows[0].journal_seq),
    );

    const consumer = new JournalConsumer({
      name: consumerName,
      journal: new EventJournalRepository(database),
      checkpoints: new ConsumerCheckpointRepository(database),
      now: () => occurredAt,
    });
    assert.ok(await consumer.drain(async ({ deliveryId }) => {
      await database.query(
        `INSERT INTO b3_process_effects (effect_id, event_id)
         VALUES ($1, $2)
         ON CONFLICT (effect_id) DO NOTHING`,
        [effectId, deliveryId],
      );
    }) >= 1);
    const effectAfterReplay = await pool.query<{ count: string; event_id: string }>(
      `SELECT count(*)::text AS count, min(event_id) AS event_id
       FROM b3_process_effects
       WHERE effect_id = $1`,
      [effectId],
    );
    assert.equal(effectAfterReplay.rows[0]?.count, "1");
    assert.equal(effectAfterReplay.rows[0]?.event_id, consumerEvent.eventId);
    assert.ok(
      (await new ConsumerCheckpointRepository(database).get(consumerName))!.journalSeq
        >= appendResult.journalSeq,
    );
  }
});
