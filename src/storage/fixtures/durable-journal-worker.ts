import { Pool } from "pg";
import { parseRunEvent, type RunEvent } from "../../events.ts";
import {
  DurableJournalSink,
  EncryptedEventSpool,
  JournalConsumer,
  type CheckpointStore,
  type JournalWriter,
} from "../durable-journal.ts";
import { PgSqlExecutor } from "../pg.ts";
import { EventJournalRepository } from "../repositories/journal.ts";
import { ConsumerCheckpointRepository } from "../repositories/work.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function boundary(name: string): void {
  process.send?.({ type: "boundary", name });
}

function hang(): Promise<never> {
  return new Promise(() => undefined);
}

const mode = required("B3_WORKER_MODE");
const event = parseRunEvent(JSON.parse(required("B3_EVENT_JSON"))) as RunEvent;
const pool = new Pool({
  connectionString: required("STORAGE_TEST_DATABASE_URL"),
  application_name: required("B3_APPLICATION_NAME"),
  max: 1,
});
const database = new PgSqlExecutor(pool);
const journal = new EventJournalRepository(database);

async function main(): Promise<void> {
  if (mode === "atomic-outbox") {
    await database.query("SELECT set_config('b3.test_event', $1, false)", [`journal:${event.eventId}`]);
    boundary("append-started");
    await journal.appendWithOutbox(event);
    return;
  }

  if (mode === "append-after-commit" || mode === "flush-after-commit") {
    const blockingWriter: JournalWriter = {
      appendWithOutbox: async (value) => {
        const result = await journal.appendWithOutbox(value);
        boundary("journal-committed");
        await hang();
        return result;
      },
    };
    const spool = mode === "flush-after-commit"
      ? new EncryptedEventSpool({
          directory: required("B3_SPOOL_DIRECTORY"),
          key: Buffer.from(required("B3_SPOOL_KEY_HEX"), "hex"),
          maxEntries: 10,
          maxBytes: 1_000_000,
        })
      : undefined;
    const durable = new DurableJournalSink({ journal: blockingWriter, ...(spool ? { spool } : {}) });
    if (mode === "flush-after-commit") await durable.flush();
    else await durable.append(event);
    return;
  }

  const consumerName = required("B3_CONSUMER_NAME");
  const effectId = required("B3_EFFECT_ID");
  const checkpoints = new ConsumerCheckpointRepository(database);
  const checkpointStore: CheckpointStore = mode === "consumer-before-checkpoint"
    ? {
        get: (name) => checkpoints.get(name),
        advance: async (input) => {
          boundary("before-checkpoint");
          await hang();
          return checkpoints.advance(input);
        },
      }
    : checkpoints;
  const consumer = new JournalConsumer({
    name: consumerName,
    journal,
    checkpoints: checkpointStore,
  });
  await consumer.drain(async ({ deliveryId }) => {
    await database.query(
      `INSERT INTO b3_process_effects (effect_id, event_id)
       VALUES ($1, $2)
       ON CONFLICT (effect_id) DO NOTHING`,
      [effectId, deliveryId],
    );
    if (mode === "consumer-after-effect") {
      boundary("effect-committed");
      await hang();
    }
  });
}

try {
  await main();
  await pool.end();
} catch (error) {
  process.send?.({
    type: "worker-error",
    message: error instanceof Error ? error.message : String(error),
  });
  await pool.end().catch(() => undefined);
  process.exitCode = 1;
}
