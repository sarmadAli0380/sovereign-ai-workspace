import assert from "node:assert/strict";
import test from "node:test";
import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";
import { estimateContextTokens } from "../truncation.ts";
import { ContextCompiler } from "./context-compiler.ts";
import {
  createPrefixPreservingCompactionStrategy,
  isPrefixCompactionMarker,
  readPrefixCompactionManifest,
} from "./prefix-preserving-compaction.ts";

const usage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(content: string, timestamp: number): Message {
  return { role: "user", content, timestamp };
}

function toolCall(id: string, timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "lookup", arguments: { id } }],
    api: "faux",
    provider: "faux",
    model: "faux",
    usage,
    stopReason: "toolUse",
    timestamp,
  };
}

function toolResult(id: string, content: string, timestamp: number): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "lookup",
    content: [{ type: "text", text: content }],
    isError: false,
    timestamp,
  };
}

test("preserves a stable old prefix and newest suffix within budget", () => {
  const messages = Array.from({ length: 12 }, (_, index) =>
    user(`fact-${index}:${String(index).padStart(2, "0")}-${"x".repeat(160)}`, index),
  );
  const budget = 430;
  const strategy = createPrefixPreservingCompactionStrategy({ prefixFraction: 0.3 });
  const projected = strategy.truncate(structuredClone(messages), budget);

  assert.ok(estimateContextTokens(projected) <= budget);
  assert.equal(projected[0]?.role, "user");
  assert.match(String(projected[0]?.content), /^fact-0:/);
  assert.equal(projected.at(-1)?.role, "user");
  assert.match(String(projected.at(-1)?.content), /^fact-11:/);
  assert.equal(projected.filter(isPrefixCompactionMarker).length, 1);
});

test("manifest is deterministic, content-free, versioned, and rebuildable", () => {
  const messages = Array.from({ length: 10 }, (_, index) =>
    user(`secret-${index}-${"z".repeat(180)}`, index),
  );
  const strategy = createPrefixPreservingCompactionStrategy({ prefixFraction: 0.3 });
  const first = strategy.truncate(structuredClone(messages), 390);
  const second = strategy.truncate(structuredClone(messages), 390);
  const marker = first.find(isPrefixCompactionMarker)!;
  const manifest = readPrefixCompactionManifest(marker)!;

  assert.deepEqual(first, second);
  assert.equal(manifest.summaryGenerated, false);
  assert.equal(manifest.rebuildable, true);
  assert.equal(manifest.sourceMessageCount, manifest.sourceEndIndex - manifest.sourceStartIndex + 1);
  assert.doesNotMatch(String(marker.content), /secret-[0-9]/);
  assert.match(manifest.sourceSha256, /^[a-f0-9]{64}$/);

  const changed = structuredClone(messages);
  changed[manifest.sourceStartIndex] = user("changed omitted source", manifest.sourceStartIndex);
  const changedMarker = strategy.truncate(changed, 390).find(isPrefixCompactionMarker)!;
  assert.notEqual(
    readPrefixCompactionManifest(changedMarker)?.sourceSha256,
    manifest.sourceSha256,
  );
});

test("tool calls and their results remain atomic at both projection boundaries", () => {
  const messages: Message[] = [
    user(`old-${"a".repeat(250)}`, 0),
    toolCall("call-1", 1),
    toolResult("call-1", `result-${"b".repeat(500)}`, 2),
    user(`middle-${"c".repeat(500)}`, 3),
    toolCall("call-2", 4),
    toolResult("call-2", "recent result", 5),
    user("newest question", 6),
  ];
  const projected = createPrefixPreservingCompactionStrategy({ prefixFraction: 0.3 })
    .truncate(structuredClone(messages), 360);
  const callIds = new Set(
    projected.flatMap((message) =>
      message.role === "assistant"
        ? message.content.filter((block) => block.type === "toolCall").map((block) => block.id)
        : [],
    ),
  );

  for (const message of projected) {
    if (message.role === "toolResult") assert.ok(callIds.has(message.toolCallId));
  }
  for (const callId of callIds) {
    assert.ok(
      projected.some(
        (message) => message.role === "toolResult" && message.toolCallId === callId,
      ),
    );
  }
});

test("ContextCompiler reports retained, derived, and dropped source counts exactly", () => {
  const completeHistory = Array.from({ length: 16 }, (_, index) =>
    user(`history-${index}-${"x".repeat(220)}`, index),
  );
  const compiled = new ContextCompiler({
    contextWindow: 1_000,
    outputReserveTokens: 200,
    strategy: createPrefixPreservingCompactionStrategy(),
  }).compile({ completeHistory });

  assert.equal(compiled.projection.derivedHistoryMessages, 1);
  assert.equal(
    compiled.projection.projectedHistoryMessages,
    compiled.projection.retainedHistoryMessages + compiled.projection.derivedHistoryMessages,
  );
  assert.equal(
    compiled.projection.droppedHistoryMessages,
    completeHistory.length - compiled.projection.retainedHistoryMessages,
  );
});

test("does not invent a manifest when all history fits and rejects invalid fractions", () => {
  const messages = [user("one", 1), user("two", 2)];
  const projected = createPrefixPreservingCompactionStrategy().truncate(messages, 1_000);
  assert.deepEqual(projected, messages);
  assert.equal(projected.some(isPrefixCompactionMarker), false);

  for (const fraction of [-0.1, 1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => createPrefixPreservingCompactionStrategy({ prefixFraction: fraction }),
      /prefixFraction/,
    );
  }
});

test("malformed manifest text is rejected without throwing", () => {
  const malformed: Message = {
    role: "user",
    content: "SOVEREIGN HISTORY COMPACTION MANIFEST v1\nnot-json",
    timestamp: 0,
  };
  assert.equal(readPrefixCompactionManifest(malformed), undefined);
});
