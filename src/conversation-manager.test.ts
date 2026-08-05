import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import type { Message, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import {
  capToolResult,
  ConversationManager,
  DEFAULT_RESERVE_TOKENS,
} from "./conversation-manager.ts";
import type { TruncationStrategy } from "./truncation.ts";

const usage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(text: string): Message {
  return { role: "user", content: text, timestamp: 1 };
}

function toolResult(text: string, id = "call-1"): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "read_file",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1,
  };
}

function textOf(message: ToolResultMessage): string {
  return message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

test("wraps one Context, exposed via getContext()", () => {
  const cm = new ConversationManager({
    contextWindow: 200_000,
    systemPrompt: "You are helpful.",
    tools: [{ name: "t", description: "d", parameters: Type.Object({}) }],
  });

  const context = cm.getContext();
  assert.equal(context.systemPrompt, "You are helpful.");
  assert.equal(context.tools?.length, 1);
  assert.deepEqual(context.messages, []);
});

test("append() adds to history", () => {
  const cm = new ConversationManager({ contextWindow: 200_000 });
  cm.append(user("hello"));
  cm.append(user("again"));
  assert.equal(cm.getHistory().length, 2);
});

test("appendAll() adds several at once", () => {
  const cm = new ConversationManager({ contextWindow: 200_000 });
  cm.appendAll([user("a"), user("b"), user("c")]);
  assert.equal(cm.getHistory().length, 3);
});

test("budget is contextWindow minus reserveTokens", () => {
  const cm = new ConversationManager({ contextWindow: 100_000 });
  assert.equal(cm.getBudgetTokens(), 100_000 - DEFAULT_RESERVE_TOKENS);
});

test("scales the reserve down for a small context window instead of refusing", () => {
  // A 4B local model serves 8192; the 16384 default reserve exceeds the
  // whole window. Scaling keeps the harness usable across model classes.
  const cm = new ConversationManager({ contextWindow: 8_192 });
  assert.equal(cm.getBudgetTokens(), 8_192 - 2_048, "reserve should cap at 25% of the window");
});

test("leaves the reserve untouched on a large context window", () => {
  const cm = new ConversationManager({ contextWindow: 272_000 });
  assert.equal(cm.getBudgetTokens(), 272_000 - DEFAULT_RESERVE_TOKENS);
});

test("caps an explicitly requested reserve too", () => {
  const cm = new ConversationManager({ contextWindow: 4_000, reserveTokens: 3_900 });
  assert.equal(cm.getBudgetTokens(), 4_000 - 1_000);
});

test("truncation runs on every append, not lazily before a call", () => {
  const calls: number[] = [];
  const spy: TruncationStrategy = {
    truncate(messages) {
      calls.push(messages.length);
      return messages;
    },
  };

  const cm = new ConversationManager({ contextWindow: 200_000, strategy: spy });
  cm.append(user("a"));
  cm.append(user("b"));
  cm.append(user("c"));

  assert.deepEqual(calls, [1, 2, 3]);
});

test("the Context stays within budget as messages accumulate", () => {
  const cm = new ConversationManager({
    contextWindow: 2_000,
    maxToolResultChars: 500,
  });

  for (let i = 0; i < 50; i++) cm.append(user(`message ${i} `.repeat(20)));

  assert.ok(cm.getEstimatedTokens() <= cm.getBudgetTokens());
  assert.ok(cm.getHistory().length < 50);
});

test("a custom strategy is used instead of drop-oldest", () => {
  const keepLastOnly: TruncationStrategy = {
    truncate: (messages) => messages.slice(-1),
  };
  const cm = new ConversationManager({ contextWindow: 200_000, strategy: keepLastOnly });
  cm.appendAll([user("a"), user("b"), user("c")]);
  assert.equal(cm.getHistory().length, 1);
});

// --- tool-result capping (decision 1: separate from, and prior to, truncation)

test("capToolResult leaves a small result untouched", () => {
  const message = toolResult("short");
  assert.equal(capToolResult(message, 1000), message);
});

test("capToolResult truncates an oversized result and says so", () => {
  const capped = capToolResult(toolResult("x".repeat(5000)), 100);
  const text = textOf(capped);
  assert.ok(text.length < 5000);
  assert.match(text, /truncated by harness/);
  assert.match(text, /maxToolResultChars=100/);
});

test("capToolResult preserves image blocks", () => {
  const message: ToolResultMessage = {
    ...toolResult("x".repeat(5000)),
    content: [
      { type: "text", text: "x".repeat(5000) },
      { type: "image", data: "abc", mimeType: "image/png" },
    ],
  };
  const capped = capToolResult(message, 50);
  assert.ok(capped.content.some((b) => b.type === "image"));
});

test("append() applies the cap to tool results", () => {
  const cm = new ConversationManager({ contextWindow: 200_000, maxToolResultChars: 100 });
  cm.append(toolResult("y".repeat(9000)));

  const stored = cm.getHistory()[0] as ToolResultMessage;
  assert.ok(textOf(stored).length < 9000);
  assert.match(textOf(stored), /truncated by harness/);
});

test("append() does not cap non-toolResult messages", () => {
  const cm = new ConversationManager({ contextWindow: 200_000, maxToolResultChars: 10 });
  const long = "z".repeat(400);
  cm.append(user(long));
  assert.equal(cm.getHistory()[0]?.content, long);
});

test("capping happens before truncation, so a huge tool result does not evict history", () => {
  const cm = new ConversationManager({
    contextWindow: 4_000,
    maxToolResultChars: 200,
  });

  cm.append(user("first"));
  cm.append(user("second"));
  cm.append(toolResult("q".repeat(100_000)));

  // Without the cap, the 100k-char result alone would blow the budget and
  // force everything else out.
  assert.equal(cm.getHistory().length, 3);
});

// --- regression found by the QA pass, 2026-08-04

test("REGRESSION: no truncation marker when nothing was actually cut", () => {
  const message: ToolResultMessage = {
    ...toolResult("abc"),
    content: [
      { type: "text", text: "abc" },
      { type: "text", text: "" },
    ],
  };
  const capped = capToolResult(message, 3);
  assert.doesNotMatch(textOf(capped), /truncated by harness/);
  assert.equal(capped, message, "an uncut message should be returned unchanged");
});

// --- 1.8: the system prompt and tool schemas are part of the Context's cost

test("getEstimatedTokens includes the system prompt and tools, not just messages", () => {
  const options = { contextWindow: 200_000 } as const;
  const bare = new ConversationManager(options);
  const equipped = new ConversationManager({
    ...options,
    systemPrompt: "You are a concise assistant. Use tools when they are relevant.",
    tools: [
      {
        name: "get_weather",
        description: "Get the current weather for a city",
        parameters: Type.Object({ city: Type.String({ description: "The city" }) }),
      },
    ],
  });

  bare.append(user("hello"));
  equipped.append(user("hello"));

  assert.ok(
    equipped.getEstimatedTokens() > bare.getEstimatedTokens(),
    "an identical message list must cost more when a prompt and tools ride along",
  );
  assert.equal(
    equipped.getEstimatedTokens() - bare.getEstimatedTokens(),
    equipped.getOverheadTokens(),
  );
});

test("getEstimatedTokens and getBudgetTokens both cover the whole Context", () => {
  const cm = new ConversationManager({
    contextWindow: 8_192,
    systemPrompt: "s".repeat(300),
  });
  cm.append(user("hello"));
  // Comparable by construction: the estimate is the whole Context, and the
  // budget is the whole window minus the reserve. Before 1.8 the estimate
  // counted messages only, so comparing the two under-reported by the
  // overhead — the exact gap that let a request exceed the window while the
  // harness reported itself healthy.
  assert.ok(cm.getEstimatedTokens() < cm.getBudgetTokens());
  assert.ok(cm.getOverheadTokens() > 0);
});

test("REGRESSION (1.8): the overhead is charged against the truncation budget", () => {
  // contextWindow 1000 → reserve 250 → budget 750.
  // A 1500-char system prompt costs ~504, leaving ~246 for messages.
  const withPrompt = new ConversationManager({
    contextWindow: 1_000,
    systemPrompt: "s".repeat(1_500),
  });
  const withoutPrompt = new ConversationManager({ contextWindow: 1_000 });

  // Three ~104-token messages: 312 total. Fits the raw 750 budget, does not
  // fit once the system prompt has taken its share.
  for (const cm of [withPrompt, withoutPrompt]) {
    cm.append(user("m".repeat(300)));
    cm.append(user("n".repeat(300)));
    cm.append(user("o".repeat(300)));
  }

  assert.equal(withoutPrompt.getHistory().length, 3, "control: all three fit the raw budget");
  assert.ok(
    withPrompt.getHistory().length < 3,
    "the same three messages must not fit once the prompt is charged",
  );
  assert.ok(withPrompt.getEstimatedTokens() <= withPrompt.getBudgetTokens());
});

test("constructing with tools that exhaust the window is a config error, not a runtime one", () => {
  assert.throws(
    () =>
      new ConversationManager({
        contextWindow: 1_000,
        systemPrompt: "s".repeat(3_000),
      }),
    /leaves no room for messages/,
  );
});

test("the pre-1.8 window error still fires before the overhead one", () => {
  // A window too small even before any prompt or tools should still report
  // the reserve as the cause, not the overhead.
  assert.throws(
    () => new ConversationManager({ contextWindow: 0, systemPrompt: "s" }),
    /too small to hold any messages after a reserve/,
  );
});
