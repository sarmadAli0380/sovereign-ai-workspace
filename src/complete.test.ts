import assert from "node:assert/strict";
import test from "node:test";
import type { Api, AssistantMessage, Context, Model, Models, StreamOptions } from "@earendil-works/pi-ai";
import { complete } from "./complete.ts";
import type { ConfigEntry } from "./config.ts";

const model = { id: "m" } as Model<Api>;
const entry: ConfigEntry = { provider: "p", modelId: "m", maxTokens: 32 };
const context: Context = {
  messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

function response(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "faux",
    provider: "p",
    model: "m",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

test("forwards cancellation and request timeout to the active provider call", async () => {
  let seen: StreamOptions | undefined;
  const models = {
    async complete(_model: Model<Api>, _context: Context, options?: StreamOptions) {
      seen = options;
      return response();
    },
  } as unknown as Models;
  const controller = new AbortController();

  await complete(models, model, entry, context, "p", {
    signal: controller.signal,
    timeoutMs: 1_500,
  });

  assert.equal(seen?.signal, controller.signal);
  assert.equal(seen?.timeoutMs, 1_500);
});

test("rejects an unusable provider timeout before making a call", async () => {
  let called = false;
  const models = {
    async complete() {
      called = true;
      return response();
    },
  } as unknown as Models;

  await assert.rejects(
    complete(models, model, entry, context, "p", { timeoutMs: Number.NaN }),
    /timeoutMs must be a finite positive number/,
  );
  assert.equal(called, false);
});
