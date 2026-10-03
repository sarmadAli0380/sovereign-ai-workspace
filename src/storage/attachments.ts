import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  type ReadStream,
} from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { StoredAttachment } from "./repositories/entities.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const OBJECT_KEY = /^sha256\/([a-f0-9]{2})\/([a-f0-9]{64})\/([a-f0-9]{32})$/;
const SUPPORTED_MIME_TYPES = new Set([
  "application/json",
  "application/pdf",
  "image/jpeg",
  "image/png",
  "text/plain",
]);

export class AttachmentError extends Error {
  readonly code: string;

  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "AttachmentError";
    this.code = code;
  }
}

export interface AttachmentAccessRequest {
  actorId: string;
  conversationId: string;
  attachmentId?: string;
  operation: "upload" | "read" | "delete";
}

export interface AttachmentAccessController {
  authorize(request: AttachmentAccessRequest): Promise<boolean>;
}

export interface StagedAttachment {
  readonly path: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly mimeType: string;
}

export interface AttachmentObjectRead {
  objectKey: string;
  sha256: string;
  byteSize: number;
  maxBytes: number;
  signal?: AbortSignal;
}

export interface AttachmentObjectStore {
  commit(input: StagedAttachment & { objectKey: string; signal?: AbortSignal }): Promise<void>;
  read(input: AttachmentObjectRead): Promise<Uint8Array>;
  delete(objectKey: string): Promise<void>;
  exists(objectKey: string): Promise<boolean>;
}

export interface AttachmentMetadataStore {
  create(input: {
    id: string;
    conversationId: string;
    messageId?: string;
    objectKey: string;
    sha256: string;
    byteSize: number;
    mimeType: string;
    originalName?: string;
    state?: "staging" | "available";
    createdAt: string;
  }): Promise<void>;
  get(id: string): Promise<StoredAttachment | undefined>;
  tombstoneAndEnqueueDeletion(input: {
    id: string;
    outboxJobId: string;
    tombstonedAt: string;
  }): Promise<boolean>;
  markDeleted(id: string): Promise<boolean>;
}

