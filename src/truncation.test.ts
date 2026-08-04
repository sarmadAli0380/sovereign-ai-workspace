import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, Message, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { dropOldestStrategy, estimateContextTokens, estimateTokens } from "./truncation.ts";

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

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "faux",
    provider: "faux",
    model: "m",
    usage,
    stopReason: "stop",
    timestamp: 1,
  };
}

function assistantToolCall(id: string, name = "get_weather"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: { city: "Paris" } }],
    api: "faux",
    provider: "faux",
    model: "m",
    usage,
    stopReason: "toolUse",
    timestamp: 1,
  };
}

function toolResult(id: string, text = "sunny", name = "get_weather"): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1,
  };
}

test("estimates tokens as chars/CHARS_PER_TOKEN plus per-message overhead", () => {
  // 8 chars / 3 = 2.67 -> ceil 3, plus 4 overhead. The divisor moved from 4
  // to 3 after live measurement showed chars/4 underestimating code by 1.83x.
  assert.equal(estimateTokens(user("abcdefgh")), 7);
});

test("estimates across every message role without throwing", () => {
  const total = estimateContextTokens([
    user("hello"),
    assistantToolCall("call-1"),
    toolResult("call-1"),
  ]);
  assert.ok(total > 0);
});

test("keeps everything when it already fits", () => {
  const messages = [user("a"), assistant("b"), user("c")];
  assert.deepEqual(dropOldestStrategy.truncate([...messages], 10_000), messages);
});

test("drops from the front when over budget", () => {
  const messages = [user("a".repeat(400)), user("b".repeat(400)), user("c".repeat(40))];
  const kept = dropOldestStrategy.truncate([...messages], 120);
  assert.ok(kept.length < messages.length);
  // The newest message always survives.
  assert.equal(kept.at(-1), messages.at(-1));
});

test("never leaves a toolResult whose toolCall was dropped", () => {
  const messages: Message[] = [
    user("x".repeat(2000)),
    assistantToolCall("call-1"),
    toolResult("call-1", "y".repeat(2000)),
    user("final question"),
  ];

  const kept = dropOldestStrategy.truncate([...messages], 60);

  const keptCallIds = new Set(
    kept.flatMap((m) =>
      m.role === "assistant"
        ? m.content.filter((b) => b.type === "toolCall").map((b) => b.id)
        : [],
    ),
  );
  for (const message of kept) {
    if (message.role === "toolResult") {
      assert.ok(
        keptCallIds.has(message.toolCallId),
        `orphaned toolResult ${message.toolCallId} survived truncation`,
      );
    }
  }
});

test("keeps the newest message even when it alone exceeds the budget", () => {
  const messages = [user("old"), user("z".repeat(10_000))];
  const kept = dropOldestStrategy.truncate([...messages], 10);
  assert.equal(kept.length, 1);
  assert.equal(kept[0], messages[1]);
});

test("never returns an empty list", () => {
  const messages = [user("a".repeat(1000))];
  assert.ok(dropOldestStrategy.truncate([...messages], 1).length > 0);
});

test("handles an empty input list", () => {
  assert.deepEqual(dropOldestStrategy.truncate([], 100), []);
});

test("result always fits the budget once the leading pair is resolved", () => {
  const messages: Message[] = [
    assistantToolCall("call-1"),
    toolResult("call-1", "r".repeat(800)),
    user("q".repeat(80)),
  ];
  const kept = dropOldestStrategy.truncate([...messages], 60);
  // Either it fits, or it's the single newest message kept deliberately.
  assert.ok(estimateContextTokens(kept) <= 60 || kept.length === 1);
});

// --- regressions found by the QA pass, 2026-08-04

test("REGRESSION: never returns a lone orphaned toolResult", () => {
  // Realistic shape: a capped 16k tool result alone exceeds a small budget,
  // so the cut lands on it and the old fallback returned it without its call.
  const messages: Message[] = [
    user("q".repeat(400)),
    assistantToolCall("call-1", "read_file"),
    toolResult("call-1", "x".repeat(16_000), "read_file"),
  ];

  const kept = dropOldestStrategy.truncate([...messages], 3_616);

  const keptCallIds = new Set(
    kept.flatMap((m) =>
      m.role === "assistant" ? m.content.filter((b) => b.type === "toolCall").map((b) => b.id) : [],
    ),
  );
  for (const m of kept) {
    if (m.role === "toolResult") {
      assert.ok(keptCallIds.has(m.toolCallId), `orphaned toolResult ${m.toolCallId} survived`);
    }
  }
  assert.ok(kept.length > 0);
});

test("REGRESSION: history ending in orphaned tool results pulls the call back in", () => {
  const messages: Message[] = [
    user("old".repeat(300)),
    assistantToolCall("call-1"),
    toolResult("call-1", "r".repeat(4_000)),
    toolResult("call-1", "s".repeat(4_000)),
  ];
  const kept = dropOldestStrategy.truncate([...messages], 50);
  const hasCall = kept.some(
    (m) => m.role === "assistant" && m.content.some((b) => b.type === "toolCall"),
  );
  assert.ok(hasCall, "kept window must include the originating toolCall");
});

test("REGRESSION: image blocks are not counted as zero tokens", () => {
  const withImage: Message = {
    role: "user",
    content: [{ type: "image", data: "A".repeat(40_000), mimeType: "image/png" }],
    timestamp: 1,
  };
  // 40k base64 chars must not estimate as ~free.
  assert.ok(estimateTokens(withImage) > 1_000, `got ${estimateTokens(withImage)}`);
});

test("REGRESSION: a conversation of images stays within budget", () => {
  const image = (): Message => ({
    role: "user",
    content: [{ type: "image", data: "B".repeat(20_000), mimeType: "image/png" }],
    timestamp: 1,
  });
  const messages = Array.from({ length: 20 }, image);
  const kept = dropOldestStrategy.truncate(messages, 10_000);
  assert.ok(estimateContextTokens(kept) <= 10_000 || kept.length === 1);
  assert.ok(kept.length < 20, "image-only history must actually be truncated");
});
