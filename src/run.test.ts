import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream, createModels, Type } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type {
  Api,
  AssistantMessage,
  Model,
  Models,
  StreamOptions,
  Usage,
} from "@earendil-works/pi-ai";
import type { ConfigEntry } from "./config.ts";
import { ConversationManager } from "./conversation-manager.ts";
import { RunEventTransport } from "./event-transport.ts";
import { assertRunEventSequence, type RunEvent } from "./events.ts";
import { CapabilityPolicy } from "./policy.ts";
import { run, type RunOptions } from "./run.ts";
import { ToolRegistry } from "./tool-registry.ts";

const entry: ConfigEntry = { provider: "faux", modelId: "small", maxTokens: 64 };
const toolPolicy = new CapabilityPolicy({
  rules: [{
    deploymentId: "*",
    roleId: "*",
    workspaceId: "*",
    capability: "net",
    decision: "allow",
    reasonCode: "test.network-allowed",
  }],
});
const policyDeps = {
  toolPolicy,
  toolPolicyContext: { deploymentId: "test", roleId: "test", workspaceId: "test" },
};

function policyWithDecision(decision: "allow" | "deny" | "requireApproval") {
  return new CapabilityPolicy({
    rules: [{
      deploymentId: "test",
      roleId: "test",
      workspaceId: "test",
      capability: "net",
      decision,
      reasonCode: `test.${decision.toLowerCase()}`,
    }],
  });
}
const usage: Usage = {
  input: 10,
  output: 5,
  cacheRead: 1,
  cacheWrite: 2,
  totalTokens: 18,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function reply(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "faux",
    provider: "faux",
    model: "small",
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function wantsTool(id = "call-1"): AssistantMessage {
  return {
    ...reply(""),
    content: [{ type: "toolCall", id, name: "weather", arguments: { city: "Paris" } }],
    stopReason: "toolUse",
  };
}

function fixture(responses: AssistantMessage[]) {
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "small", contextWindow: 200_000, maxTokens: 1_000 }],
  });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const model = models.getModel("faux", "small");
  assert.ok(model);
  return { models, model: model as Model<Api>, faux };
}

function conversation(): ConversationManager {
  const value = new ConversationManager({ contextWindow: 200_000 });
  value.append({ role: "user", content: "hello", timestamp: Date.now() });
  return value;
}

function registry(behaviour: "ok" | "error" = "ok"): ToolRegistry {
  const value = new ToolRegistry();
  value.register({
    definition: {
      name: "weather",
      description: "Get weather",
      parameters: Type.Object({ city: Type.String() }),
    },
    controls: {
      capabilities: ["net"],
      risk: "low",
      timeoutMs: 1_000,
      maxOutputChars: 10_000,
      concurrencyCost: 1,
      sideEffect: "none",
      idempotency: "natural",
    },
    async execute() {
      if (behaviour === "error") throw new Error("weather unavailable");
      return { content: [{ type: "text", text: "sunny" }] };
    },
  });
  return value;
}

function collector(overrides: Partial<RunOptions> = {}) {
  const events: RunEvent[] = [];
  let nextId = 0;
  const options: RunOptions = {
    conversationId: "conversation-1",
    causationId: "command-1",
    runId: "run-1",
    maxTurns: 4,
    deadline: Date.now() + 5_000,
    idFactory: () => `generated-${nextId++}`,
    onEvent: (event) => {
      events.push(event);
    },
    ...overrides,
  };
  return { events, options };
}

test("one successful turn emits one complete canonical run", async () => {
  const { models, model } = fixture([reply("done")]);
  const { events, options } = collector();

  const outcome = await run(
    { models, model, entry, configKey: "faux-default", conversation: conversation() },
    options,
  );

  assert.equal(outcome.reason, "stop");
  assert.equal(outcome.turns, 1);
  assert.ok(outcome.usage.totalTokens > 0);
  assert.deepEqual(
    events.filter((event) => event.type !== "message.delta").map((event) => event.type),
    ["run.started", "turn.started", "message.completed", "turn.completed", "run.completed"],
  );
  assertRunEventSequence(events, { complete: true });
});