function positiveInteger(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${path} must be a positive safe integer`);
  }
  return value;
}

function nonEmpty(value: string, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value;
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new AttachmentError("attachment.aborted");
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function normalizeMimeType(value: string): string {
  const mimeType = nonEmpty(value, "attachment.mimeType").trim().toLowerCase();
  if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
    throw new AttachmentError("attachment.mime-unsupported");
  }
  return mimeType;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new AttachmentError("attachment.mime-mismatch", { cause });
  }
}

function validateMimeType(bytes: Uint8Array, declared: string): string {
  const mimeType = normalizeMimeType(declared);
  const startsWith = (...signature: number[]) =>
    signature.every((value, index) => bytes[index] === value);
  let detected: string | undefined;
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    detected = "image/png";
  } else if (startsWith(0xff, 0xd8, 0xff)) {
    detected = "image/jpeg";
  } else if (startsWith(0x25, 0x50, 0x44, 0x46, 0x2d)) {
    detected = "application/pdf";
  }
  if (detected !== undefined) {
    if (detected !== mimeType) throw new AttachmentError("attachment.mime-mismatch");
    return detected;
  }
  const text = decodeUtf8(bytes);
  if (mimeType === "application/json") {
    try {
      JSON.parse(text);
    } catch (cause) {
      throw new AttachmentError("attachment.mime-mismatch", { cause });
    }
    return mimeType;
  }
  if (mimeType === "text/plain") {
    if (/\0|[\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
      throw new AttachmentError("attachment.mime-mismatch");
    }
    return mimeType;
  }
  throw new AttachmentError("attachment.mime-mismatch");
}

function validateOriginalName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (
    value.length === 0 || value.length > 255 || /[\u0000-\u001f\u007f]/.test(value) ||
    value.includes("/") || value.includes("\\") || value === "." || value === ".."
  ) {
    throw new AttachmentError("attachment.name-invalid");
  }
  return value;
}

function parseObjectKey(value: string): { hash: string } {
  const match = OBJECT_KEY.exec(value);
  if (!match || match[1] !== match[2]!.slice(0, 2)) {
    throw new AttachmentError("attachment.object-key-invalid");
  }
  return { hash: match[2]! };
}

function objectKeyFor(sha256: string, attachmentId: string): string {
  if (!SHA256.test(sha256)) throw new TypeError("attachment.sha256 is invalid");
  const recordSuffix = createHash("sha256").update(attachmentId).digest("hex").slice(0, 32);
  return `sha256/${sha256.slice(0, 2)}/${sha256}/${recordSuffix}`;
}

function attachmentIdFor(sha256: string, requested: string | undefined, generated: () => string): string {
  const prefix = `sha256:${sha256}:`;
  const id = requested ?? `${prefix}${nonEmpty(generated(), "attachment.generatedId")}`;
  if (!id.startsWith(prefix) || !/^[A-Za-z0-9._:-]{1,255}$/.test(id)) {
    throw new AttachmentError("attachment.id-not-content-addressed");
  }
  return id;
}

async function collect(
  source: AsyncIterable<Uint8Array>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of source) {
    abortIfNeeded(signal);
    if (!(chunk instanceof Uint8Array)) throw new TypeError("attachment chunk must be bytes");
    size += chunk.byteLength;
    if (size > maxBytes) throw new AttachmentError("attachment.read-too-large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset, null);
    if (bytesWritten === 0) throw new AttachmentError("attachment.staging-write-failed");
    offset += bytesWritten;
  }
}

async function verifyStaged(input: StagedAttachment): Promise<void> {
  if (!SHA256.test(input.sha256) || !Number.isSafeInteger(input.byteSize) || input.byteSize < 0) {
    throw new AttachmentError("attachment.integrity-failed");
  }
  const info = await lstat(input.path);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== input.byteSize) {
    throw new AttachmentError("attachment.integrity-failed");
  }
  const bytes = await readFile(input.path);
  if (createHash("sha256").update(bytes).digest("hex") !== input.sha256) {
    throw new AttachmentError("attachment.integrity-failed");
  }
}

export class AttachmentQuarantine {
  readonly directory: string;

  private constructor(directory: string) {
    this.directory = directory;
  }

  static async create(directory: string): Promise<AttachmentQuarantine> {
    nonEmpty(directory, "attachment.quarantineDirectory");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const canonical = await realpath(directory);
    if (!(await stat(canonical)).isDirectory()) {
      throw new TypeError("attachment quarantine must be a directory");
    }
    return new AttachmentQuarantine(canonical);
  }

  async stage(input: {
    source: Uint8Array | AsyncIterable<Uint8Array>;
    mimeType: string;
    maxBytes: number;
    signal?: AbortSignal;
  }): Promise<StagedAttachment> {
    const maxBytes = positiveInteger(input.maxBytes, "attachment.maxBytes");
    normalizeMimeType(input.mimeType);
    abortIfNeeded(input.signal);
    const path = join(this.directory, `.${randomUUID()}.quarantine`);
    const handle = await open(path, "wx", 0o600);
    const hash = createHash("sha256");
    let byteSize = 0;
    try {
      const source: AsyncIterable<Uint8Array> = input.source instanceof Uint8Array
        ? (async function* () { yield input.source as Uint8Array; })()
        : input.source;
      for await (const chunk of source) {
        abortIfNeeded(input.signal);
        if (!(chunk instanceof Uint8Array)) throw new TypeError("attachment chunk must be bytes");
        byteSize += chunk.byteLength;
        if (byteSize > maxBytes) throw new AttachmentError("attachment.upload-too-large");
        hash.update(chunk);
        await writeAll(handle, chunk);
      }
      abortIfNeeded(input.signal);
      await handle.sync();
      await handle.close();
      const bytes = await readFile(path, { signal: input.signal });
      const mimeType = validateMimeType(bytes, input.mimeType);
      return { path, sha256: hash.digest("hex"), byteSize, mimeType };
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(path).catch((cleanupError: NodeJS.ErrnoException) => {
        if (cleanupError.code !== "ENOENT") throw cleanupError;
      });
      throw error;
    }
  }

  async cleanup(staged: StagedAttachment): Promise<void> {
    const canonicalParent = await realpath(this.directory);
    const candidate = resolve(staged.path);
    if (!isWithin(canonicalParent, candidate)) {
      throw new AttachmentError("attachment.quarantine-path-invalid");
    }
    await unlink(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export class LocalAttachmentObjectStore implements AttachmentObjectStore {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async create(root: string): Promise<LocalAttachmentObjectStore> {
    nonEmpty(root, "attachment.objectRoot");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const canonical = await realpath(root);
    if (!(await stat(canonical)).isDirectory()) {
      throw new TypeError("attachment object root must be a directory");
    }
    return new LocalAttachmentObjectStore(canonical);
  }

  async commit(input: StagedAttachment & { objectKey: string; signal?: AbortSignal }): Promise<void> {
    abortIfNeeded(input.signal);
    const { hash } = parseObjectKey(input.objectKey);
    if (hash !== input.sha256) throw new AttachmentError("attachment.integrity-failed");
    await verifyStaged(input);
    const target = resolve(this.root, input.objectKey);
    if (!isWithin(this.root, target)) throw new AttachmentError("attachment.object-key-invalid");
    const parent = resolve(target, "..");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const canonicalParent = await realpath(parent);
    if (!isWithin(this.root, canonicalParent)) {
      throw new AttachmentError("attachment.object-key-invalid");
    }
    abortIfNeeded(input.signal);
    try {
      await link(input.path, target);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw new AttachmentError("attachment.object-conflict", { cause });
      if (code === "EXDEV") throw new AttachmentError("attachment.staging-filesystem-mismatch", { cause });
      throw cause;
    }
  }

  async read(input: AttachmentObjectRead): Promise<Uint8Array> {
    const { hash } = parseObjectKey(input.objectKey);
    if (hash !== input.sha256 || !SHA256.test(input.sha256)) {
      throw new AttachmentError("attachment.integrity-failed");
    }
    positiveInteger(input.maxBytes, "attachment.maxReadBytes");
    abortIfNeeded(input.signal);
    const lexical = resolve(this.root, input.objectKey);
    if (!isWithin(this.root, lexical)) throw new AttachmentError("attachment.object-key-invalid");
    let canonical: string;
    try {
      canonical = await realpath(lexical);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        throw new AttachmentError("attachment.object-missing", { cause });
      }
      throw cause;
    }
    if (!isWithin(this.root, canonical)) throw new AttachmentError("attachment.object-key-invalid");
    const [lexicalInfo, info] = await Promise.all([lstat(lexical), lstat(canonical)]);
    if (lexicalInfo.isSymbolicLink() || !info.isFile()) {
      throw new AttachmentError("attachment.object-invalid");
    }
    if (info.size !== input.byteSize) throw new AttachmentError("attachment.integrity-failed");
    if (info.size > input.maxBytes) throw new AttachmentError("attachment.read-too-large");
    const bytes = await readFile(canonical, { signal: input.signal });
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== input.sha256) throw new AttachmentError("attachment.integrity-failed");
    return bytes;
  }

  async delete(objectKey: string): Promise<void> {
    parseObjectKey(objectKey);
    const lexical = resolve(this.root, objectKey);
    if (!isWithin(this.root, lexical)) throw new AttachmentError("attachment.object-key-invalid");
    let canonical: string;
    try {
      canonical = await realpath(lexical);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw cause;
    }
    if (!isWithin(this.root, canonical)) throw new AttachmentError("attachment.object-key-invalid");
    const [lexicalInfo, info] = await Promise.all([lstat(lexical), lstat(canonical)]);
    if (lexicalInfo.isSymbolicLink() || !info.isFile()) {
      throw new AttachmentError("attachment.object-invalid");
    }
    await unlink(canonical);
  }

  async exists(objectKey: string): Promise<boolean> {
    parseObjectKey(objectKey);
    const lexical = resolve(this.root, objectKey);
    if (!isWithin(this.root, lexical)) throw new AttachmentError("attachment.object-key-invalid");
    let canonical: string;
    try {
      canonical = await realpath(lexical);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw cause;
    }
    if (!isWithin(this.root, canonical)) throw new AttachmentError("attachment.object-key-invalid");
    const [lexicalInfo, canonicalInfo] = await Promise.all([lstat(lexical), lstat(canonical)]);
    if (lexicalInfo.isSymbolicLink() || !canonicalInfo.isFile()) {
      throw new AttachmentError("attachment.object-invalid");
    }
    return true;
  }
}

export interface S3CompatibleClient {
  putObject(input: {
    key: string;
    body: AsyncIterable<Uint8Array>;
    contentLength: number;
    contentType: string;
    checksumSha256: string;
    ifNoneMatch: "*";
    signal?: AbortSignal;
  }): Promise<void>;
  getObject(input: {
    key: string;
    signal?: AbortSignal;
  }): Promise<{ body: AsyncIterable<Uint8Array>; contentLength?: number }>;
  deleteObject(input: { key: string }): Promise<void>;
  headObject(input: { key: string }): Promise<boolean>;
}

export class S3CompatibleAttachmentObjectStore implements AttachmentObjectStore {
  readonly client: S3CompatibleClient;
  readonly keyPrefix: string;

  constructor(
    client: S3CompatibleClient,
    keyPrefix = "attachments/",
  ) {
    if (keyPrefix.startsWith("/") || keyPrefix.includes("..")) {
      throw new TypeError("attachment S3 key prefix is invalid");
    }
    this.client = client;
    this.keyPrefix = keyPrefix;
  }

  async commit(input: StagedAttachment & { objectKey: string; signal?: AbortSignal }): Promise<void> {
    const { hash } = parseObjectKey(input.objectKey);
    if (hash !== input.sha256) throw new AttachmentError("attachment.integrity-failed");
    abortIfNeeded(input.signal);
    await verifyStaged(input);
    const stream: ReadStream = createReadStream(input.path, { signal: input.signal });
    await this.client.putObject({
      key: `${this.keyPrefix}${input.objectKey}`,
      body: stream,
      contentLength: input.byteSize,
      contentType: input.mimeType,
      checksumSha256: Buffer.from(input.sha256, "hex").toString("base64"),
      ifNoneMatch: "*",
      signal: input.signal,
    });
  }

  async read(input: AttachmentObjectRead): Promise<Uint8Array> {
    const { hash } = parseObjectKey(input.objectKey);
    if (hash !== input.sha256) throw new AttachmentError("attachment.integrity-failed");
    const maxBytes = positiveInteger(input.maxBytes, "attachment.maxReadBytes");
    const response = await this.client.getObject({
      key: `${this.keyPrefix}${input.objectKey}`,
      signal: input.signal,
    });
    if (response.contentLength !== undefined && response.contentLength !== input.byteSize) {
      throw new AttachmentError("attachment.integrity-failed");
    }
    const bytes = await collect(response.body, maxBytes, input.signal);
    if (bytes.byteLength !== input.byteSize) throw new AttachmentError("attachment.integrity-failed");
    if (createHash("sha256").update(bytes).digest("hex") !== input.sha256) {
      throw new AttachmentError("attachment.integrity-failed");
    }
    return bytes;
  }

  async delete(objectKey: string): Promise<void> {
    parseObjectKey(objectKey);
    await this.client.deleteObject({ key: `${this.keyPrefix}${objectKey}` });
  }

  async exists(objectKey: string): Promise<boolean> {
    parseObjectKey(objectKey);
    return this.client.headObject({ key: `${this.keyPrefix}${objectKey}` });
  }
}

export interface AttachmentReadResult {
  attachment: StoredAttachment;
  bytes: Uint8Array;
}

export interface AttachmentServiceOptions {
  repository: AttachmentMetadataStore;
  quarantine: AttachmentQuarantine;
  objectStore: AttachmentObjectStore;
  access: AttachmentAccessController;
  maxUploadBytes: number;
  maxReadBytes?: number;
  idFactory?: () => string;
  clock?: () => string;
}

export class AttachmentService {
  readonly #repository: AttachmentMetadataStore;
  readonly #quarantine: AttachmentQuarantine;
  readonly #objectStore: AttachmentObjectStore;
  readonly #access: AttachmentAccessController;
  readonly #maxUploadBytes: number;
  readonly #maxReadBytes: number;
  readonly #idFactory: () => string;
  readonly #clock: () => string;

  constructor(options: AttachmentServiceOptions) {
    this.#repository = options.repository;
    this.#quarantine = options.quarantine;
    this.#objectStore = options.objectStore;
    this.#access = options.access;
    this.#maxUploadBytes = positiveInteger(options.maxUploadBytes, "attachment.maxUploadBytes");
    this.#maxReadBytes = positiveInteger(
      options.maxReadBytes ?? options.maxUploadBytes,
      "attachment.maxReadBytes",
    );
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#clock = options.clock ?? (() => new Date().toISOString());
  }

  async ingest(input: {
    actorId: string;
    conversationId: string;
    messageId?: string;
    attachmentId?: string;
    originalName?: string;
    mimeType: string;
    source: Uint8Array | AsyncIterable<Uint8Array>;
    signal?: AbortSignal;
  }): Promise<StoredAttachment & { contentId: string }> {
    const actorId = nonEmpty(input.actorId, "attachment.actorId");
    const conversationId = nonEmpty(input.conversationId, "attachment.conversationId");
    if (!await this.#access.authorize({ actorId, conversationId, operation: "upload" })) {
      throw new AttachmentError("attachment.access-denied");
    }
    const originalName = validateOriginalName(input.originalName);
    const staged = await this.#quarantine.stage({
      source: input.source,
      mimeType: input.mimeType,
      maxBytes: this.#maxUploadBytes,
      signal: input.signal,
    });
    let committed = false;
    let stagedCleaned = false;
    let objectKey: string | undefined;
    try {
      const attachmentId = attachmentIdFor(staged.sha256, input.attachmentId, this.#idFactory);
      objectKey = objectKeyFor(staged.sha256, attachmentId);
      const createdAt = this.#clock();
      await this.#objectStore.commit({ ...staged, objectKey, signal: input.signal });
      committed = true;
      await this.#quarantine.cleanup(staged);
      stagedCleaned = true;
      await this.#repository.create({
        id: attachmentId,
        conversationId,
        messageId: input.messageId,
        objectKey,
        sha256: staged.sha256,
        byteSize: staged.byteSize,
        mimeType: staged.mimeType,
        originalName,
        state: "available",
        createdAt,
      });
      return {
        id: attachmentId,
        conversationId,
        ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
        objectKey,
        sha256: staged.sha256,
        byteSize: staged.byteSize,
        mimeType: staged.mimeType,
        ...(originalName === undefined ? {} : { originalName }),
        state: "available",
        createdAt,
        contentId: `sha256:${staged.sha256}`,
      };
    } catch (error) {
      if (committed && objectKey !== undefined) await this.#objectStore.delete(objectKey);
      throw error;
    } finally {
      if (!stagedCleaned) await this.#quarantine.cleanup(staged);
    }
  }

  async read(input: {
    actorId: string;
    attachmentId: string;
    maxBytes?: number;
    signal?: AbortSignal;
  }): Promise<AttachmentReadResult> {
    const attachment = await this.#repository.get(nonEmpty(input.attachmentId, "attachment.id"));
    if (!attachment) throw new AttachmentError("attachment.not-found");
    const actorId = nonEmpty(input.actorId, "attachment.actorId");
    if (!await this.#access.authorize({
      actorId,
      conversationId: attachment.conversationId,
      attachmentId: attachment.id,
      operation: "read",
    })) {
      throw new AttachmentError("attachment.access-denied");
    }
    if (attachment.state !== "available") throw new AttachmentError("attachment.not-found");
    const maxBytes = input.maxBytes === undefined
      ? this.#maxReadBytes
      : Math.min(positiveInteger(input.maxBytes, "attachment.maxReadBytes"), this.#maxReadBytes);
    const bytes = await this.#objectStore.read({
      objectKey: attachment.objectKey,
      sha256: attachment.sha256,
      byteSize: attachment.byteSize,
      maxBytes,
      signal: input.signal,
    });
    return { attachment, bytes };
  }

  async requestDeletion(input: {
    actorId: string;
    attachmentId: string;
    outboxJobId?: string;
  }): Promise<boolean> {
    const attachment = await this.#repository.get(nonEmpty(input.attachmentId, "attachment.id"));
    if (!attachment) throw new AttachmentError("attachment.not-found");
    const actorId = nonEmpty(input.actorId, "attachment.actorId");
    if (!await this.#access.authorize({
      actorId,
      conversationId: attachment.conversationId,
      attachmentId: attachment.id,
      operation: "delete",
    })) {
      throw new AttachmentError("attachment.access-denied");
    }
    if (attachment.state !== "available") return false;
    return this.#repository.tombstoneAndEnqueueDeletion({
      id: attachment.id,
      outboxJobId: input.outboxJobId ?? randomUUID(),
      tombstonedAt: this.#clock(),
    });
  }

  async processDeletion(attachmentId: string): Promise<boolean> {
    const attachment = await this.#repository.get(nonEmpty(attachmentId, "attachment.id"));
    if (!attachment || attachment.state === "deleted") return false;
    if (attachment.state !== "tombstoned") {
      throw new AttachmentError("attachment.delete-not-tombstoned");
    }
    await this.#objectStore.delete(attachment.objectKey);
    return this.#repository.markDeleted(attachment.id);
  }
}

export interface AttachmentProcessingLimits {
  maxOutputs: number;
  maxOutputBytes: number;
  maxTotalOutputBytes: number;
  maxArchiveEntries: number;
  maxCompressionRatio: number;
}

export interface AttachmentDerivative {
  path: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface AttachmentProcessorResult {
  derivatives: readonly AttachmentDerivative[];
  archiveEntriesProcessed?: number;
}

export interface AttachmentProcessor {
  readonly mimeTypes: readonly string[];
  readonly library: { name: string; version: string };
  process(input: {
    bytes: Uint8Array;
    mimeType: string;
    limits: Readonly<AttachmentProcessingLimits>;
    signal?: AbortSignal;
  }): Promise<AttachmentProcessorResult>;
}

function safeDerivativePath(path: string): boolean {
  if (path.length === 0 || path.includes("\0") || path.includes("\\") || isAbsolute(path)) return false;
  const segments = path.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export class AttachmentProcessorRegistry {
  readonly #processors = new Map<string, AttachmentProcessor>();

  constructor(processors: readonly AttachmentProcessor[]) {
    for (const processor of processors) {
      nonEmpty(processor.library.name, "attachment.processor.library.name");
      nonEmpty(processor.library.version, "attachment.processor.library.version");
      for (const mimeType of processor.mimeTypes) {
        const normalized = nonEmpty(mimeType, "attachment.processor.mimeType").toLowerCase();
        if (this.#processors.has(normalized)) {
          throw new TypeError(`duplicate attachment processor for ${normalized}`);
        }
        this.#processors.set(normalized, processor);
      }
    }
  }

  get(mimeType: string): AttachmentProcessor {
    const processor = this.#processors.get(mimeType.toLowerCase());
    if (!processor) throw new AttachmentError("attachment.processor-unavailable");
    return processor;
  }
}

export class AttachmentProcessingService {
  readonly #attachments: AttachmentService;
  readonly #processors: AttachmentProcessorRegistry;
  readonly #limits: Readonly<AttachmentProcessingLimits>;

  constructor(options: {
    attachments: AttachmentService;
    processors: AttachmentProcessorRegistry;
    limits: AttachmentProcessingLimits;
  }) {
    this.#attachments = options.attachments;
    this.#processors = options.processors;
    this.#limits = Object.freeze({
      maxOutputs: positiveInteger(options.limits.maxOutputs, "attachment.processing.maxOutputs"),
      maxOutputBytes: positiveInteger(options.limits.maxOutputBytes, "attachment.processing.maxOutputBytes"),
      maxTotalOutputBytes: positiveInteger(
        options.limits.maxTotalOutputBytes,
        "attachment.processing.maxTotalOutputBytes",
      ),
      maxArchiveEntries: positiveInteger(
        options.limits.maxArchiveEntries,
        "attachment.processing.maxArchiveEntries",
      ),
      maxCompressionRatio: positiveInteger(
        options.limits.maxCompressionRatio,
        "attachment.processing.maxCompressionRatio",
      ),
    });
  }

  async process(input: {
    actorId: string;
    attachmentId: string;
    signal?: AbortSignal;
  }): Promise<readonly AttachmentDerivative[]> {
    const { attachment, bytes } = await this.#attachments.read(input);
    const processor = this.#processors.get(attachment.mimeType);
    const result = await processor.process({
      bytes,
      mimeType: attachment.mimeType,
      limits: this.#limits,
      signal: input.signal,
    });
    if (typeof result !== "object" || result === null || !Array.isArray(result.derivatives)) {
      throw new AttachmentError("attachment.processing-result-invalid");
    }
    if (result.derivatives.length > this.#limits.maxOutputs) {
      throw new AttachmentError("attachment.processing-output-limit");
    }
    const archiveEntries = result.archiveEntriesProcessed ?? 0;
    if (!Number.isSafeInteger(archiveEntries) || archiveEntries < 0) {
      throw new AttachmentError("attachment.processing-result-invalid");
    }
    if (archiveEntries > this.#limits.maxArchiveEntries) {
      throw new AttachmentError("attachment.processing-entry-limit");
    }
    let total = 0;
    for (const derivative of result.derivatives) {
      if (typeof derivative !== "object" || derivative === null) {
        throw new AttachmentError("attachment.processing-result-invalid");
      }
      if (typeof derivative.path !== "string" || !safeDerivativePath(derivative.path)) {
        throw new AttachmentError("attachment.processing-path-invalid");
      }
      nonEmpty(derivative.mimeType, "attachment.derivative.mimeType");
      if (!(derivative.bytes instanceof Uint8Array)) {
        throw new TypeError("attachment derivative must contain bytes");
      }
      if (derivative.bytes.byteLength > this.#limits.maxOutputBytes) {
        throw new AttachmentError("attachment.processing-output-limit");
      }
      total += derivative.bytes.byteLength;
      if (total > this.#limits.maxTotalOutputBytes) {
        throw new AttachmentError("attachment.processing-total-limit");
      }
    }
    if (bytes.byteLength === 0 ? total > 0 : total / bytes.byteLength > this.#limits.maxCompressionRatio) {
      throw new AttachmentError("attachment.processing-ratio-limit");
    }
    return result.derivatives.map((derivative) => ({
      path: derivative.path,
      mimeType: derivative.mimeType,
      bytes: Uint8Array.from(derivative.bytes),
    }));
  }
}
