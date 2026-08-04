/**
 * End-to-end integration: 1.2 + 1.4 + 1.5 + 1.6 driven together through a
 * full request → tool-call → dispatch → response cycle.
 *
 * Uses pi-ai's own `fauxProvider`, so this runs with no credentials and no
 * network. It verifies the harness's plumbing — everything except whether a
 * real provider returns the shape pi-ai promises, which is what
 * `scripts/verify-live.ts` covers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Type, createModels } from "@earendil-works/pi-ai";
import type { ToolCall } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { parseConfig } from "./config.ts";
import { loadModel } from "./load-model.ts";
import { validateContext } from "./validate-context.ts";
import { ConversationManager } from "./conversation-manager.ts";
import { ToolRegistry, dispatchToolCalls } from "./tool-registry.ts";
import type { HarnessResult } from "./types.ts";

function setup() {
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "test-model", contextWindow: 100_000, maxTokens: 4_000 }],
  });
  const models = createModels();
  models.setProvider(faux.provider);

  const config = parseConfig({
    "faux-default": {
      provider: "faux",
      modelId: "test-model",
      maxTokens: 1024,
      temperature: 0.5,
    },
  });

  const registry = new ToolRegistry();
  registry.register({
    definition: {
      name: "get_weather",
      description: "Get the current weather for a city",
      parameters: Type.Object({ city: Type.String() }),
    },
    async execute(args) {
      return { content: [{ type: "text", text: `18°C and sunny in ${String(args["city"])}` }] };
    },
  });

  return { faux, models, config, registry };
}

test("full cycle: request → tool call → dispatch → tool result → final answer", async () => {
  const { faux, models, config, registry } = setup();

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("get_weather", { city: "Paris" }, { id: "call-1" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([fauxText("It is 18°C and sunny in Paris.")], { stopReason: "stop" }),
  ]);

  // 1.4 — config key resolves to a model, single lookup.
  const { model, entry } = loadModel("faux-default", config, models);
  assert.equal(model.id, "test-model");

  // 1.5 — conversation sized from the resolved model.
  const conversation = new ConversationManager({
    systemPrompt: "You are helpful.",
    tools: registry.getToolDefinitions(),
    contextWindow: model.contextWindow,
  });
  conversation.append({ role: "user", content: "Weather in Paris?", timestamp: Date.now() });

  async function call(): Promise<HarnessResult> {
    // 1.2 — pre-flight guard before handing off to pi-ai.
    validateContext(conversation.getContext(), "faux-default", Object.keys(config));
    const started = Date.now();
    const message = await models.complete(model, conversation.getContext(), {
      maxTokens: entry.maxTokens,
      temperature: entry.temperature,
    });
    return { message, configKey: "faux-default", routedVia: "native", latencyMs: Date.now() - started };
  }

  // Turn 1 — model asks for a tool.
  const first = await call();
  assert.equal(first.message.stopReason, "toolUse");
  assert.equal(first.configKey, "faux-default");
  assert.equal(first.routedVia, "native");
  assert.ok(first.latencyMs >= 0);
  conversation.append(first.message);

  const toolCalls = first.message.content.filter((b): b is ToolCall => b.type === "toolCall");
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0]?.name, "get_weather");

  // 1.6 — dispatch returns results and does not append them itself.
  const results = await dispatchToolCalls(toolCalls, registry);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.isError, false);
  assert.equal(results[0]?.toolCallId, "call-1");

  // The orchestration step: appending through ConversationManager is what
  // applies 1.5's maxToolResultChars cap.
  conversation.appendAll(results);

  // Turn 2 — model answers using the tool result.
  const second = await call();
  assert.equal(second.message.stopReason, "stop");
  conversation.append(second.message);

  const history = conversation.getHistory();
  assert.deepEqual(
    history.map((m) => m.role),
    ["user", "assistant", "toolResult", "assistant"],
  );
});

test("provider swap is a config edit, not a code change", async () => {
  // Two config keys pointing at different models; identical calling code.
  const fauxA = fauxProvider({
    provider: "provider-a",
    models: [{ id: "model-a", contextWindow: 50_000 }],
  });
  const fauxB = fauxProvider({
    provider: "provider-b",
    models: [{ id: "model-b", contextWindow: 120_000 }],
  });
  const models = createModels();
  models.setProvider(fauxA.provider);
  models.setProvider(fauxB.provider);

  fauxA.setResponses([fauxAssistantMessage([fauxText("from A")])]);
  fauxB.setResponses([fauxAssistantMessage([fauxText("from B")])]);

  const config = parseConfig({
    "key-a": { provider: "provider-a", modelId: "model-a", maxTokens: 100, temperature: 0 },
    "key-b": { provider: "provider-b", modelId: "model-b", maxTokens: 100, temperature: 0 },
  });

  // Byte-for-byte identical driving code; only the configKey differs.
  async function run(configKey: string) {
    const { model, entry } = loadModel(configKey, config, models);
    const conversation = new ConversationManager({ contextWindow: model.contextWindow });
    conversation.append({ role: "user", content: "hi", timestamp: Date.now() });
    validateContext(conversation.getContext(), configKey, Object.keys(config));
    return models.complete(model, conversation.getContext(), {
      maxTokens: entry.maxTokens,
      temperature: entry.temperature,
    });
  }

  const a = await run("key-a");
  const b = await run("key-b");

  assert.equal(a.provider, "provider-a");
  assert.equal(b.provider, "provider-b");

  // Structural conformity: same fields, same shapes, different content.
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
  assert.deepEqual(Object.keys(a.usage).sort(), Object.keys(b.usage).sort());
  assert.equal(typeof a.stopReason, typeof b.stopReason);
});

test("a failing tool does not break the cycle", async () => {
  const { faux, models, config, registry } = setup();

  registry.register({
    definition: { name: "boom", description: "fails", parameters: Type.Object({}) },
    async execute() {
      throw new Error("tool exploded");
    },
  });

  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("get_weather", { city: "Rome" }, { id: "ok" }),
        fauxToolCall("boom", {}, { id: "bad" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("Rome is sunny; the other tool failed.")]),
  ]);

  const { model } = loadModel("faux-default", config, models);
  const conversation = new ConversationManager({
    tools: registry.getToolDefinitions(),
    contextWindow: model.contextWindow,
  });
  conversation.append({ role: "user", content: "go", timestamp: Date.now() });

  const first = await models.complete(model, conversation.getContext(), {});
  conversation.append(first);

  const toolCalls = first.content.filter((b): b is ToolCall => b.type === "toolCall");
  const results = await dispatchToolCalls(toolCalls, registry);

  // The successful call's result survives its sibling's failure.
  assert.equal(results.length, 2);
  assert.equal(results.find((r) => r.toolCallId === "ok")?.isError, false);
  assert.equal(results.find((r) => r.toolCallId === "bad")?.isError, true);

  conversation.appendAll(results);
  const second = await models.complete(model, conversation.getContext(), {});
  assert.equal(second.stopReason, "stop");
});

test("an oversized tool result is capped before it reaches the next call", async () => {
  const { faux, models, config } = setup();

  const registry = new ToolRegistry();
  registry.register({
    definition: { name: "read_file", description: "reads", parameters: Type.Object({}) },
    async execute() {
      return { content: [{ type: "text", text: "x".repeat(200_000) }] };
    },
  });

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("read_file", {}, { id: "r1" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("done")]),
  ]);

  const { model } = loadModel("faux-default", config, models);
  const conversation = new ConversationManager({
    contextWindow: model.contextWindow,
    maxToolResultChars: 1_000,
  });
  conversation.append({ role: "user", content: "read it", timestamp: Date.now() });

  const first = await models.complete(model, conversation.getContext(), {});
  conversation.append(first);

  const toolCalls = first.content.filter((b): b is ToolCall => b.type === "toolCall");
  conversation.appendAll(await dispatchToolCalls(toolCalls, registry));

  const stored = conversation.getHistory().find((m) => m.role === "toolResult");
  assert.ok(stored);
  const text = stored.role === "toolResult"
    ? stored.content.map((b) => (b.type === "text" ? b.text : "")).join("")
    : "";

  assert.ok(text.length < 2_000, `expected capped result, got ${text.length} chars`);
  assert.match(text, /truncated by harness/);

  // And the conversation is still usable afterwards.
  const second = await models.complete(model, conversation.getContext(), {});
  assert.equal(second.stopReason, "stop");
});
