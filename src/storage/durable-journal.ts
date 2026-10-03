import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { RunEventSink } from "../event-transport.ts";
import { parseRunEvent, type RunEvent } from "../events.ts";
import type {
  ConsumerCheckpoint,
  ConsumerCheckpointRepository,
} from "./repositories/work.ts";
import type {
  EventJournalRepository,
  JournalAppendResult,
  StoredJournalEvent,
} from "./repositories/journal.ts";

const SPOOL_MAGIC = Buffer.from("SAISPOOL1", "ascii");
const SPOOL_AAD = Buffer.from("sovereign-ai:event-spool:v1", "ascii");
const SPOOL_IV_BYTES = 12;
const SPOOL_TAG_BYTES = 16;
const SPOOL_FILE = /^[a-f0-9]{16}-\d{16}-[a-f0-9]{16}\.spool$/;

export class SpoolCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpoolCapacityError";
  }
}

export class SpoolCorruptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SpoolCorruptionError";
  }
}

export class DurableJournalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DurableJournalError";
  }
}

export class DurableJournalUnavailableError extends DurableJournalError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DurableJournalUnavailableError";
  }
}

export interface EncryptedEventSpoolOptions {
  directory: string;
  /** A deployment-owned 256-bit key. It must not be stored in the spool directory. */
  key: Uint8Array;
  maxEntries: number;
  maxBytes: number;
}

export interface EventSpoolEntry {
  fileName: string;
  byteSize: number;
  event: RunEvent;
}

export interface EventSpoolStats {
  entries: number;
  bytes: number;
}

