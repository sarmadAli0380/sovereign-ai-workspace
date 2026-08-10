import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, Type } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { AssistantMessage, Api, Model, Models, Usage } from "@earendil-works/pi-ai";
import type { ConfigEntry } from "./config.ts";
import { ConversationManager } from "./conversation-manager.ts";
import { step } from "./step.ts";
import { ToolRegistry } from "./tool-registry.ts";

const entry: ConfigEntry = { provider: "faux", modelId: "small", maxTokens: 64 };

const usage: Usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
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
    timestamp: 1,
  };
}

function wantsTool(id = "c1"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "get_weather", arguments: { city: "Paris" } }],
    api: "faux",
    provider: "faux",
    model: "small",
    usage,
    stopReason: "toolUse",
    timestamp: 1,
  };
}

/** A real faux provider with a queued script — not a hand-rolled stub. */
function fixture(responses: AssistantMessage[] = [reply("hello back")]) {
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "small", contextWindow: 200_000, maxTokens: 1_000 }],
  });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const model = models.getModel("faux", "small");
  assert.ok(model, "faux provider must expose a model");
  return { models, model: model as Model<Api>, faux };
}

function conversation(): ConversationManager {
  const cm = new ConversationManager({ contextWindow: 200_000 });
  cm.append({ role: "user", content: "hello", timestamp: Date.now() });
  return cm;
}

function weatherRegistry(behaviour: "ok" | "throws" = "ok"): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    definition: {
      name: "get_weather",
      description: "Get the current weather for a city",
      parameters: Type.Object({ city: Type.String() }),
    },
    async execute(args) {
      if (behaviour === "throws") throw new Error("upstream weather API is down");
      return { content: [{ type: "text", text: `sunny in ${String(args["city"])}` }] };
    },
  });
  return registry;
}

// --- the step itself

test("a plain response ends the step", async () => {
  const { models, model } = fixture();
  const cm = conversation();

  const outcome = await step({ models, model, entry, configKey: "faux-default", conversation: cm });

  assert.equal(outcome.done, true);
  assert.equal(outcome.toolCalls.length, 0);
  assert.equal(outcome.result.message.stopReason, "stop");
  assert.equal(cm.getHistory().length, 2, "the assistant message must be appended");
});

test("step performs exactly one model call", async () => {
  // The property that makes this a step and not a loop: even given a script
  // that would let it continue, it stops after one call and returns.
  const { models, model, faux } = fixture([wantsTool(), reply("done")]);

  const outcome = await step({
    models,
    model,
    entry,
    configKey: "faux-default",
    conversation: conversation(),
    registry: weatherRegistry(),
  });

  assert.equal(faux.state.callCount, 1, "step must never call the model twice");
  assert.equal(outcome.done, false, "and it reports that continuing is possible");
  assert.equal(faux.getPendingResponseCount(), 1, "the second response is untouched");
});

test("the caller owns iteration, and the loop is four visible lines", async () => {
  const { models, model, faux } = fixture([wantsTool(), reply("18C and sunny")]);
  const cm = conversation();
  const registry = weatherRegistry();
  const deps = { models, model, entry, configKey: "k", conversation: cm, registry };

  let turns = 0;
  let outcome = await step(deps);
  while (!outcome.done && turns < 10) {
    turns += 1;
    outcome = await step(deps);
  }

  assert.equal(outcome.done, true);
  assert.equal(turns, 1, "one tool round trip needs exactly one extra step");
  assert.equal(faux.state.callCount, 2);
  // user + assistant(toolCall) + toolResult + assistant(text)
  assert.equal(cm.getHistory().length, 4);
});

// --- the error contract, which nothing implemented before this

test("REGRESSION: a pre-flight failure comes back as a result, not a throw", async () => {
  const { models, model } = fixture();
  // Empty messages is one of validateContext's documented failures.
  const empty = new ConversationManager({ contextWindow: 200_000 });

  const outcome = await step({
    models,
    model,
    entry,
    configKey: "faux-default",
    conversation: empty,
  });

  assert.equal(outcome.result.message.stopReason, "error");
  assert.equal(outcome.done, true);
  assert.match(outcome.result.message.errorMessage ?? "", /pre-flight/);
  assert.equal(outcome.result.configKey, "faux-default");
});

test("an unknown configKey is reported through the same single check", async () => {
  const { models, model } = fixture();

  const outcome = await step({
    models,
    model,
    entry,
    configKey: "does-not-exist",
    conversation: conversation(),
    knownConfigKeys: ["faux-default"],
  });

  assert.equal(outcome.result.message.stopReason, "error");
  assert.match(outcome.result.message.errorMessage ?? "", /does-not-exist/);
});

