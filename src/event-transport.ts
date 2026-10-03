import {
  isTerminalRunEvent,
  parseRunEvent,
  RunEventValidationError,
  type RunEvent,
} from "./events.ts";

/** A destination which receives canonical events in publication order. */
export type RunEventSink = (event: RunEvent) => void | Promise<void>;

export interface RunEventCheckpoint {
  runId: string;
  eventId: string;
  sequence: number;
}

export interface OptionalRunEventObserver {
  name: string;
  sink: RunEventSink;
  /** Includes the event currently being delivered. */
  maxPending: number;
}

export type OptionalObserverFailureReason = "buffer-full" | "sink-failed";

export interface OptionalObserverFailure {
  observer: string;
  eventId: string;
  sequence: number;
  reason: OptionalObserverFailureReason;
  cause?: unknown;
}

export interface RunEventTransportOptions {
  /**
   * An acknowledgement-boundary sink. When configured, publish() does not
   * expose the event to live consumers until this sink has accepted it.
   * Phase B uses this for the journal; it must never be used for telemetry.
   */
  requiredSink?: RunEventSink;
  /** Best-effort observers such as metrics. Their bounded queues never block publish(). */
  observers?: readonly OptionalRunEventObserver[];
  onObserverFailure?: (failure: OptionalObserverFailure) => void;
}

export interface ServerSentEventFrame {
  id: string;
  event: string;
  data: string;
}

export class RunEventTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RunEventTransportError";
  }
}

interface PendingRead {
  resolve: (result: IteratorResult<RunEvent>) => void;
  reject: (error: unknown) => void;
}

class ObserverQueue {
  readonly name: string;
  readonly maxPending: number;
  readonly #sink: RunEventSink;
  readonly #report: (failure: OptionalObserverFailure) => void;
  readonly #queue: RunEvent[] = [];
  #active = false;
  #idleWaiters: Array<() => void> = [];

  constructor(
    observer: OptionalRunEventObserver,
    report: (failure: OptionalObserverFailure) => void,
  ) {
    if (
      !Number.isFinite(observer.maxPending) ||
      !Number.isInteger(observer.maxPending) ||
      observer.maxPending <= 0
    ) {
      throw new TypeError(`observer ${JSON.stringify(observer.name)} maxPending must be a positive whole number`);
    }
    if (observer.name.length === 0) throw new TypeError("observer name must not be empty");
    this.name = observer.name;
    this.maxPending = observer.maxPending;
    this.#sink = observer.sink;
    this.#report = report;
  }

  enqueue(event: RunEvent): void {
    const pending = this.#queue.length + (this.#active ? 1 : 0);
    if (pending >= this.maxPending) {
      this.#report({
        observer: this.name,
        eventId: event.eventId,
        sequence: event.sequence,
        reason: "buffer-full",
      });
      return;
    }
    this.#queue.push(event);
    if (!this.#active) void this.#drain();
  }

  whenIdle(): Promise<void> {
    if (!this.#active && this.#queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  async #drain(): Promise<void> {
    this.#active = true;
    while (this.#queue.length > 0) {
      const event = this.#queue.shift() as RunEvent;
      try {
        await this.#sink(event);
      } catch (cause) {
        this.#report({
          observer: this.name,
          eventId: event.eventId,
          sequence: event.sequence,
          reason: "sink-failed",
          cause,
        });
      }
    }
    this.#active = false;
    const waiters = this.#idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}

function snapshotRunEvent(event: RunEvent): RunEvent {
  return parseRunEvent(JSON.parse(JSON.stringify(event)));
}

/**
 * Ordered, single-consumer in-process delivery for one run.
 *
 * publish() serializes concurrent callers. A required sink participates in
 * acknowledgement; optional observers are isolated behind bounded queues.
 * The runtime is wired to this contract in A1, not in A0.2.
 */