function positiveSafeInteger(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${path} must be a positive safe integer`);
  }
  return value;
}

function sha256Prefix(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function eventFileName(event: RunEvent): string {
  return [
    sha256Prefix(event.runId),
    String(event.sequence).padStart(16, "0"),
    sha256Prefix(event.eventId),
  ].join("-") + ".spool";
}

export class EncryptedEventSpool {
  readonly #directory: string;
  readonly #key: Buffer;
  readonly #maxEntries: number;
  readonly #maxBytes: number;

  constructor(options: EncryptedEventSpoolOptions) {
    if (typeof options.directory !== "string" || options.directory.length === 0) {
      throw new TypeError("spool.directory must be a non-empty string");
    }
    if (options.key.byteLength !== 32) {
      throw new TypeError("spool.key must contain exactly 32 bytes");
    }
    this.#directory = resolve(options.directory);
    this.#key = Buffer.from(options.key);
    this.#maxEntries = positiveSafeInteger(options.maxEntries, "spool.maxEntries");
    this.#maxBytes = positiveSafeInteger(options.maxBytes, "spool.maxBytes");
  }

  async append(value: RunEvent): Promise<"stored" | "duplicate"> {
    const event = parseRunEvent(value);
    if (event.type === "message.delta") {
      throw new TypeError("ephemeral message.delta events cannot enter the durable spool");
    }
    await this.#ensureDirectory();
    const fileName = eventFileName(event);
    const target = join(this.#directory, fileName);
    try {
      const existing = await lstat(target);
      if (!existing.isFile() || existing.isSymbolicLink()) {
        throw new SpoolCorruptionError(`spool entry ${fileName} is not a regular file`);
      }
      const decoded = this.#decrypt(await readFile(target), fileName);
      if (decoded.eventId !== event.eventId || decoded.runId !== event.runId || decoded.sequence !== event.sequence) {
        throw new SpoolCorruptionError(`spool entry ${fileName} does not match its deterministic identity`);
      }
      return "duplicate";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const encoded = this.#encrypt(event);
    const current = await this.stats();
    if (current.entries >= this.#maxEntries || current.bytes + encoded.byteLength > this.#maxBytes) {
      throw new SpoolCapacityError(
        `encrypted event spool capacity exhausted (${current.entries}/${this.#maxEntries} entries, ${current.bytes}/${this.#maxBytes} bytes)`,
      );
    }

    const temporary = join(this.#directory, `.${fileName}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let renamed = false;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(encoded);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, target);
      renamed = true;
      await chmod(target, 0o600);
      const directoryHandle = await open(this.#directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
      return "stored";
    } finally {
      await handle?.close().catch(() => undefined);
      if (!renamed) await unlink(temporary).catch(() => undefined);
    }
  }

  async list(): Promise<EventSpoolEntry[]> {
    await this.#ensureDirectory();
    const directoryEntries = await readdir(this.#directory, { withFileTypes: true });
    const entries: EventSpoolEntry[] = [];
    for (const item of directoryEntries) {
      if (!SPOOL_FILE.test(item.name)) continue;
      if (!item.isFile() || item.isSymbolicLink()) {
        throw new SpoolCorruptionError(`spool entry ${item.name} is not a regular file`);
      }
      const path = join(this.#directory, item.name);
      const [data, metadata] = await Promise.all([readFile(path), stat(path)]);
      entries.push({
        fileName: item.name,
        byteSize: metadata.size,
        event: this.#decrypt(data, item.name),
      });
    }
    entries.sort((left, right) =>
      left.event.runId.localeCompare(right.event.runId)
      || left.event.sequence - right.event.sequence
      || left.event.eventId.localeCompare(right.event.eventId));
    const eventIds = new Set<string>();
    const lastSequenceByRun = new Map<string, number>();
    for (const entry of entries) {
      if (eventIds.has(entry.event.eventId)) {
        throw new SpoolCorruptionError(`duplicate spooled eventId ${entry.event.eventId}`);
      }
      eventIds.add(entry.event.eventId);
      const previous = lastSequenceByRun.get(entry.event.runId);
      if (previous !== undefined && entry.event.sequence <= previous) {
        throw new SpoolCorruptionError(`spooled run ${entry.event.runId} is not strictly ordered`);
      }
      lastSequenceByRun.set(entry.event.runId, entry.event.sequence);
    }
    return entries;
  }

  async remove(entry: EventSpoolEntry): Promise<void> {
    if (basename(entry.fileName) !== entry.fileName || !SPOOL_FILE.test(entry.fileName)) {
      throw new TypeError("spool entry fileName is invalid");
    }
    await unlink(join(this.#directory, entry.fileName));
  }

  async stats(): Promise<EventSpoolStats> {
    await this.#ensureDirectory();
    const directoryEntries = await readdir(this.#directory, { withFileTypes: true });
    let entries = 0;
    let bytes = 0;
    for (const item of directoryEntries) {
      if (!SPOOL_FILE.test(item.name)) continue;
      if (!item.isFile() || item.isSymbolicLink()) {
        throw new SpoolCorruptionError(`spool entry ${item.name} is not a regular file`);
      }
      entries += 1;
      bytes += (await stat(join(this.#directory, item.name))).size;
    }
    return { entries, bytes };
  }

  async #ensureDirectory(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.#directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new SpoolCorruptionError("spool.directory must be a real directory, not a symbolic link");
    }
    await chmod(this.#directory, 0o700);
  }

  #encrypt(event: RunEvent): Buffer {
    const iv = randomBytes(SPOOL_IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(SPOOL_AAD);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(event), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([SPOOL_MAGIC, iv, cipher.getAuthTag(), ciphertext]);
  }

  #decrypt(value: Buffer, fileName: string): RunEvent {
    const minimum = SPOOL_MAGIC.length + SPOOL_IV_BYTES + SPOOL_TAG_BYTES + 1;
    if (value.byteLength < minimum || !value.subarray(0, SPOOL_MAGIC.length).equals(SPOOL_MAGIC)) {
      throw new SpoolCorruptionError(`spool entry ${fileName} has an invalid envelope`);
    }
    const ivStart = SPOOL_MAGIC.length;
    const tagStart = ivStart + SPOOL_IV_BYTES;
    const contentStart = tagStart + SPOOL_TAG_BYTES;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key, value.subarray(ivStart, tagStart));
      decipher.setAAD(SPOOL_AAD);
      decipher.setAuthTag(value.subarray(tagStart, contentStart));
      const plaintext = Buffer.concat([
        decipher.update(value.subarray(contentStart)),
        decipher.final(),
      ]).toString("utf8");
      return parseRunEvent(JSON.parse(plaintext));
    } catch (cause) {
      throw new SpoolCorruptionError(`spool entry ${fileName} failed authenticated decryption`, { cause });
    }
  }
}

export interface JournalWriter {
  appendWithOutbox(event: RunEvent): Promise<JournalAppendResult>;
}

export interface JournalReader {
  listAfter(journalSeq: number, limit?: number): Promise<StoredJournalEvent[]>;
}

export interface CheckpointStore {
  get(consumerName: string): Promise<ConsumerCheckpoint | undefined>;
  advance(input: {
    consumerName: string;
    journalSeq: number;
    eventId: string;
    updatedAt: string;
  }): Promise<boolean>;
}

const DATABASE_UNAVAILABLE_CODES = new Set([
  "08000", "08001", "08003", "08004", "08006",
  "53300", "53400", "57P01", "57P02", "57P03",
  "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "ETIMEDOUT",
]);

export function isDatabaseUnavailableError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && DATABASE_UNAVAILABLE_CODES.has(code)) return true;
  const cause = (error as { cause?: unknown }).cause;
  return cause !== undefined && cause !== error && isDatabaseUnavailableError(cause);
}

export interface DurableJournalSinkOptions {
  journal: JournalWriter | EventJournalRepository;
  spool?: EncryptedEventSpool;
  isDatabaseUnavailable?: (error: unknown) => boolean;
}

export class DurableJournalSink {
  readonly sink: RunEventSink;
  readonly #journal: JournalWriter;
  readonly #spool?: EncryptedEventSpool;
  readonly #isDatabaseUnavailable: (error: unknown) => boolean;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: DurableJournalSinkOptions) {
    this.#journal = options.journal;
    this.#spool = options.spool;
    this.#isDatabaseUnavailable = options.isDatabaseUnavailable ?? isDatabaseUnavailableError;
    this.sink = (event) => this.append(event);
  }

  append(value: RunEvent): Promise<void> {
    const event = parseRunEvent(value);
    if (event.type === "message.delta") return Promise.resolve();
    const operation = this.#tail.then(() => this.#appendOne(event));
    this.#tail = operation.catch(() => undefined);
    return operation;
  }

  flush(): Promise<number> {
    const operation = this.#tail.then(async () => {
      try {
        return await this.#flushSpool();
      } catch (cause) {
        if (this.#isDatabaseUnavailable(cause)) {
          throw new DurableJournalUnavailableError("database unavailable while replaying the event spool", { cause });
        }
        throw new DurableJournalError("event spool replay failed", { cause });
      }
    });
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #appendOne(event: RunEvent): Promise<void> {
    try {
      await this.#flushSpool();
      await this.#journal.appendWithOutbox(event);
      return;
    } catch (cause) {
      if (!this.#isDatabaseUnavailable(cause)) {
        throw new DurableJournalError("durable journal write failed", { cause });
      }
      if (!this.#spool) {
        throw new DurableJournalUnavailableError("database unavailable and no event spool is configured", { cause });
      }
      try {
        await this.#spool.append(event);
      } catch (spoolCause) {
        throw new DurableJournalUnavailableError(
          "database unavailable and the encrypted event spool rejected the event",
          { cause: spoolCause },
        );
      }
    }
  }

  async #flushSpool(): Promise<number> {
    if (!this.#spool) return 0;
    const entries = await this.#spool.list();
    let replayed = 0;
    for (const entry of entries) {
      await this.#journal.appendWithOutbox(entry.event);
      await this.#spool.remove(entry);
      replayed += 1;
    }
    return replayed;
  }
}