test("the runtime publishes directly through the ordered transport contract", async () => {
  const { models, model } = fixture([reply("done")]);
  const transport = new RunEventTransport();
  const received: RunEvent[] = [];
  const consume = (async () => {
    for await (const event of transport) received.push(event);
  })();
  const { options } = collector({ onEvent: (event) => transport.publish(event) });

  const outcome = await run(
    { models, model, entry, configKey: "faux-default", conversation: conversation() },
    options,
  );
  await transport.close();
  await consume;

  assert.equal(outcome.reason, "stop");
  assertRunEventSequence(received, { complete: true });
  assert.equal(received.at(-1)?.type, "run.completed");
});

test("a tool round trip emits lifecycle events and aggregates both turns", async () => {
  const { models, model, faux } = fixture([wantsTool(), reply("sunny")]);
  const { events, options } = collector();

  const outcome = await run(
    {
      models,
      model,
      entry,
      configKey: "faux-default",
      conversation: conversation(),
      registry: registry(),
      ...policyDeps,
    },
    options,
  );

  assert.equal(outcome.reason, "stop");
  assert.equal(outcome.turns, 2);
  const perTurnTokens = events
    .filter((event) => event.type === "turn.completed")
    .reduce(
      (total, event) =>
        total + (event.type === "turn.completed" ? (event.payload.usage?.totalTokens ?? 0) : 0),
      0,
    );
  assert.equal(outcome.usage.totalTokens, perTurnTokens);
  assert.equal(faux.state.callCount, 2);
  assert.deepEqual(
    events
      .filter((event) => event.type.startsWith("tool."))
      .map((event) => event.type),
    ["tool.requested", "tool.decision", "tool.started", "tool.completed"],
  );
  assertRunEventSequence(events, { complete: true });
});

test("repeated tool failures stop at maxTurns rather than forming an unbounded loop", async () => {
  const { models, model, faux } = fixture([
    wantsTool("one"),
    wantsTool("two"),
    wantsTool("three"),
  ]);
  const { events, options } = collector({ maxTurns: 2 });

  const outcome = await run(
    {
      models,
      model,
      entry,
      configKey: "faux-default",
      conversation: conversation(),
      registry: registry("error"),
      ...policyDeps,
    },
    options,
  );

  assert.equal(outcome.reason, "maxTurns");
  assert.equal(outcome.turns, 2);
  assert.equal(faux.state.callCount, 2);
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "run.completed");
  assert.equal(
    terminal?.type === "run.completed" ? terminal.payload.reason : undefined,
    "maxTurns",
  );
  assertRunEventSequence(events, { complete: true });
});

test("a tool request with no gateway suspends with pending calls", async () => {
  const { models, model } = fixture([wantsTool()]);
  const { events, options } = collector();

  const outcome = await run(
    { models, model, entry, configKey: "faux-default", conversation: conversation() },
    options,
  );

  assert.equal(outcome.reason, "needsApproval");
  assert.equal(outcome.pendingToolCalls[0]?.name, "weather");
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "run.completed");
  assert.equal(
    terminal?.type === "run.completed" ? terminal.payload.reason : undefined,
    "needsApproval",
  );
  assertRunEventSequence(events, { complete: true });
});

