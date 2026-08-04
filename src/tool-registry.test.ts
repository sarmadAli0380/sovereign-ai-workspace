import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import type { ToolCall } from "@earendil-works/pi-ai";
import { dispatchToolCall, dispatchToolCalls, ToolRegistry, type ToolHandler } from "./tool-registry.ts";

function weatherHandler(overrides: Partial<ToolHandler> = {}): ToolHandler {
  return {
    definition: {
      name: "get_weather",
      description: "Get the weather for a city",
      parameters: Type.Object({ city: Type.String() }),
    },
    async execute(args) {
      return { content: [{ type: "text", text: `sunny in ${String(args["city"])}` }] };
    },
    ...overrides,
  };
}

function call(name: string, args: Record<string, unknown> = {}, id = "call-1"): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

function textOf(message: { content: { type: string; text?: string }[] }): string {
  return message.content.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
}

test("registry maps tool name to handler", () => {
  const registry = new ToolRegistry();
  registry.register(weatherHandler());
  assert.ok(registry.has("get_weather"));
  assert.equal(registry.size, 1);
});

test("getToolDefinitions returns definitions only — handlers never leak", () => {
  const registry = new ToolRegistry();
  registry.register(weatherHandler());

  const definitions = registry.getToolDefinitions();
  assert.equal(definitions.length, 1);
  assert.deepEqual(Object.keys(definitions[0]!).sort(), ["description", "name", "parameters"]);
  assert.ok(!("execute" in definitions[0]!));
});

test("dispatches a successful call", async () => {
  const registry = new ToolRegistry();
  registry.register(weatherHandler());

  const result = await dispatchToolCall(call("get_weather", { city: "Paris" }), registry);
  assert.equal(result.role, "toolResult");
  assert.equal(result.isError, false);
  assert.equal(result.toolCallId, "call-1");
  assert.equal(result.toolName, "get_weather");
  assert.match(textOf(result), /sunny in Paris/);
});

test("an unknown tool becomes an isError result, not a throw", async () => {
  const result = await dispatchToolCall(call("nope"), new ToolRegistry());
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Unknown tool: nope/);
});

test("a thrown handler error is auto-wrapped into an isError result", async () => {
  const registry = new ToolRegistry();
  registry.register(
    weatherHandler({
      async execute() {
        throw new Error("upstream API exploded");
      },
    }),
  );

  const result = await dispatchToolCall(call("get_weather", { city: "Paris" }), registry);
  assert.equal(result.isError, true);
  assert.equal(result.toolCallId, "call-1");
  assert.match(textOf(result), /upstream API exploded/);
});

test("a non-Error throw is still wrapped", async () => {
  const registry = new ToolRegistry();
  registry.register(
    weatherHandler({
      async execute() {
        throw "just a string";
      },
    }),
  );

  const result = await dispatchToolCall(call("get_weather", { city: "Paris" }), registry);
  assert.equal(result.isError, true);
  assert.match(textOf(result), /just a string/);
});

test("a handler's own isError:true is preserved", async () => {
  const registry = new ToolRegistry();
  registry.register(
    weatherHandler({
      async execute() {
        return { content: [{ type: "text", text: "city not found" }], isError: true };
      },
    }),
  );

  const result = await dispatchToolCall(call("get_weather", { city: "Paris" }), registry);
  assert.equal(result.isError, true);
});

test("multiple calls run in parallel", async () => {
  const registry = new ToolRegistry();
  let active = 0;
  let peak = 0;

  registry.register(
    weatherHandler({
      async execute() {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active--;
        return { content: [{ type: "text", text: "ok" }] };
      },
    }),
  );

  const calls = [
    call("get_weather", { city: "a" }, "a"),
    call("get_weather", { city: "b" }, "b"),
    call("get_weather", { city: "c" }, "c"),
  ];

  const started = Date.now();
  const results = await dispatchToolCalls(calls, registry);
  const elapsed = Date.now() - started;

  assert.equal(results.length, 3);
  assert.equal(peak, 3, "all three handlers should have been in flight at once");
  assert.ok(elapsed < 60, `parallel dispatch took ${elapsed}ms — looks sequential`);
});