export class RunEventTransport implements AsyncIterable<RunEvent> {
  readonly #requiredSink?: RunEventSink;
  readonly #observers: readonly ObserverQueue[];
  readonly #observerFailures: OptionalObserverFailure[] = [];
  readonly #eventIds = new Set<string>();
  readonly #queue: RunEvent[] = [];
  readonly #reads: PendingRead[] = [];
  #tail: Promise<void> = Promise.resolve();
  #accepting = true;
  #closed = false;
  #failed = false;
  #consumerClaimed = false;
  #consumerDetached = false;
  #failure: unknown;
  #shutdown?: Promise<void>;
  #runId?: string;
  #conversationId?: string;
  #lastSequence = -1;
  #lastTurn = -1;
  #terminalSeen = false;

  constructor(options: RunEventTransportOptions = {}) {
    this.#requiredSink = options.requiredSink;
    const report = (failure: OptionalObserverFailure): void => {
      this.#observerFailures.push(failure);
      try {
        options.onObserverFailure?.(failure);
      } catch {
        // An optional failure reporter is itself optional and cannot take down publication.
      }
    };
    this.#observers = (options.observers ?? []).map(
      (observer) => new ObserverQueue(observer, report),
    );
  }

  get observerFailures(): readonly OptionalObserverFailure[] {
    return [...this.#observerFailures];
  }

  publish(event: RunEvent): Promise<void> {
    if (!this.#accepting) {
      return Promise.reject(new RunEventTransportError("event transport is not accepting events"));
    }
    let snapshot: RunEvent;
    try {
      // Capture at the call boundary, before a queued publication can await.
      snapshot = snapshotRunEvent(event);
    } catch (cause) {
      return Promise.reject(cause);
    }
    const publication = this.#tail.then(() => this.#publishOne(snapshot));
    this.#tail = publication.catch(() => undefined);
    return publication;
  }

  async close(): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    this.#accepting = false;
    this.#shutdown = this.#finish(false);
    return this.#shutdown;
  }

  async fail(cause: unknown): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    this.#accepting = false;
    this.#shutdown = this.#finish(true, cause);
    return this.#shutdown;
  }

  /** Process-shutdown/test hook; normal publication never waits for optional observers. */
  async waitForObservers(): Promise<void> {
    await Promise.all(this.#observers.map((observer) => observer.whenIdle()));
  }

  [Symbol.asyncIterator](): AsyncIterator<RunEvent> {
    if (this.#consumerClaimed) {
      throw new RunEventTransportError("the in-process RunEvent stream supports one consumer");
    }
    this.#consumerClaimed = true;
    return {
      next: () => this.#next(),
      return: async () => {
        this.#consumerDetached = true;
        this.#queue.length = 0;
        this.#settleReads();
        return { done: true, value: undefined };
      },
    };
  }

  async #publishOne(event: RunEvent): Promise<void> {
    if (this.#failed) {
      throw new RunEventTransportError("event transport has failed", { cause: this.#failure });
    }
    this.#assertNext(event);
    if (this.#requiredSink) {
      try {
        await this.#requiredSink(snapshotRunEvent(event));
      } catch (cause) {
        this.#failed = true;
        this.#failure = cause;
        throw new RunEventTransportError("required event sink rejected publication", { cause });
      }
    }
    this.#record(event);
    if (!this.#consumerDetached) {
      const read = this.#reads.shift();
      if (read) read.resolve({ done: false, value: event });
      else this.#queue.push(event);
    }
    for (const observer of this.#observers) observer.enqueue(snapshotRunEvent(event));
  }

  #assertNext(event: RunEvent): void {
    const issues: string[] = [];
    if (this.#runId === undefined) {
      if (event.type !== "run.started") issues.push("the first event must be run.started");
    } else {
      if (event.runId !== this.#runId) issues.push("runId changed within the stream");
      if (event.conversationId !== this.#conversationId) {
        issues.push("conversationId changed within the stream");
      }
      if (event.type === "run.started") issues.push("run.started may appear only once");
    }
    if (this.#eventIds.has(event.eventId)) issues.push(`duplicate eventId ${event.eventId}`);
    if (event.sequence <= this.#lastSequence) {
      issues.push("sequence must be unique and strictly increasing");
    }
    if (event.turn < this.#lastTurn) issues.push("turn cannot move backwards");
    if (this.#terminalSeen) issues.push("no event may follow a terminal event");
    if (issues.length > 0) throw new RunEventValidationError(issues);
  }

  #record(event: RunEvent): void {
    this.#runId ??= event.runId;
    this.#conversationId ??= event.conversationId;
    this.#eventIds.add(event.eventId);
    this.#lastSequence = event.sequence;
    this.#lastTurn = event.turn;
    this.#terminalSeen = isTerminalRunEvent(event);
  }

  #next(): Promise<IteratorResult<RunEvent>> {
    const event = this.#queue.shift();
    if (event) return Promise.resolve({ done: false, value: event });
    if (this.#failed) return Promise.reject(this.#failure);
    if (this.#closed || this.#consumerDetached) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve, reject) => this.#reads.push({ resolve, reject }));
  }

  #settleReads(): void {
    if (this.#queue.length > 0) return;
    const reads = this.#reads.splice(0);
    for (const read of reads) {
      if (this.#failed) read.reject(this.#failure);
      else read.resolve({ done: true, value: undefined });
    }
  }

  async #finish(failed: boolean, cause?: unknown): Promise<void> {
    await this.#tail;
    if (failed && !this.#failed) {
      this.#failed = true;
      this.#failure = cause;
    }
    this.#closed = true;
    this.#settleReads();
  }
}

export function checkpointForRunEvent(event: RunEvent): RunEventCheckpoint {
  const parsed = parseRunEvent(event);
  return { runId: parsed.runId, eventId: parsed.eventId, sequence: parsed.sequence };
}

/** Resolve a reconnect checkpoint explicitly; stale or inconsistent checkpoints fail closed. */
export function eventsAfterCheckpoint(
  events: readonly RunEvent[],
  checkpoint: RunEventCheckpoint,
): readonly RunEvent[] {
  if (
    !Number.isFinite(checkpoint.sequence) ||
    !Number.isInteger(checkpoint.sequence) ||
    checkpoint.sequence < 0
  ) {
    throw new RunEventTransportError("checkpoint sequence must be a non-negative whole number");
  }
  const index = events.findIndex((event) => event.eventId === checkpoint.eventId);
  if (index < 0) throw new RunEventTransportError("checkpoint eventId is not available");
  const matched = parseRunEvent(events[index]);
  if (matched.runId !== checkpoint.runId || matched.sequence !== checkpoint.sequence) {
    throw new RunEventTransportError("checkpoint identity does not match the stored event");
  }
  const resumed: RunEvent[] = [];
  let previousSequence = matched.sequence;
  for (const candidate of events.slice(index + 1)) {
    const event = snapshotRunEvent(candidate);
    if (event.runId !== checkpoint.runId) {
      throw new RunEventTransportError("reconnect events changed runId");
    }
    if (event.sequence <= previousSequence) {
      throw new RunEventTransportError("reconnect events are not strictly ordered");
    }
    previousSequence = event.sequence;
    resumed.push(event);
  }
  return resumed;
}

/** Pure mapping for the Phase C HTTP/SSE adapter; this function opens no connection. */
export function runEventToSseFrame(event: RunEvent): ServerSentEventFrame {
  const parsed = parseRunEvent(event);
  if (/[\0\r\n]/.test(parsed.eventId)) {
    throw new RunEventTransportError("eventId contains an invalid SSE control character");
  }
  return { id: parsed.eventId, event: parsed.type, data: JSON.stringify(parsed) };
}

export function encodeSseFrame(frame: ServerSentEventFrame): string {
  if (/[\0\r\n]/.test(frame.id) || /[\0\r\n]/.test(frame.event)) {
    throw new RunEventTransportError("SSE id and event fields contain an invalid control character");
  }
  const data = frame.data.replace(/\r\n|\r/g, "\n").split("\n");
  return [`id: ${frame.id}`, `event: ${frame.event}`, ...data.map((line) => `data: ${line}`), "", ""].join("\n");
}

export function encodeRunEventSse(event: RunEvent): string {
  return encodeSseFrame(runEventToSseFrame(event));
}

export function parseRunEventSseData(data: string): RunEvent {
  return parseRunEvent(JSON.parse(data));
}