test("a denied policy decision never starts the handler and remains model-visible", async () => {
  const { models, model } = fixture([wantsTool(), reply("handled denial")]);
  const tools = registry();
  let handlerRan = false;
  const handler = tools.get("weather");
  assert.ok(handler);
  tools.get("weather")!.execute = async () => {
    handlerRan = true;
    return { content: [{ type: "text", text: "unsafe" }] };
  };
  const cm = conversation();
  const { events, options } = collector();

  const outcome = await run(
    {
      models,
      model,
      entry,
      configKey: "faux-default",
      conversation: cm,
      registry: tools,
      toolPolicy: policyWithDecision("deny"),
      toolPolicyContext: policyDeps.toolPolicyContext,
    },
    options,
  );

  assert.equal(outcome.reason, "stop");
  assert.equal(handlerRan, false);
  assert.equal(cm.getHistory().some((message) => message.role === "toolResult" && message.isError), true);
  assert.deepEqual(
    events.filter((event) => event.type.startsWith("tool.")).map((event) => event.type),
    ["tool.requested", "tool.decision", "tool.completed"],
  );
  const decision = events.find((event) => event.type === "tool.decision");
  assert.equal(decision?.type === "tool.decision" ? decision.payload.reasonCode : undefined, "test.deny");
});

test("a requireApproval decision suspends without starting or completing tools", async () => {
  const { models, model } = fixture([wantsTool("approval-call")]);
  const tools = registry();
  let handlerRan = false;
  tools.get("weather")!.execute = async () => {
    handlerRan = true;
    return { content: [{ type: "text", text: "unsafe" }] };
  };
  const cm = conversation();
  const { events, options } = collector({ approvalTtlMs: 60_000 });

  const outcome = await run(
    {
      models,
      model,
      entry,
      configKey: "faux-default",
      conversation: cm,
      registry: tools,
      toolPolicy: policyWithDecision("requireApproval"),
      toolPolicyContext: policyDeps.toolPolicyContext,
    },
    options,
  );

  assert.equal(outcome.reason, "needsApproval");
  assert.equal(outcome.pendingToolCalls[0]?.id, "approval-call");
  assert.equal(outcome.pendingApprovals.length, 1);
  assert.equal(outcome.pendingApprovals[0]?.toolCall.id, "approval-call");
  assert.equal(outcome.pendingApprovals[0]?.runId, "run-1");
  assert.equal(handlerRan, false);
  assert.equal(cm.getHistory().some((message) => message.role === "toolResult"), false);
  assert.deepEqual(
    events.filter((event) => event.type.startsWith("tool.")).map((event) => event.type),
    ["tool.requested", "tool.decision"],
  );
  assert.equal(events.some((event) => event.type === "approval.requested"), true);
  assert.equal(events.at(-1)?.type, "run.completed");
  assertRunEventSequence(events, { complete: true });
});

test("a provider failure emits run.failed and never appends assistant history", async () => {
  const { models, model } = fixture([]);
  const cm = conversation();
  const { events, options } = collector();

  const outcome = await run(
    { models, model, entry, configKey: "faux-default", conversation: cm },
    { ...options, maxTurns: 1 },
  );

  assert.equal(outcome.reason, "error");
  assert.equal(events.at(-1)?.type, "run.failed");
  assert.equal(cm.getHistory().length, 1);
  assertRunEventSequence(events, { complete: true });
});

test("caller cancellation reaches an active provider stream", async () => {
  const controller = new AbortController();
  const aborted: AssistantMessage = { ...reply(""), content: [], stopReason: "aborted" };
  let providerSawSignal = false;
  const models = {
    stream(_model: Model<Api>, _context: unknown, streamOptions?: StreamOptions) {
      const stream = createAssistantMessageEventStream();
      providerSawSignal =
        streamOptions?.signal === controller.signal || streamOptions?.signal !== undefined;
      const finish = (): void => stream.push({ type: "error", reason: "aborted", error: aborted });
      if (streamOptions?.signal?.aborted) queueMicrotask(finish);
      else streamOptions?.signal?.addEventListener("abort", finish, { once: true });
      return stream;
    },
  } as unknown as Models;
  const { events, options } = collector({
    signal: controller.signal,
    onEvent: (event) => {
      events.push(event);
      if (event.type === "turn.started") controller.abort();
    },
  });

  const outcome = await run(
    {
      models,
      model: fixture([reply("unused")]).model,
      entry,
      configKey: "faux-default",
      conversation: conversation(),
    },
    options,
  );

  assert.equal(providerSawSignal, true);
  assert.equal(outcome.reason, "cancelled");
  assert.equal(outcome.code, "caller.cancelled");
  assert.equal(events.at(-1)?.type, "run.cancelled");
  assertRunEventSequence(events, { complete: true });
});

