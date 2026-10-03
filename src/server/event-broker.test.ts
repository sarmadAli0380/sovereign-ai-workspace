import assert from "node:assert/strict";
import test from "node:test";
import { RUN_EVENT_SCHEMA_VERSION, type RunEvent } from "../events.ts";
import { RunEventBroker } from "./event-broker.ts";

function event(sequence: number): RunEvent {
  return {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    eventId: `event-${sequence}`,
    runId: "run-1",
    conversationId: "conversation-1",
    sequence,
    turn: 0,
    occurredAt: new Date(1_800_000_000_000 + sequence).toISOString(),
    type: sequence === 0 ? "run.started" : "run.completed",
    causationId: "request-1",
    audience: "persistence",
    sensitivity: "metadata",
    payload: sequence === 0
      ? { configKey: "local-qwen", provider: "ollama", model: "qwen3:4b" }
      : { reason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } },
  } as RunEvent;
}

test("C1 broker: live events are cloned, ordered, and process-local", () => {
  const failures: unknown[] = [];
  const broker = new RunEventBroker((error) => failures.push(error));
  const received: RunEvent[] = [];
  const unsubscribe = broker.subscribe("run-1", (value) => received.push(value));
  const started = event(0);
  broker.publish(started);
  started.payload = { configKey: "changed", provider: "changed", model: "changed" } as never;
  broker.publish(event(1));
  unsubscribe();
  assert.equal(received.length, 2);
  assert.equal((received[0]!.payload as { configKey: string }).configKey, "local-qwen");
  assert.deepEqual(failures, []);
});

test("C1 broker: live fan-out failure never rejects an already-durable event", () => {
  const failures: unknown[] = [];
  const broker = new RunEventBroker((error) => failures.push(error));
  broker.subscribe("run-1", () => { throw new Error("observer failed"); });
  assert.doesNotThrow(() => broker.publish(event(0)));
  assert.doesNotThrow(() => broker.publish(event(3)));
  assert.equal(failures.length, 2);
});
