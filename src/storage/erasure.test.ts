import assert from "node:assert/strict";
import test from "node:test";
import {
  ERASURE_STORES,
  type ErasureJob,
  type ErasureScope,
  type ErasureStore,
  type ErasureTarget,
} from "./repositories/work.ts";
import {
  ErasureCoordinator,
  ErasureVerificationError,
  type ErasureControlStore,
  type ErasureStoreAdapter,
} from "./erasure.ts";

const timestamp = "2026-08-21T12:00:00.000Z";

class MemoryControlStore implements ErasureControlStore {
  status: ErasureJob["status"] = "pending";
  completed = false;
  readonly errorCodes: string[] = [];
  readonly targetStates = new Map<ErasureStore, ErasureTarget["status"]>(
    ERASURE_STORES.map((store) => [store, "pending"]),
  );
  readonly events: string[] = [];

  readonly scope: ErasureScope = {
    jobId: "erasure-1",
    subjectType: "conversation",
    subjectId: "conversation-1",
    conversationIds: ["conversation-1"],
    messageIds: ["message-1"],
    attachments: [],
    knowledgeSourceIds: ["source-1"],
  };

  async get(id: string): Promise<ErasureJob | undefined> {
    if (id !== this.scope.jobId) return undefined;
    return {
      id,
      subjectType: this.scope.subjectType,
      subjectId: this.scope.subjectId,
      reasonCode: "retention.expired",
      status: this.status,
      requestedAt: timestamp,
      ...(this.completed ? { completedAt: timestamp } : {}),
      targets: ERASURE_STORES.map((store) => ({
        store,
        status: this.targetStates.get(store)!,
        attempts: 1,
        ...(this.targetStates.get(store) === "verified" ? { verifiedAt: timestamp } : {}),
      })),
    };
  }

  async getScope(): Promise<ErasureScope> { return this.scope; }
  async begin(): Promise<void> { this.status = "processing"; this.events.push("job:processing"); }
  async beginTarget(_id: string, store: ErasureStore): Promise<void> {
    this.targetStates.set(store, "processing");
    this.events.push(`${store}:processing`);
  }
  async verifyTarget(_id: string, store: ErasureStore): Promise<void> {
    this.targetStates.set(store, "verified");
    this.events.push(`${store}:verified`);
  }
  async failTarget(_id: string, store: ErasureStore, errorCode: string): Promise<void> {
    this.targetStates.set(store, "failed");
    this.status = "failed";
    this.errorCodes.push(errorCode);
    this.events.push(`${store}:failed`);
  }
  async beginReconciliation(): Promise<void> {
    this.status = "reconciling";
    this.events.push("job:reconciling");
  }
  async complete(): Promise<void> {
    assert.deepEqual(
      ERASURE_STORES.map((store) => this.targetStates.get(store)),
      ERASURE_STORES.map(() => "verified"),
    );
    this.status = "completed";
    this.completed = true;
    this.events.push("job:completed");
  }
}

function adapters(options: {
  residue?: Partial<Record<ErasureStore, readonly string[]>>;
  residueOnReconcile?: Partial<Record<ErasureStore, readonly string[]>>;
  events?: string[];
} = {}): ErasureStoreAdapter[] {
  return ERASURE_STORES.map((store) => {
    let checks = 0;
    return {
      store,
      async erase() { options.events?.push(`${store}:erase`); },
      async findResidue() {
        checks += 1;
        options.events?.push(`${store}:verify:${checks}`);
        return checks === 1
          ? options.residue?.[store] ?? []
          : options.residueOnReconcile?.[store] ?? [];
      },
    };
  });
}

test("B6 requires one explicit adapter for every data-bearing store", () => {
  const repository = new MemoryControlStore();
  assert.throws(
    () => new ErasureCoordinator({
      repository,
      adapters: adapters().slice(0, -1),
    }),
    /missing erasure adapters: postgres/,
  );
  assert.throws(
    () => new ErasureCoordinator({
      repository,
      adapters: [...adapters(), adapters()[0]!],
    }),
    /duplicate erasure adapter for attachments/,
  );
});

test("B6 erases in dependency order, reconciles every store, then completes", async () => {
  const repository = new MemoryControlStore();
  const adapterEvents: string[] = [];
  const coordinator = new ErasureCoordinator({
    repository,
    adapters: adapters({ events: adapterEvents }),
    clock: () => timestamp,
  });

  const result = await coordinator.process("erasure-1");

  assert.equal(result.status, "completed");
  assert.deepEqual(
    adapterEvents.filter((event) => event.endsWith(":erase")),
    ERASURE_STORES.map((store) => `${store}:erase`),
  );
  assert.deepEqual(
    adapterEvents.filter((event) => event.endsWith(":verify:2")),
    ERASURE_STORES.map((store) => `${store}:verify:2`),
  );
  assert.equal(repository.events.at(-1), "job:completed");
});

test("B6 never advances past a store whose retrieval path still finds residue", async () => {
  const repository = new MemoryControlStore();
  const adapterEvents: string[] = [];
  const coordinator = new ErasureCoordinator({
    repository,
    adapters: adapters({
      residue: { search: ["chunk:still-retrievable"] },
      events: adapterEvents,
    }),
    clock: () => timestamp,
  });

  await assert.rejects(
    coordinator.process("erasure-1"),
    (error: unknown) =>
      error instanceof ErasureVerificationError &&
      error.store === "search" && error.residueCount === 1,
  );
  assert.equal(repository.status, "failed");
  assert.equal(repository.targetStates.get("search"), "failed");
  assert.equal(adapterEvents.includes("cache:erase"), false);
  assert.equal(repository.completed, false);
});

test("B6 reconciliation catches residue that reappears after a target passed", async () => {
  const repository = new MemoryControlStore();
  const coordinator = new ErasureCoordinator({
    repository,
    adapters: adapters({
      residueOnReconcile: { cache: ["cache:reappeared"] },
    }),
    clock: () => timestamp,
  });

  await assert.rejects(
    coordinator.process("erasure-1"),
    (error: unknown) =>
      error instanceof ErasureVerificationError && error.store === "cache",
  );
  assert.equal(repository.status, "failed");
  assert.equal(repository.targetStates.get("cache"), "failed");
  assert.equal(repository.completed, false);
});

test("B6 never persists arbitrary downstream error text as an error code", async () => {
  const repository = new MemoryControlStore();
  const failing = adapters();
  failing[0] = {
    store: "attachments",
    async erase() {
      throw { code: "secret attachment content must not become metadata" };
    },
    async findResidue() { return []; },
  };
  const coordinator = new ErasureCoordinator({ repository, adapters: failing });

  await assert.rejects(coordinator.process("erasure-1"));

  assert.deepEqual(repository.errorCodes, ["erasure.store-failed"]);
});