test("a provider error surfaces as an error result, not an exception", async () => {
  // An empty script makes the faux provider fail the way a real one does:
  // through pi-ai, as an AssistantMessage with stopReason "error".
  const { models, model } = fixture([]);

  const cm = conversation();
  const outcome = await step({
    models,
    model,
    entry,
    configKey: "faux-default",
    conversation: cm,
  });

  assert.equal(outcome.result.message.stopReason, "error");
  assert.equal(outcome.done, true);
  assert.equal(outcome.toolCalls.length, 0);
  assert.equal(cm.getHistory().length, 1, "operational errors must not become assistant history");
});

test("an aborted provider call is not appended as an assistant turn", async () => {
  const { models, model } = fixture();
  const cm = conversation();
  const aborted = {
    ...reply(""),
    content: [],
    stopReason: "aborted",
  } satisfies AssistantMessage;
  const broken = { ...models, complete: async () => aborted } as unknown as Models;

  const outcome = await step({
    models: broken,
    model,
    entry,
    configKey: "faux-default",
    conversation: cm,
  });

  assert.equal(outcome.result.message.stopReason, "aborted");
  assert.equal(outcome.done, true);
  assert.equal(cm.getHistory().length, 1);
});

test("a failing conversation boundary still honors step's no-throw contract", async () => {
  const { models, model } = fixture();
  const cm = conversation();
  const brokenConversation = {
    ...cm,
    getContext: () => {
      throw new Error("conversation storage unavailable");
    },
  } as unknown as ConversationManager;

  const outcome = await step({
    models,
    model,
    entry,
    configKey: "faux-default",
    conversation: brokenConversation,
  });

  assert.equal(outcome.result.message.stopReason, "error");
  assert.equal(outcome.done, true);
  assert.match(outcome.result.message.errorMessage ?? "", /conversation storage unavailable/);
});

test("PROPERTY: step never throws, whatever the dependency does", async () => {
  const { models, model } = fixture();
  const failures = [
    () => {
      throw new Error("socket hang up");
    },
    () => {
      throw "a bare string";
    },
    () => {
      throw null;
    },
    async () => Promise.reject(new Error("rejected after retries")),
  ];

  for (const [i, behaviour] of failures.entries()) {
    const broken = { ...models, complete: behaviour } as unknown as Models;
    const outcome = await step({
      models: broken,
      model,
      entry,
      configKey: "faux-default",
      conversation: conversation(),
    });
    assert.equal(outcome.result.message.stopReason, "error", `failure ${i} must be a result`);
    assert.equal(outcome.done, true);
    assert.equal(outcome.result.message.provider, "faux", "the config's provider is reported");
  }
});

// --- tool dispatch, without deciding when to stop

test("a tool request with no registry ends the step but still reports the calls", async () => {
  // The model asked for something the caller gave it no way to run. The
  // request must stay visible rather than being silently dropped.
  const { models, model } = fixture([wantsTool()]);

  const outcome = await step({
    models,
    model,
    entry,
    configKey: "faux-default",
    conversation: conversation(),
  });

  assert.equal(outcome.done, true, "nothing can run it, so the exchange ends");
  assert.equal(outcome.toolCalls.length, 1);
  assert.equal(outcome.toolCalls[0]?.name, "get_weather");
  assert.equal(outcome.toolResults.length, 0);
});

test("a tool request with a registry dispatches, appends, and does NOT end the step", async () => {
  const { models, model } = fixture([wantsTool()]);
  const cm = conversation();

  const outcome = await step({
    models,
    model,
    entry,
    configKey: "faux-default",
    conversation: cm,
    registry: weatherRegistry(),
  });

  assert.equal(outcome.done, false, "the caller may step again — it is not told to");
  assert.equal(outcome.toolResults.length, 1);
  assert.equal(outcome.toolResults[0]?.isError, false);
  assert.equal(cm.getHistory().length, 3, "results must already be appended");
});

test("a throwing tool handler continues the exchange as an isError result", async () => {
  // 1.6 decision 2: a failing tool is something the model gets to see and
  // react to, not something that ends the conversation.
  const { models, model } = fixture([wantsTool()]);

  const outcome = await step({
    models,
    model,
    entry,
    configKey: "faux-default",
    conversation: conversation(),
    registry: weatherRegistry("throws"),
  });

  assert.equal(outcome.done, false);
  assert.equal(outcome.toolResults[0]?.isError, true);
});

test("parallel tool calls in one turn are all dispatched", async () => {
  const multi: AssistantMessage = {
    ...wantsTool("c1"),
    content: [
      { type: "toolCall", id: "c1", name: "get_weather", arguments: { city: "Paris" } },
      { type: "toolCall", id: "c2", name: "get_weather", arguments: { city: "Berlin" } },
    ],
  };
  const { models, model } = fixture([multi]);
  const cm = conversation();

  const outcome = await step({
    models,
    model,
    entry,
    configKey: "faux-default",
    conversation: cm,
    registry: weatherRegistry(),
  });

  assert.equal(outcome.toolCalls.length, 2);
  assert.equal(outcome.toolResults.length, 2);
  assert.equal(cm.getHistory().length, 4, "user + assistant + two results");
});
