import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AttachmentError,
  AttachmentProcessingService,
  AttachmentProcessorRegistry,
  AttachmentQuarantine,
  AttachmentService,
  LocalAttachmentObjectStore,
  S3CompatibleAttachmentObjectStore,
  type AttachmentAccessController,
  type AttachmentAccessRequest,
  type AttachmentMetadataStore,
  type AttachmentObjectStore,
  type S3CompatibleClient,
} from "./attachments.ts";
import { AttachmentRepository, type StoredAttachment } from "./repositories/entities.ts";
import type { SqlExecutor, SqlQueryResult } from "./sql.ts";

const timestamp = "2026-08-21T08:00:00.000Z";

class MemoryMetadataStore implements AttachmentMetadataStore {
  readonly records = new Map<string, StoredAttachment>();
  readonly deletionJobs: string[] = [];
  failCreate = false;

  async create(input: Parameters<AttachmentMetadataStore["create"]>[0]): Promise<void> {
    if (this.failCreate) throw new Error("metadata unavailable");
    if (this.records.has(input.id)) throw new Error("duplicate attachment");
    this.records.set(input.id, {
      id: input.id,
      conversationId: input.conversationId,
      ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
      objectKey: input.objectKey,
      sha256: input.sha256,
      byteSize: input.byteSize,
      mimeType: input.mimeType,
      ...(input.originalName === undefined ? {} : { originalName: input.originalName }),
      state: input.state ?? "available",
      createdAt: input.createdAt,
    });
  }

  async get(id: string): Promise<StoredAttachment | undefined> {
    const record = this.records.get(id);
    return record === undefined ? undefined : { ...record };
  }

  async tombstoneAndEnqueueDeletion(
    input: Parameters<AttachmentMetadataStore["tombstoneAndEnqueueDeletion"]>[0],
  ): Promise<boolean> {
    const record = this.records.get(input.id);
    if (!record || record.state !== "available") return false;
    this.records.set(input.id, {
      ...record,
      state: "tombstoned",
      tombstonedAt: input.tombstonedAt,
    });
    this.deletionJobs.push(input.outboxJobId);
    return true;
  }

  async markDeleted(id: string): Promise<boolean> {
    const record = this.records.get(id);
    if (!record || record.state !== "tombstoned") return false;
    this.records.set(id, { ...record, state: "deleted" });
    return true;
  }
}

class RecordingAccess implements AttachmentAccessController {
  readonly requests: AttachmentAccessRequest[] = [];
  deniedOperations = new Set<AttachmentAccessRequest["operation"]>();

