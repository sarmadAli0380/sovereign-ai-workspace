import type { AttachmentObjectStore } from "./attachments.ts";
import {
  ERASURE_STORES,
  type ErasureJob,
  type ErasureRepository,
  type ErasureScope,
  type ErasureStore,
} from "./repositories/work.ts";

export interface ErasureStoreAdapter {
  readonly store: ErasureStore;
  erase(scope: ErasureScope): Promise<void>;
  /** Returns metadata-only identifiers for content still reachable in this store. */
  findResidue(scope: ErasureScope): Promise<readonly string[]>;
}

export interface ErasureControlStore {
  get(id: string): Promise<ErasureJob | undefined>;
  getScope(id: string): Promise<ErasureScope>;
  begin(id: string): Promise<void>;
  beginTarget(id: string, store: ErasureStore): Promise<void>;
  verifyTarget(id: string, store: ErasureStore, verifiedAt: string): Promise<void>;
  failTarget(id: string, store: ErasureStore, errorCode: string): Promise<void>;
  beginReconciliation(id: string): Promise<void>;
  complete(id: string, completedAt: string): Promise<void>;
}

export class ErasureError extends Error {
  readonly code: string;

  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "ErasureError";
    this.code = code;
  }
}

export class ErasureVerificationError extends ErasureError {
  readonly store: ErasureStore;
  readonly residueCount: number;

  constructor(store: ErasureStore, residueCount: number) {
    super("erasure.residue-found");
    this.name = "ErasureVerificationError";
    this.store = store;
    this.residueCount = residueCount;
  }
}

/**
 * Runs every configured store in dependency order and then repeats all public
 * absence checks. Completion is impossible unless all seven adapters prove no
 * retrievable residue.
 */
export class ErasureCoordinator {
  readonly #repository: ErasureControlStore;
  readonly #adapters: ReadonlyMap<ErasureStore, ErasureStoreAdapter>;
  readonly #clock: () => string;

  constructor(options: {
    repository: ErasureControlStore;
    adapters: readonly ErasureStoreAdapter[];
    clock?: () => string;
  }) {
    this.#repository = options.repository;
    const adapters = new Map<ErasureStore, ErasureStoreAdapter>();
    for (const adapter of options.adapters) {
      if (!ERASURE_STORES.includes(adapter.store)) {
        throw new TypeError("erasure adapter store is not supported");
      }
      if (adapters.has(adapter.store)) {
        throw new TypeError(`duplicate erasure adapter for ${adapter.store}`);
      }
      adapters.set(adapter.store, adapter);
    }
    const missing = ERASURE_STORES.filter((store) => !adapters.has(store));
    if (missing.length > 0) {
      throw new TypeError(`missing erasure adapters: ${missing.join(", ")}`);
    }
    this.#adapters = adapters;
    this.#clock = options.clock ?? (() => new Date().toISOString());
  }

  async process(jobId: string): Promise<ErasureJob> {
    const initial = await this.#repository.get(jobId);
    if (!initial) throw new ErasureError("erasure.job-not-found");
    if (initial.status === "completed") return initial;
    const scope = await this.#repository.getScope(initial.id);
    await this.#repository.begin(initial.id);

    for (const store of ERASURE_STORES) {
      const adapter = this.#adapters.get(store)!;
      try {
        await this.#repository.beginTarget(initial.id, store);
        await adapter.erase(scope);
        await this.#verifyAdapter(adapter, scope);
        await this.#repository.verifyTarget(initial.id, store, this.#clock());
      } catch (cause) {
        await this.#repository.failTarget(initial.id, store, errorCode(cause));
        throw cause;
      }
    }

    await this.#repository.beginReconciliation(initial.id);
    for (const store of ERASURE_STORES) {
      const adapter = this.#adapters.get(store)!;
      try {
        await this.#verifyAdapter(adapter, scope);
        await this.#repository.verifyTarget(initial.id, store, this.#clock());
      } catch (cause) {
        await this.#repository.failTarget(initial.id, store, errorCode(cause));
        throw cause;
      }
    }
    await this.#repository.complete(initial.id, this.#clock());
    const completed = await this.#repository.get(initial.id);
    if (!completed || completed.status !== "completed") {
      throw new ErasureError("erasure.completion-not-durable");
    }
    return completed;
  }

  async #verifyAdapter(adapter: ErasureStoreAdapter, scope: ErasureScope): Promise<void> {
    const residue = await adapter.findResidue(scope);
    if (!Array.isArray(residue)) {
      throw new ErasureError("erasure.verification-invalid");
    }
    if (residue.length > 0) {
      throw new ErasureVerificationError(adapter.store, residue.length);
    }
  }
}

export class SqlErasureStoreAdapter implements ErasureStoreAdapter {
  readonly store: "postgres" | "embeddings" | "search";
  readonly #repository: Pick<ErasureRepository, "eraseSqlStore" | "findSqlResidue">;

  constructor(
    repository: Pick<ErasureRepository, "eraseSqlStore" | "findSqlResidue">,
    store: "postgres" | "embeddings" | "search",
  ) {
    this.#repository = repository;
    this.store = store;
  }

  async erase(scope: ErasureScope): Promise<void> {
    await this.#repository.eraseSqlStore(scope.jobId, this.store);
  }

  async findResidue(scope: ErasureScope): Promise<readonly string[]> {
    return this.#repository.findSqlResidue(scope.jobId, this.store);
  }
}

export class AttachmentErasureStoreAdapter implements ErasureStoreAdapter {
  readonly store = "attachments" as const;
  readonly #repository: Pick<ErasureRepository, "markAttachmentDeleted">;
  readonly #objectStore: Pick<AttachmentObjectStore, "delete" | "exists">;

  constructor(options: {
    repository: Pick<ErasureRepository, "markAttachmentDeleted">;
    objectStore: Pick<AttachmentObjectStore, "delete" | "exists">;
  }) {
    this.#repository = options.repository;
    this.#objectStore = options.objectStore;
  }

  async erase(scope: ErasureScope): Promise<void> {
    for (const attachment of scope.attachments) {
      await this.#objectStore.delete(attachment.objectKey);
    }
    await this.#repository.markAttachmentDeleted(scope.jobId);
  }

  async findResidue(scope: ErasureScope): Promise<readonly string[]> {
    const residue: string[] = [];
    for (const attachment of scope.attachments) {
      if (await this.#objectStore.exists(attachment.objectKey)) {
        residue.push(`attachment:${attachment.attachmentId}`);
      }
    }
    return residue;
  }
}

function errorCode(cause: unknown): string {
  if (cause instanceof ErasureError && safeCode(cause.code)) return cause.code;
  if (
    typeof cause === "object" && cause !== null &&
    typeof (cause as { code?: unknown }).code === "string" &&
    (cause as { code: string }).code.length > 0
  ) {
    const code = (cause as { code: string }).code;
    if (safeCode(code)) return code;
  }
  return "erasure.store-failed";
}

function safeCode(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value);
}