test("the deadline reaches active tool work and bounds a handler that never resolves", async () => {
  const { models, model } = fixture([wantsTool()]);
  const tools = new ToolRegistry();
  let handlerSignal: AbortSignal | undefined;
  let handlerDeadline: number | undefined;
  tools.register({
    definition: {
      name: "weather",
      description: "Never returns",
      parameters: Type.Object({ city: Type.String() }),
    },
    controls: {
      capabilities: ["net"],
      risk: "low",
      timeoutMs: 1_000,
      maxOutputChars: 10_000,
      concurrencyCost: 1,
      sideEffect: "none",
      idempotency: "natural",
    },
    async execute(_args, context) {
      handlerSignal = context?.signal;
      handlerDeadline = context?.deadline;
      return new Promise(() => undefined);
    },
  });
  const { events, options } = collector({ deadline: Date.now() + 20 });

  const outcome = await run(
    {
      models,
      model,
      entry,
      configKey: "faux-default",
      conversation: conversation(),
      registry: tools,
      ...policyDeps,
    },
    options,
  );

  assert.equal(handlerSignal?.aborted, true);
  assert.equal(handlerDeadline, options.deadline);
  assert.equal(outcome.reason, "cancelled");
  assert.equal(outcome.code, "deadline.exceeded");
  assert.ok(outcome.elapsedMs < 1_000, `deadline took ${outcome.elapsedMs}ms`);
  assert.equal(events.at(-1)?.type, "run.cancelled");
  assertRunEventSequence(events, { complete: true });
});

test("a journal rejection returns persistenceUnavailable even when it rejects with undefined", async () => {
  const { models, model } = fixture([reply("must not run")]);
  let publications = 0;
  const { options } = collector({
    onEvent: () => {
      publications += 1;
      return Promise.reject(undefined);
    },
  });

  const outcome = await run(
    { models, model, entry, configKey: "faux-default", conversation: conversation() },
    options,
  );

  assert.equal(outcome.reason, "persistenceUnavailable");
  assert.equal(outcome.turns, 0);
  assert.equal(publications, 1);
});

test("a journal rejection after run start suspends before message history append", async () => {
  const { models, model } = fixture([reply("must not be appended")]);
  const cm = conversation();
  const events: RunEvent[] = [];
  const { options } = collector({
    onEvent: (event) => {
      if (event.type === "message.completed") throw new Error("journal full");
      events.push(event);
    },
  });

  const outcome = await run(
    { models, model, entry, configKey: "faux-default", conversation: cm },
    options,
  );

  assert.equal(outcome.reason, "persistenceUnavailable");
  assert.equal(cm.getHistory().length, 1);
  assert.deepEqual(events.slice(0, 2).map((event) => event.type), ["run.started", "turn.started"]);
  assert.equal(events.some((event) => event.type === "message.completed"), false);
  assert.equal(
    events.some((event) => event.type.startsWith("run.") && event.type !== "run.started"),
    false,
  );
});

test("invalid run bounds fail before emitting or calling the provider", async () => {
  const { models, model, faux } = fixture([reply("unused")]);
  const { events, options } = collector();
  const deps = { models, model, entry, configKey: "faux-default", conversation: conversation() };

  await assert.rejects(run(deps, { ...options, maxTurns: 0 }), /maxTurns/);
  await assert.rejects(run(deps, { ...options, deadline: Number.NaN }), /deadline/);
  assert.equal(events.length, 0);
  assert.equal(faux.state.callCount, 0);
});