  async authorize(request: AttachmentAccessRequest): Promise<boolean> {
    this.requests.push(request);
    return !this.deniedOperations.has(request.operation);
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sovereign-attachments-"));
  const quarantine = await AttachmentQuarantine.create(join(root, "quarantine"));
  const objectStore = await LocalAttachmentObjectStore.create(join(root, "objects"));
  const repository = new MemoryMetadataStore();
  const access = new RecordingAccess();
  const service = new AttachmentService({
    repository,
    quarantine,
    objectStore,
    access,
    maxUploadBytes: 1_024,
    maxReadBytes: 1_024,
    idFactory: () => "record-1",
    clock: () => timestamp,
  });
  return { root, quarantine, objectStore, repository, access, service };
}

test("ingestion uses a content-bound identity and removes quarantine files", async (context) => {
  const item = await fixture();
  context.after(() => rm(item.root, { recursive: true, force: true }));
  const source = Buffer.from("sovereign attachment", "utf8");
  const hash = createHash("sha256").update(source).digest("hex");

  const stored = await item.service.ingest({
    actorId: "user-1",
    conversationId: "conversation-1",
    originalName: "notes.txt",
    mimeType: "text/plain",
    source,
  });

  assert.equal(stored.id, `sha256:${hash}:record-1`);
  assert.equal(stored.contentId, `sha256:${hash}`);
  assert.match(stored.objectKey, new RegExp(`^sha256/${hash.slice(0, 2)}/${hash}/[a-f0-9]{32}$`));
  assert.deepEqual(await readdir(item.quarantine.directory), []);
  const loaded = await item.service.read({ actorId: "user-1", attachmentId: stored.id });
  assert.equal(Buffer.from(loaded.bytes).toString("utf8"), "sovereign attachment");
  assert.deepEqual(item.access.requests.map((request) => request.operation), ["upload", "read"]);

  await assert.rejects(
    item.service.ingest({
      actorId: "user-1",
      conversationId: "conversation-1",
      attachmentId: "legacy-random-id",
      mimeType: "text/plain",
      source: Buffer.from("other"),
    }),
    (error: unknown) =>
      error instanceof AttachmentError && error.code === "attachment.id-not-content-addressed",
  );
  assert.deepEqual(await readdir(item.quarantine.directory), []);
});

test("quarantine rejects excess bytes and MIME mismatch without leaving temporary files", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "sovereign-quarantine-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const quarantine = await AttachmentQuarantine.create(root);
  async function* chunks() {
    yield Buffer.from("1234");
    yield Buffer.from("5678");
  }

  await assert.rejects(
    quarantine.stage({ source: chunks(), mimeType: "text/plain", maxBytes: 6 }),
    (error: unknown) => error instanceof AttachmentError && error.code === "attachment.upload-too-large",
  );
  await assert.rejects(
    quarantine.stage({
      source: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      mimeType: "application/pdf",
      maxBytes: 20,
    }),
    (error: unknown) => error instanceof AttachmentError && error.code === "attachment.mime-mismatch",
  );
  assert.deepEqual(await readdir(root), []);
});

test("a metadata failure removes both the staged name and unpublished object", async (context) => {
  const item = await fixture();
  context.after(() => rm(item.root, { recursive: true, force: true }));
  item.repository.failCreate = true;

  await assert.rejects(
    item.service.ingest({
      actorId: "user-1",
      conversationId: "conversation-1",
      mimeType: "text/plain",
      source: Buffer.from("rollback"),
    }),
    /metadata unavailable/,
  );
  assert.deepEqual(await readdir(item.quarantine.directory), []);
  const objectEntries = await readdir(item.objectStore.root, { recursive: true });
  const objectFiles = [];
  for (const entry of objectEntries) {
    if ((await lstat(join(item.objectStore.root, entry))).isFile()) objectFiles.push(entry);
  }
  assert.deepEqual(objectFiles, []);
});

test("every existing attachment read is authorized before object storage access", async (context) => {
  const item = await fixture();
  context.after(() => rm(item.root, { recursive: true, force: true }));
  const stored = await item.service.ingest({
    actorId: "user-1",
    conversationId: "conversation-1",
    mimeType: "text/plain",
    source: Buffer.from("private"),
  });
  let reads = 0;
  const guardedStore: AttachmentObjectStore = {
    commit: (input) => item.objectStore.commit(input),
    read: (input) => { reads += 1; return item.objectStore.read(input); },
    delete: (key) => item.objectStore.delete(key),
    exists: (key) => item.objectStore.exists(key),
  };
  const guarded = new AttachmentService({
    repository: item.repository,
    quarantine: item.quarantine,
    objectStore: guardedStore,
    access: item.access,
    maxUploadBytes: 1_024,
    clock: () => timestamp,
  });
  item.access.deniedOperations.add("read");

  await assert.rejects(
    guarded.read({ actorId: "user-2", attachmentId: stored.id }),
    (error: unknown) => error instanceof AttachmentError && error.code === "attachment.access-denied",
  );
  assert.equal(reads, 0);
  assert.equal(item.access.requests.at(-1)?.operation, "read");
});