export interface JournalDelivery {
  deliveryId: string;
  journalSeq: number;
  event: RunEvent;
}

export interface JournalConsumerOptions {
  name: string;
  journal: JournalReader | EventJournalRepository;
  checkpoints: CheckpointStore | ConsumerCheckpointRepository;
  batchSize?: number;
  now?: () => string;
}

export class JournalConsumer {
  readonly #name: string;
  readonly #journal: JournalReader;
  readonly #checkpoints: CheckpointStore;
  readonly #batchSize: number;
  readonly #now: () => string;

  constructor(options: JournalConsumerOptions) {
    if (typeof options.name !== "string" || options.name.length === 0) {
      throw new TypeError("consumer.name must be a non-empty string");
    }
    this.#name = options.name;
    this.#journal = options.journal;
    this.#checkpoints = options.checkpoints;
    this.#batchSize = positiveSafeInteger(options.batchSize ?? 100, "consumer.batchSize");
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async drain(handler: (delivery: JournalDelivery) => void | Promise<void>): Promise<number> {
    const checkpoint = await this.#checkpoints.get(this.#name);
    let cursor = checkpoint?.journalSeq ?? 0;
    let delivered = 0;
    for (;;) {
      const batch = await this.#journal.listAfter(cursor, this.#batchSize);
      if (batch.length === 0) return delivered;
      for (const item of batch) {
        await handler({
          deliveryId: item.event.eventId,
          journalSeq: item.journalSeq,
          event: item.event,
        });
        const updatedAt = this.#now();
        if (Number.isNaN(Date.parse(updatedAt))) {
          throw new TypeError("consumer.now() must return an RFC 3339 timestamp");
        }
        await this.#checkpoints.advance({
          consumerName: this.#name,
          journalSeq: item.journalSeq,
          eventId: item.event.eventId,
          updatedAt: new Date(updatedAt).toISOString(),
        });
        cursor = item.journalSeq;
        delivered += 1;
      }
      if (batch.length < this.#batchSize) return delivered;
    }
  }
}
