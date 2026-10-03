import { isTerminalRunEvent, parseRunEvent, type RunEvent } from "../events.ts";

export type LiveRunEventListener = (event: RunEvent) => void;
export type LiveRunEventFailureHandler = (error: unknown) => void;

/**
 * Process-local fan-out only. Durable replay remains owned by the journal;
 * callers publish here after its required acknowledgement succeeds.
 */
export class RunEventBroker {
  readonly #listeners = new Map<string, Set<LiveRunEventListener>>();
  readonly #lastSequence = new Map<string, number>();
  readonly #onFailure: LiveRunEventFailureHandler;

  constructor(onFailure: LiveRunEventFailureHandler = () => undefined) {
    this.#onFailure = onFailure;
  }

  publish(value: RunEvent): void {
    let event: RunEvent;
    try {
      event = parseRunEvent(value);
    } catch (error) {
      this.#onFailure(error);
      return;
    }
    const previous = this.#lastSequence.get(event.runId);
    if (previous !== undefined && event.sequence !== previous + 1) {
      this.#onFailure(new TypeError("live run events must be contiguous and ordered"));
      return;
    }
    this.#lastSequence.set(event.runId, event.sequence);
    for (const listener of this.#listeners.get(event.runId) ?? []) {
      try {
        listener(structuredClone(event));
      } catch (error) {
        this.#onFailure(error);
      }
    }
    if (isTerminalRunEvent(event)) {
      this.#lastSequence.delete(event.runId);
    }
  }

  subscribe(runId: string, listener: LiveRunEventListener): () => void {
    if (typeof runId !== "string" || runId.length === 0) throw new TypeError("runId must be non-empty");
    const listeners = this.#listeners.get(runId) ?? new Set<LiveRunEventListener>();
    listeners.add(listener);
    this.#listeners.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(runId);
    };
  }
}