test("local reads reject tampering, traversal keys, and symlink substitution", async (context) => {
  const item = await fixture();
  context.after(() => rm(item.root, { recursive: true, force: true }));
  const stored = await item.service.ingest({
    actorId: "user-1",
    conversationId: "conversation-1",
    mimeType: "text/plain",
    source: Buffer.from("original"),
  });
  const objectPath = join(item.objectStore.root, stored.objectKey);
  await writeFile(objectPath, "tampered", { mode: 0o600 });
  await assert.rejects(
    item.service.read({ actorId: "user-1", attachmentId: stored.id }),
    (error: unknown) => error instanceof AttachmentError && error.code === "attachment.integrity-failed",
  );
  await assert.rejects(
    item.objectStore.read({
      objectKey: "../outside",
      sha256: stored.sha256,
      byteSize: stored.byteSize,
      maxBytes: 100,
    }),
    (error: unknown) => error instanceof AttachmentError && error.code === "attachment.object-key-invalid",
  );

  const target = join(item.root, "same-size-target");
  await writeFile(target, "original");
  await unlink(objectPath);
  await symlink(target, objectPath);
  await assert.rejects(
    item.service.read({ actorId: "user-1", attachmentId: stored.id }),
    (error: unknown) => error instanceof AttachmentError &&
      ["attachment.object-invalid", "attachment.object-key-invalid"].includes(error.code),
  );
});

test("S3-compatible storage sends immutable checksum metadata and verifies downloads", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "sovereign-s3-stage-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const quarantine = await AttachmentQuarantine.create(root);
  const objects = new Map<string, Uint8Array>();
  const puts: { key: string; checksum: string; ifNoneMatch: string }[] = [];
  const client: S3CompatibleClient = {
    async putObject(input) {
      const chunks: Buffer[] = [];
      for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      if (objects.has(input.key)) throw new Error("precondition failed");
      objects.set(input.key, bytes);
      puts.push({ key: input.key, checksum: input.checksumSha256, ifNoneMatch: input.ifNoneMatch });
    },
    async getObject(input) {
      const bytes = objects.get(input.key);
      if (!bytes) throw new Error("missing");
      return { body: (async function* () { yield bytes; })(), contentLength: bytes.byteLength };
    },
    async deleteObject(input) { objects.delete(input.key); },
    async headObject(input) { return objects.has(input.key); },
  };
  const store = new S3CompatibleAttachmentObjectStore(client, "tenant-a/");
  const staged = await quarantine.stage({
    source: Buffer.from("remote"),
    mimeType: "text/plain",
    maxBytes: 100,
  });
  const objectKey = `sha256/${staged.sha256.slice(0, 2)}/${staged.sha256}/${"a".repeat(32)}`;
  await store.commit({ ...staged, objectKey });
  const loaded = await store.read({ ...staged, objectKey, maxBytes: 100 });

  assert.equal(Buffer.from(loaded).toString(), "remote");
  assert.equal(puts[0]?.ifNoneMatch, "*");
  assert.equal(puts[0]?.checksum, Buffer.from(staged.sha256, "hex").toString("base64"));
  assert.equal(await store.exists(objectKey), true);
  await store.delete(objectKey);
  assert.equal(await store.exists(objectKey), false);
  await quarantine.cleanup(staged);
});

test("deletion is authorized, tombstoned with an outbox job, and idempotently applied", async (context) => {
  const item = await fixture();
  context.after(() => rm(item.root, { recursive: true, force: true }));
  const stored = await item.service.ingest({
    actorId: "user-1",
    conversationId: "conversation-1",
    mimeType: "text/plain",
    source: Buffer.from("delete me"),
  });

  assert.equal(await item.service.requestDeletion({
    actorId: "user-1",
    attachmentId: stored.id,
    outboxJobId: "delete-job-1",
  }), true);
  await assert.rejects(
    item.service.read({ actorId: "user-1", attachmentId: stored.id }),
    (error: unknown) => error instanceof AttachmentError && error.code === "attachment.not-found",
  );
  assert.deepEqual(item.repository.deletionJobs, ["delete-job-1"]);
  assert.equal(await item.service.processDeletion(stored.id), true);
  assert.equal(await item.service.processDeletion(stored.id), false);
  assert.equal(item.repository.records.get(stored.id)?.state, "deleted");
});

