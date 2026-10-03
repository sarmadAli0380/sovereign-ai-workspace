import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DurableJournalError,
  DurableJournalSink,
  DurableJournalUnavailableError,
  EncryptedEventSpool,
  JournalConsumer,
  SpoolCorruptionError,
  type CheckpointStore,
  type JournalReader,
  type JournalWriter,
} from "./durable-journal.ts";
import {
  RUN_EVENT_SCHEMA_VERSION,
  RUN_EVENT_SENSITIVITY,
  type RunEvent,
  type RunEventOf,
  type RunEventPayloadMap,
  type RunEventType,
} from "../events.ts";
import type { ConsumerCheckpoint } from "./repositories/work.ts";
import type { JournalAppendResult, StoredJournalEvent } from "./repositories/journal.ts";

const occurredAt = "2026-08-21T08:00:00.000Z";

function event<TType extends RunEventType>(
  type: TType,
  payload: RunEventPayloadMap[TType],
  sequence: number,
): RunEventOf<TType> {
  return {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    eventId: `event-${sequence}`,
    runId: "run-1",
    conversationId: "conversation-1",
    sequence,
    turn: type === "run.started" ? 0 : 1,
    occurredAt,
    type,
    causationId: "command-1",
    audience: type === "message.delta" ? "ui" : "persistence",
    sensitivity: RUN_EVENT_SENSITIVITY[type],
    payload,
  } as RunEventOf<TType>;
}

const started = event(
  "run.started",
  { configKey: "local", provider: "ollama", model: "qwen3:4b" },
  0,
);
const turnStarted = event("turn.started", {}, 1);
const completed = event("run.completed", { reason: "stop" }, 2);

class MemoryJournal implements JournalWriter, JournalReader {
  online = true;
  errorCode = "ECONNREFUSED";
  failAfterCommitOnce = false;
  readonly events: StoredJournalEvent[] = [];

  async appendWithOutbox(value: RunEvent): Promise<JournalAppendResult> {
    if (!this.online) throw Object.assign(new Error("database offline"), { code: this.errorCode });
    const duplicate = this.events.find((item) => item.event.eventId === value.eventId);
    if (duplicate) return { inserted: false };
    const journalSeq = this.events.length + 1;
    this.events.push({ journalSeq, event: value });
    if (this.failAfterCommitOnce) {
      this.failAfterCommitOnce = false;
      throw Object.assign(new Error("connection lost after commit"), { code: "ECONNRESET" });
    }
    return { inserted: true, journalSeq };
  }

  async listAfter(journalSeq: number, limit = 100): Promise<StoredJournalEvent[]> {
    return this.events.filter((item) => item.journalSeq > journalSeq).slice(0, limit);
  }
}