test("one failing call does not lose the results of the others", async () => {
  const registry = new ToolRegistry();
  registry.register(weatherHandler());
  registry.register({
    definition: { name: "boom", description: "always fails", parameters: Type.Object({}) },
    async execute() {
      throw new Error("boom");
    },
  });

  const results = await dispatchToolCalls(
    [call("get_weather", { city: "Rome" }, "ok-1"), call("boom", {}, "bad-1")],
    registry,
  );

  assert.equal(results.length, 2);
  assert.equal(results[0]?.isError, false);
  assert.match(textOf(results[0]!), /sunny in Rome/);
  assert.equal(results[1]?.isError, true);
});

test("results keep their calls' order and ids", async () => {
  const registry = new ToolRegistry();
  registry.register(
    weatherHandler({
      definition: {
        name: "get_weather",
        description: "Get the weather for a city",
        parameters: Type.Object({ city: Type.String(), delay: Type.Number() }),
      },
      async execute(args) {
        // Finish out of order: later calls return sooner.
        await new Promise((r) => setTimeout(r, Number(args["delay"] ?? 0)));
        return { content: [{ type: "text", text: String(args["delay"]) }] };
      },
    }),
  );

  const results = await dispatchToolCalls(
    [
      call("get_weather", { city: "x", delay: 30 }, "first"),
      call("get_weather", { city: "y", delay: 0 }, "second"),
    ],
    registry,
  );

  assert.deepEqual(results.map((r) => r.toolCallId), ["first", "second"]);
});

test("dispatch returns results and does not append them anywhere", async () => {
  // Decision 4: dispatch is decoupled from ConversationManager. The proof
  // is structural — dispatchToolCalls takes only calls and a registry, and
  // hands back plain messages for the orchestration loop to append.
  const registry = new ToolRegistry();
  registry.register(weatherHandler());
  const results = await dispatchToolCalls([call("get_weather", { city: "Oslo" })], registry);
  assert.ok(Array.isArray(results));
  assert.equal(results[0]?.role, "toolResult");
});

test("handles an empty call list", async () => {
  assert.deepEqual(await dispatchToolCalls([], new ToolRegistry()), []);
});

// --- regressions found by the QA pass, 2026-08-04

test("REGRESSION: a missing required argument is rejected before the handler runs", async () => {
  const registry = new ToolRegistry();
  let handlerRan = false;
  registry.register(
    weatherHandler({
      async execute() {
        handlerRan = true;
        return { content: [{ type: "text", text: "should not get here" }] };
      },
    }),
  );

  const result = await dispatchToolCall(call("get_weather", {}), registry);

  assert.equal(handlerRan, false, "handler must not run on invalid arguments");
  assert.equal(result.isError, true);
  assert.match(textOf(result), /city/, "error should name the offending field");
});

test("REGRESSION: a wrongly-typed argument is rejected", async () => {
  const registry = new ToolRegistry();
  registry.register(weatherHandler());
  const result = await dispatchToolCall(call("get_weather", { city: { nested: true } }), registry);
  assert.equal(result.isError, true);
});

test("valid arguments still reach the handler", async () => {
  const registry = new ToolRegistry();
  registry.register(weatherHandler());
  const result = await dispatchToolCall(call("get_weather", { city: "Paris" }), registry);
  assert.equal(result.isError, false);
  assert.match(textOf(result), /sunny in Paris/);
});

test("REGRESSION: a zero-argument tool works with absent `arguments`", async () => {
  const registry = new ToolRegistry();
  let ran = false;
  registry.register({
    definition: { name: "ping", description: "no args", parameters: Type.Object({}) },
    async execute() {
      ran = true;
      return { content: [{ type: "text", text: "pong" }] };
    },
  });

  // pi-ai always emits `{}`, but a hand-built or replayed ToolCall may not.
  const bare = { type: "toolCall", id: "c1", name: "ping" } as ToolCall;
  const result = await dispatchToolCall(bare, registry);

  assert.equal(ran, true, "handler should run when arguments are absent");
  assert.equal(result.isError, false);
});