test("processor adapters declare a library and cannot emit unsafe or excessive output", async (context) => {
  const item = await fixture();
  context.after(() => rm(item.root, { recursive: true, force: true }));
  const stored = await item.service.ingest({
    actorId: "user-1",
    conversationId: "conversation-1",
    mimeType: "text/plain",
    source: Buffer.from("input"),
  });
  assert.throws(
    () => new AttachmentProcessorRegistry([{
      mimeTypes: ["text/plain"],
      library: { name: "", version: "1.0.0" },
      async process() { return { derivatives: [] }; },
    }]),
    /library.name must be a non-empty string/,
  );
  const processors = new AttachmentProcessorRegistry([{
    mimeTypes: ["text/plain"],
    library: { name: "maintained-parser", version: "1.2.3" },
    async process() {
      return { derivatives: [{ path: "../escape.txt", mimeType: "text/plain", bytes: Buffer.from("x") }] };
    },
  }]);
  const processing = new AttachmentProcessingService({
    attachments: item.service,
    processors,
    limits: {
      maxOutputs: 2,
      maxOutputBytes: 20,
      maxTotalOutputBytes: 20,
      maxArchiveEntries: 10,
      maxCompressionRatio: 4,
    },
  });
  await assert.rejects(
    processing.process({ actorId: "user-1", attachmentId: stored.id }),
    (error: unknown) =>
      error instanceof AttachmentError && error.code === "attachment.processing-path-invalid",
  );
});

class RecordingExecutor implements SqlExecutor {
  readonly calls: { sql: string; values: readonly unknown[] }[] = [];
  readonly results: SqlQueryResult[] = [];

  async query(sql: string, values: readonly unknown[] = []): Promise<SqlQueryResult> {
    this.calls.push({ sql, values });
    return this.results.shift() ?? { rows: [], rowCount: 0 };
  }
}

test("attachment tombstone and deletion outbox enqueue use one parameterized statement", async () => {
  const database = new RecordingExecutor();
  database.results.push({ rows: [{ id: "attachment-1" }], rowCount: 1 });
  const repository = new AttachmentRepository(database);

  assert.equal(await repository.tombstoneAndEnqueueDeletion({
    id: "attachment-1",
    outboxJobId: "job-1",
    tombstonedAt: timestamp,
  }), true);
  assert.equal(database.calls.length, 1);
  assert.match(database.calls[0]!.sql, /^WITH tombstoned AS/);
  assert.match(database.calls[0]!.sql, /attachment\.delete\.requested/);
  assert.match(database.calls[0]!.sql, /jsonb_build_object\('attachmentId', id\)/);
  assert.deepEqual(database.calls[0]!.values, ["attachment-1", timestamp, "job-1"]);
});

test("attachment metadata creation binds an optional message to its conversation", async () => {
  const database = new RecordingExecutor();
  database.results.push({ rows: [{ id: "attachment-1" }], rowCount: 1 });
  const repository = new AttachmentRepository(database);
  await repository.create({
    id: "attachment-1",
    conversationId: "conversation-1",
    messageId: "message-1",
    objectKey: `sha256/${"a".repeat(2)}/${"a".repeat(64)}/${"b".repeat(32)}`,
    sha256: "a".repeat(64),
    byteSize: 4,
    mimeType: "text/plain",
    createdAt: timestamp,
  });
  assert.match(database.calls[0]!.sql, /messages WHERE id = \$3 AND conversation_id = \$2/);
  assert.match(database.calls[0]!.sql, /RETURNING id/);

  database.results.push({ rows: [], rowCount: 0 });
  await assert.rejects(
    repository.create({
      id: "attachment-2",
      conversationId: "conversation-1",
      messageId: "message-from-other-conversation",
      objectKey: `sha256/${"c".repeat(2)}/${"c".repeat(64)}/${"d".repeat(32)}`,
      sha256: "c".repeat(64),
      byteSize: 4,
      mimeType: "text/plain",
      createdAt: timestamp,
    }),
    /create attachment expected exactly one row, received 0/,
  );
});