async function spoolFixture(t: test.TestContext, options: { maxEntries?: number; maxBytes?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "sovereign-journal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = randomBytes(32);
  return {
    directory,
    key,
    spool: new EncryptedEventSpool({
      directory,
      key,
      maxEntries: options.maxEntries ?? 10,
      maxBytes: options.maxBytes ?? 1_000_000,
    }),
  };
}

test("database outage is acknowledged only after encrypted spool persistence", async (t) => {
  const fixture = await spoolFixture(t);
  const journal = new MemoryJournal();
  journal.online = false;
  const durable = new DurableJournalSink({ journal, spool: fixture.spool });

  await durable.append(started);

  assert.deepEqual(await fixture.spool.stats(), { entries: 1, bytes: (await fixture.spool.list())[0]!.byteSize });
  const fileName = (await readdir(fixture.directory)).find((name) => name.endsWith(".spool"));
  assert.ok(fileName);
  const ciphertext = await readFile(join(fixture.directory, fileName), "utf8");
  assert.doesNotMatch(ciphertext, /event-0|qwen3:4b|conversation-1/);
  assert.equal(journal.events.length, 0);
});

test("restart replay preserves event identity and per-run order before a new write", async (t) => {
  const fixture = await spoolFixture(t);
  const journal = new MemoryJournal();
  journal.online = false;
  const offline = new DurableJournalSink({ journal, spool: fixture.spool });
  await offline.append(started);
  await offline.append(turnStarted);

  journal.online = true;
  const restartedSpool = new EncryptedEventSpool({
    directory: fixture.directory,
    key: fixture.key,
    maxEntries: 10,
    maxBytes: 1_000_000,
  });
  const restarted = new DurableJournalSink({ journal, spool: restartedSpool });
  await restarted.append(completed);

  assert.deepEqual(journal.events.map((item) => item.event.eventId), ["event-0", "event-1", "event-2"]);
  assert.deepEqual(await restartedSpool.stats(), { entries: 0, bytes: 0 });
});

test("ambiguous commit is spooled, then duplicate replay drains without a second journal row", async (t) => {
  const fixture = await spoolFixture(t);
  const journal = new MemoryJournal();
  journal.failAfterCommitOnce = true;
  const durable = new DurableJournalSink({ journal, spool: fixture.spool });

  await durable.append(started);
  assert.equal(journal.events.length, 1);
  assert.equal((await fixture.spool.stats()).entries, 1);

  assert.equal(await durable.flush(), 1);
  assert.equal(journal.events.length, 1);
  assert.deepEqual(await fixture.spool.stats(), { entries: 0, bytes: 0 });
});

test("replay survives a committed write before spool deletion", async (t) => {
  const fixture = await spoolFixture(t);
  const journal = new MemoryJournal();
  journal.online = false;
  const durable = new DurableJournalSink({ journal, spool: fixture.spool });
  await durable.append(started);

  journal.online = true;
  journal.failAfterCommitOnce = true;
  await assert.rejects(durable.flush(), DurableJournalUnavailableError);
  assert.equal(journal.events.length, 1);
  assert.equal((await fixture.spool.stats()).entries, 1);

  assert.equal(await durable.flush(), 1);
  assert.equal(journal.events.length, 1);
  assert.deepEqual(await fixture.spool.stats(), { entries: 0, bytes: 0 });
});

test("spool exhaustion rejects the acknowledgement boundary explicitly", async (t) => {
  const fixture = await spoolFixture(t, { maxEntries: 1 });
  const journal = new MemoryJournal();
  journal.online = false;
  const durable = new DurableJournalSink({ journal, spool: fixture.spool });
  await durable.append(started);

  await assert.rejects(durable.append(turnStarted), DurableJournalUnavailableError);
  assert.deepEqual(await fixture.spool.stats(), { entries: 1, bytes: (await fixture.spool.list())[0]!.byteSize });
});

test("authenticated spool corruption fails closed", async (t) => {
  const fixture = await spoolFixture(t);
  await fixture.spool.append(started);
  const fileName = (await readdir(fixture.directory)).find((name) => name.endsWith(".spool"));
  assert.ok(fileName);
  const path = join(fixture.directory, fileName);
  const ciphertext = await readFile(path);
  ciphertext[ciphertext.length - 1] = ciphertext[ciphertext.length - 1]! ^ 0xff;
  await writeFile(path, ciphertext);

  await assert.rejects(fixture.spool.list(), SpoolCorruptionError);
});

test("database integrity failures fail closed and never enter the outage spool", async (t) => {
  const fixture = await spoolFixture(t);
  const journal = new MemoryJournal();
  journal.online = false;
  journal.errorCode = "23503";
  const durable = new DurableJournalSink({ journal, spool: fixture.spool });

  await assert.rejects(durable.append(started), DurableJournalError);
  assert.deepEqual(await fixture.spool.stats(), { entries: 0, bytes: 0 });
});

class MemoryCheckpoints implements CheckpointStore {
  checkpoint?: ConsumerCheckpoint;
  failNextAdvance = false;

  async get(_consumerName: string): Promise<ConsumerCheckpoint | undefined> {
    return this.checkpoint;
  }

  async advance(input: {
    consumerName: string;
    journalSeq: number;
    eventId: string;
    updatedAt: string;
  }): Promise<boolean> {
    if (this.failNextAdvance) {
      this.failNextAdvance = false;
      throw new Error("simulated process loss before checkpoint commit");
    }
    if (this.checkpoint && this.checkpoint.journalSeq >= input.journalSeq) return false;
    this.checkpoint = input;
    return true;
  }
}

test("consumer restart replays delivery and advances only after an idempotent handler", async () => {
  const journal = new MemoryJournal();
  await journal.appendWithOutbox(started);
  const checkpoints = new MemoryCheckpoints();
  checkpoints.failNextAdvance = true;
  const consumer = new JournalConsumer({
    name: "search-index",
    journal,
    checkpoints,
    now: () => occurredAt,
  });
  const handlerCalls: string[] = [];
  const sideEffects = new Set<string>();
  const handler = ({ deliveryId }: { deliveryId: string }) => {
    handlerCalls.push(deliveryId);
    sideEffects.add(deliveryId);
  };

  await assert.rejects(consumer.drain(handler), /simulated process loss/);
  assert.equal(checkpoints.checkpoint, undefined);
  assert.equal(await consumer.drain(handler), 1);

  assert.deepEqual(handlerCalls, ["event-0", "event-0"]);
  assert.deepEqual([...sideEffects], ["event-0"]);
  const savedCheckpoint = await checkpoints.get("search-index");
  assert.equal(savedCheckpoint?.eventId, "event-0");
});
