import assert from "node:assert/strict";
import test from "node:test";
import {
  checkpointForRunEvent,
  encodeRunEventSse,
  eventsAfterCheckpoint,
  parseRunEventSseData,
  RunEventTransport,
  RunEventTransportError,
  runEventToSseFrame,
} from "./event-transport.ts";
import {
  RUN_EVENT_SCHEMA_VERSION,
  RUN_EVENT_SENSITIVITY,
  RunEventValidationError,
  type RunEventOf,
  type RunEventPayloadMap,
  type RunEventType,
} from "./events.ts";

const occurredAt = "2026-08-10T12:00:00.000Z";

function event<TType extends RunEventType>(
  type: TType,
  payload: RunEventPayloadMap[TType],
  sequence: number,
  overrides: Partial<RunEventOf<TType>> = {},
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
    ...overrides,
  } as RunEventOf<TType>;
}

const started = event(
  "run.started",
  { configKey: "local-qwen", provider: "ollama", model: "qwen3:4b" },
  10,
);
const turnStarted = event("turn.started", {}, 20);
const completed = event("run.completed", { reason: "stop" }, 30);

async function collect(transport: RunEventTransport): Promise<RunEventType[]> {
  const types: RunEventType[] = [];
  for await (const item of transport) types.push(item.type);
  return types;
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("in-process AsyncIterable delivers a run in publication order", async () => {
  const transport = new RunEventTransport();
  const received = collect(transport);

  await Promise.all([
    transport.publish(started),
    transport.publish(turnStarted),
    transport.publish(completed),
  ]);
  await transport.close();

  assert.deepEqual(await received, ["run.started", "turn.started", "run.completed"]);
});

test("a required sink is ordered and acknowledged before live delivery", async () => {
  const gate = deferred();
  const persisted: string[] = [];
  const transport = new RunEventTransport({
    requiredSink: async (item) => {
      persisted.push(item.eventId);
      if (item.eventId === started.eventId) await gate.promise;
    },
  });
  const iterator = transport[Symbol.asyncIterator]();
  const firstPublication = transport.publish(started);
  const secondPublication = transport.publish(turnStarted);
  const firstRead = iterator.next();

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(persisted, [started.eventId]);

  gate.resolve();
  await Promise.all([firstPublication, secondPublication]);
  assert.deepEqual(persisted, [started.eventId, turnStarted.eventId]);
  assert.deepEqual(await firstRead, { done: false, value: started });
  assert.deepEqual(await iterator.next(), { done: false, value: turnStarted });
  await iterator.return?.();
});

test("publication snapshots isolate caller, required sink, and live consumer mutations", async () => {
  const gate = deferred();
  const mutable = event(
    "run.started",
    { configKey: "local", provider: "ollama", model: "original" },
    1,
  );
  const transport = new RunEventTransport({
    requiredSink: async (item) => {
      (item.payload as { model: string }).model = "sink-mutated";
      await gate.promise;
    },
  });
  const iterator = transport[Symbol.asyncIterator]();
  const publication = transport.publish(mutable);
  mutable.payload.model = "caller-mutated";
  gate.resolve();

  await publication;
  const delivered = await iterator.next();
  assert.equal(delivered.done, false);
  assert.equal(delivered.value?.type, "run.started");
  if (delivered.value?.type !== "run.started") assert.fail("expected run.started");
  assert.equal(delivered.value.payload.model, "original");
  await iterator.return?.();
});

test("required-sink failure rejects publication and exposes no event", async () => {
  const failure = new Error("journal unavailable");
  const transport = new RunEventTransport({
    requiredSink: async () => {
      throw failure;
    },
  });
  const iterator = transport[Symbol.asyncIterator]();

  await assert.rejects(
    transport.publish(started),
    (error: unknown) =>
      error instanceof RunEventTransportError && error.cause === failure,
  );
  await transport.close();
  await assert.rejects(iterator.next(), (error: unknown) => error === failure);
});

test("failure state is explicit even when the thrown value is undefined", async () => {
  const transport = new RunEventTransport({
    requiredSink: () => Promise.reject(undefined),
  });

  await assert.rejects(transport.publish(started), RunEventTransportError);
  await assert.rejects(transport.publish(turnStarted), /event transport has failed/);
  await transport.close();
});

test("slow optional observers are bounded and never block publication", async () => {
  const gate = deferred();
  const observed: string[] = [];
  const transport = new RunEventTransport({
    observers: [
      {
        name: "metrics",
        maxPending: 1,
        sink: async (item) => {
          observed.push(item.eventId);
          await gate.promise;
        },
      },
    ],
  });

  await transport.publish(started);
  await transport.publish(turnStarted);
  assert.deepEqual(observed, [started.eventId]);
  assert.deepEqual(transport.observerFailures, [
    {
      observer: "metrics",
      eventId: turnStarted.eventId,
      sequence: turnStarted.sequence,
      reason: "buffer-full",
    },
  ]);

  gate.resolve();
  await transport.waitForObservers();
});

test("optional observer failures are reported without rejecting publish", async () => {
  const failure = new Error("telemetry offline");
  const reported: string[] = [];
  const transport = new RunEventTransport({
    observers: [
      {
        name: "telemetry",
        maxPending: 2,
        sink: async () => {
          throw failure;
        },
      },
    ],
    onObserverFailure: (item) => reported.push(`${item.observer}:${item.reason}`),
  });

  await transport.publish(started);
  await transport.waitForObservers();
  assert.deepEqual(reported, ["telemetry:sink-failed"]);
  assert.equal(transport.observerFailures[0]?.cause, failure);
});

test("publication enforces live run ordering and terminal invariants", async () => {
  const wrongFirst = new RunEventTransport();
  await assert.rejects(
    wrongFirst.publish(turnStarted),
    (error: unknown) =>
      error instanceof RunEventValidationError && error.message.includes("first event"),
  );

  const transport = new RunEventTransport();
  await transport.publish(started);
  await transport.publish(completed);
  await assert.rejects(
    transport.publish(event("turn.started", {}, 40)),
    (error: unknown) =>
      error instanceof RunEventValidationError && error.message.includes("terminal event"),
  );
});

test("the live stream has one consumer so events are not load-balanced accidentally", () => {
  const transport = new RunEventTransport();
  transport[Symbol.asyncIterator]();
  assert.throws(
    () => transport[Symbol.asyncIterator](),
    /supports one consumer/,
  );
});

test("checkpoint reconnect resumes strictly after a stable event identity", () => {
  const events = [started, turnStarted, completed] as const;
  const checkpoint = checkpointForRunEvent(turnStarted);

  assert.deepEqual(checkpoint, {
    runId: "run-1",
    eventId: turnStarted.eventId,
    sequence: 20,
  });
  assert.deepEqual(eventsAfterCheckpoint(events, checkpoint), [completed]);
  assert.throws(
    () => eventsAfterCheckpoint(events, { ...checkpoint, sequence: 21 }),
    /does not match the stored event/,
  );
  assert.throws(
    () => eventsAfterCheckpoint(events, { ...checkpoint, eventId: "expired" }),
    /is not available/,
  );
  assert.throws(
    () =>
      eventsAfterCheckpoint(
        [started, turnStarted, event("run.completed", { reason: "stop" }, 19)],
        checkpoint,
      ),
    /not strictly ordered/,
  );
});

test("SSE mapping uses eventId for Last-Event-ID and round-trips canonical data", () => {
  const frame = runEventToSseFrame(turnStarted);
  assert.equal(frame.id, turnStarted.eventId);
  assert.equal(frame.event, "turn.started");
  assert.deepEqual(parseRunEventSseData(frame.data), turnStarted);
  assert.equal(
    encodeRunEventSse(turnStarted),
    `id: ${turnStarted.eventId}\nevent: turn.started\ndata: ${JSON.stringify(turnStarted)}\n\n`,
  );
});

test("SSE mapping rejects line-break injection through an event id", () => {
  const injected = event(
    "run.started",
    { configKey: "local", provider: "ollama", model: "qwen" },
    1,
    { eventId: "safe\nevent: injected" },
  );
  assert.throws(() => runEventToSseFrame(injected), /invalid SSE control character/);
  assert.throws(
    () => runEventToSseFrame({ ...injected, eventId: "not\0checkpointable" }),
    /invalid SSE control character/,
  );
});

test("optional observer configuration rejects non-finite and non-positive bounds", () => {
  for (const maxPending of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    assert.throws(
      () =>
        new RunEventTransport({
          observers: [{ name: "bad", maxPending, sink: () => undefined }],
        }),
      /positive whole number/,
    );
  }
});
