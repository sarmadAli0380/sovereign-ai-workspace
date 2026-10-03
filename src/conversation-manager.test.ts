import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import type { AssistantMessage, Message, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import {
  capToolResult,
  ConversationManager,
  DEFAULT_RESERVE_TOKENS,
} from "./conversation-manager.ts";
import { ContextCompilationError } from "./context/context-compiler.ts";
import { runtimeMessageToProductEnvelope } from "./messages/codec.ts";
import type { MessageRepository, StoredMessage } from "./storage/repositories/messages.ts";
import { estimateContextTokens, type TruncationStrategy } from "./truncation.ts";

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

test("rejects a negative reserve instead of widening the context window", () => {
  assert.throws(
    () => new ConversationManager({ contextWindow: 100, reserveTokens: -50 }),
    /reserveTokens must be a finite non-negative whole number/,
  );
});

test("rejects an unusable tool-result cap", () => {
  assert.throws(
    () => new ConversationManager({ contextWindow: 100, maxToolResultChars: Number.NaN }),
    /maxToolResultChars must be a finite non-negative whole number/,
  );
});

test("projection strategy runs for the provider view, not durable append", () => {
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

  assert.deepEqual(calls, []);
  assert.equal(cm.getHistory().length, 3);
  assert.equal(cm.getProviderHistory().length, 3);
  assert.deepEqual(calls, [3]);
});

test("the provider Context stays within budget as complete history accumulates", () => {
  const cm = new ConversationManager({
    contextWindow: 2_000,
    maxToolResultChars: 500,
  });

  for (let i = 0; i < 50; i++) cm.append(user(`message ${i} `.repeat(20)));

  assert.ok(cm.getEstimatedTokens() <= cm.getBudgetTokens());
  assert.equal(cm.getHistory().length, 50);
  assert.ok(cm.getProviderHistory().length < 50);
});

test("a custom strategy is used for provider projection instead of drop-oldest", () => {
  const keepLastOnly: TruncationStrategy = {
    truncate: (messages) => messages.slice(-1),
  };
  const cm = new ConversationManager({ contextWindow: 200_000, strategy: keepLastOnly });
  cm.appendAll([user("a"), user("b"), user("c")]);
  assert.equal(cm.getHistory().length, 3);
  assert.equal(cm.getProviderHistory().length, 1);
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

  assert.equal(withoutPrompt.getProviderHistory().length, 3, "control: all three fit the raw budget");
  assert.ok(
    withPrompt.getProviderHistory().length < 3,
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

test("a zero context window is rejected at the input boundary", () => {
  assert.throws(
    () => new ConversationManager({ contextWindow: 0, systemPrompt: "s" }),
    /contextWindow must be a finite positive whole number/,
  );
});

// --- 1.8 stage 2: anchoring on a provider-measured input

function assistantWithUsage(text: string, input: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "faux",
    provider: "faux",
    model: "m",
    usage: { ...usage, input, totalTokens: input },
    stopReason: "stop",
    timestamp: 1,
  };
}

test("a response with usage anchors the estimate", () => {
  const cm = new ConversationManager({ contextWindow: 200_000 });
  cm.append(user("hello"));
  assert.equal(cm.getBudgetUsage().source, "estimated");

  cm.append(assistantWithUsage("hi", 900));
  const anchored = cm.getBudgetUsage();
  assert.equal(anchored.source, "anchored");
  // 900 measured for everything before the assistant turn, plus the
  // heuristic over the assistant turn itself.
  assert.equal(anchored.tokens, 900 + estimateContextTokens([assistantWithUsage("hi", 900)]));
});

test("the anchored estimate ignores the heuristic's view of the anchored prefix", () => {
  const cm = new ConversationManager({ contextWindow: 200_000 });
  // A huge first message whose heuristic weight is nothing like what the
  // provider charged — the qwen3:4b case, where thinking is counted here and
  // never replayed on the wire.
  cm.append(user("q".repeat(30_000)));
  const heuristicOnly = cm.getEstimatedTokens();
  cm.append(assistantWithUsage("ok", 125));

  const anchored = cm.getBudgetUsage();
  assert.equal(anchored.source, "anchored");
  assert.ok(
    anchored.tokens < heuristicOnly / 10,
    `anchored ${anchored.tokens} must reflect the measured 125, not the heuristic ${heuristicOnly}`,
  );
});

test("the anchor does not double-count the system prompt and tools", () => {
  // A measured input already includes them, so they must not be added again.
  const cm = new ConversationManager({
    contextWindow: 200_000,
    systemPrompt: "s".repeat(3_000),
  });
  cm.append(user("hello"));
  const assistantMessage = assistantWithUsage("hi", 500);
  cm.append(assistantMessage);

  assert.equal(
    cm.getBudgetUsage().tokens,
    500 + estimateContextTokens([assistantMessage]),
    "overhead is inside the measured 500 and must not be charged twice",
  );
});

test("zero reported input counts as no measurement, not a measurement of zero", () => {
  const cm = new ConversationManager({ contextWindow: 200_000 });
  cm.append(user("hello"));
  cm.append(assistantWithUsage("hi", 0));
  assert.equal(cm.getBudgetUsage().source, "estimated");
});

test("a silent response does not clear the anchor, it just fails to advance it", () => {
  const cm = new ConversationManager({ contextWindow: 200_000 });
  cm.append(user("hello"));
  cm.append(assistantWithUsage("hi", 900));
  const afterAnchor = cm.getBudgetUsage();

  cm.append(user("again"));
  cm.append(assistantWithUsage("no usage this time", 0));

  const afterSilence = cm.getBudgetUsage();
  assert.equal(afterSilence.source, "anchored", "one silent turn must not discard a measurement");
  assert.ok(
    afterSilence.tokens > afterAnchor.tokens,
    "the estimated span widens by the turns since the anchor",
  );
});

test("truncation invalidates the anchor", () => {
  const cm = new ConversationManager({ contextWindow: 1_200 });
  cm.append(user("a".repeat(600)));
  cm.append(assistantWithUsage("ok", 200));
  assert.equal(cm.getBudgetUsage().source, "anchored");

  // Enough to force eviction of the anchored prefix: budget is 900 and the
  // anchor allows ~904 heuristic tokens, so one 2400-char message (~804)
  // forces the prefix out while still fitting after the anchor is dropped.
  cm.append(user("b".repeat(2_400)));

  assert.equal(
    cm.getBudgetUsage().source,
    "estimated",
    "an anchor describing dropped messages must not survive",
  );
});

test("the anchor tightens the truncation budget when the heuristic ran low", () => {
  // The codex case: the harness's record of a turn understates what the
  // provider actually charged, so an anchored conversation must evict
  // sooner than the heuristic alone would.
  const build = (anchorTokens: number | undefined) => {
    const cm = new ConversationManager({ contextWindow: 4_000 });
    cm.append(user("a".repeat(900)));
    cm.append(
      anchorTokens === undefined
        ? assistantWithUsage("ok", 0)
        : assistantWithUsage("ok", anchorTokens),
    );
    cm.append(user("b".repeat(900)));
    cm.append(user("c".repeat(900)));
    return cm;
  };

  const unanchored = build(undefined);
  const anchored = build(2_800);

  assert.ok(
    anchored.getProviderHistory().length < unanchored.getProviderHistory().length,
    `a measured 2800 must evict more than the heuristic did ` +
      `(${anchored.getProviderHistory().length} vs ${unanchored.getProviderHistory().length})`,
  );
});

test("the anchor loosens the truncation budget when the heuristic ran high", () => {
  // The qwen case: 30k characters the harness counts and the server never
  // replays. A measured input proves the room exists.
  const build = (anchorTokens: number) => {
    const cm = new ConversationManager({ contextWindow: 4_000 });
    cm.append(user("a".repeat(9_000)));
    cm.append(assistantWithUsage("ok", anchorTokens));
    cm.append(user("b".repeat(900)));
    return cm;
  };

  const unanchored = build(0);
  const anchored = build(120);

  assert.ok(
    anchored.getProviderHistory().length > unanchored.getProviderHistory().length,
    `a measured 120 must keep more than a 3000-token heuristic guess ` +
      `(${anchored.getProviderHistory().length} vs ${unanchored.getProviderHistory().length})`,
  );
});

test("PROPERTY: anchored error stays bounded by one turn, unanchored error compounds", () => {
  // The qwen probe in miniature: every assistant turn carries thinking the
  // harness counts and the wire never replays, so the heuristic drifts
  // further from truth with every turn while the anchor re-bases each time.
  const cm = new ConversationManager({ contextWindow: 200_000 });
  const REAL = [75, 125, 160]; // measured inputs from the probe

  let worstAnchoredError = 0;
  for (const [turn, measured] of REAL.entries()) {
    cm.append(user("ask something".repeat(3)));
    // A turn whose recorded content is ~1000 tokens but costs `measured`.
    cm.append(assistantWithUsage("t".repeat(3_000), measured));

    const anchoredError = Math.abs(cm.getBudgetUsage().tokens - measured);
    worstAnchoredError = Math.max(worstAnchoredError, anchoredError);

    const pureHeuristic = estimateContextTokens(cm.getHistory()) + cm.getOverheadTokens();
    const heuristicError = Math.abs(pureHeuristic - measured);

    if (turn > 0) {
      assert.ok(
        heuristicError > anchoredError,
        `turn ${turn}: the pure heuristic must be further from truth than the anchor`,
      );
    }
  }

  // One turn's delta, not three turns' worth: ~1000 tokens of recorded
  // content per turn, so a bound of 2000 proves it is not accumulating.
  assert.ok(worstAnchoredError < 2_000, `anchored error grew to ${worstAnchoredError}`);
});

// --- QA findings 1, 2, 4

test("a non-finite contextWindow is rejected instead of disabling truncation", () => {
  for (const window of [NaN, Infinity, -Infinity]) {
    assert.throws(
      () => new ConversationManager({ contextWindow: window }),
      /contextWindow must be a finite positive whole number/,
      `contextWindow ${window} must be rejected`,
    );
  }
  assert.throws(
    () => new ConversationManager({ contextWindow: 8_192, reserveTokens: NaN }),
    /reserveTokens must be a finite non-negative whole number/,
  );
});

test("REGRESSION: a NaN window does not silently accept unbounded history", () => {
  // Reachable from one typo'd field in local-providers.json: an undefined
  // contextWindow made budget NaN, and `NaN <= 0` is false, so every guard
  // passed and no message ever exceeded the budget.
  assert.throws(() => new ConversationManager({ contextWindow: NaN }), /finite/);
});

test("REGRESSION: append() leaves the Context within budget even when the anchor is dropped", () => {
  // The anchor widens the truncation budget. If that pass then cuts into the
  // anchored prefix, the widening is no longer justified and the kept set
  // must be re-checked — the old code deferred that to the next append.
  const cm = new ConversationManager({ contextWindow: 4_000 });
  cm.append(user("m".repeat(9_000))); // ~3004, immediately over budget alone
  cm.append(assistantWithUsage("ok", 10)); // provider says the request was tiny
  cm.append(user("u1".repeat(1_500)));
  cm.append(user("u2".repeat(3_000)));

  assert.ok(
    cm.getEstimatedTokens() <= cm.getBudgetTokens(),
    `estimate ${cm.getEstimatedTokens()} must not exceed budget ${cm.getBudgetTokens()}`,
  );
});

test("PROPERTY: the budget invariant holds after every append, anchored or not", () => {
  // Randomised: interleave sized messages with anchors whose measured value
  // is deliberately unrelated to the heuristic, which is what produces the
  // widened budget in the first place.
  let seed = 7;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };

  for (let trial = 0; trial < 200; trial += 1) {
    const cm = new ConversationManager({ contextWindow: 2_000 + rand(6_000) });
    for (let i = 0; i < 12; i += 1) {
      if (rand(3) === 0) {
        cm.append(assistantWithUsage("r".repeat(rand(400)), rand(3_000)));
      } else {
        cm.append(user("x".repeat(rand(4_000))));
      }
      let tokens: number;
      try {
        tokens = cm.getBudgetUsage().tokens;
      } catch (error) {
        assert.ok(
          error instanceof ContextCompilationError,
          `unexpected error ${(error as Error).message}`,
        );
        continue;
      }
      assert.ok(
        tokens <= cm.getBudgetTokens() || cm.getProviderHistory().length === 1,
        `trial ${trial} step ${i}: ${tokens} > ${cm.getBudgetTokens()} with ${cm.getProviderHistory().length} provider messages`,
      );
    }
  }
});

test("REGRESSION: a fully cached request still anchors", () => {
  // pi-ai reports `input = max(0, prompt - cacheRead - cacheWrite)`, so a
  // fully cached prefix arrives as input 0 with the real size in cacheRead.
  // Gating on `input` threw that measurement away exactly when caching worked.
  const cached: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    api: "faux",
    provider: "faux",
    model: "m",
    usage: { ...usage, input: 0, cacheRead: 8_000, totalTokens: 8_000 },
    stopReason: "stop",
    timestamp: 1,
  };

  const cm = new ConversationManager({ contextWindow: 200_000 });
  cm.append(user("hello"));
  cm.append(cached);

  const budget = cm.getBudgetUsage();
  assert.equal(budget.source, "anchored");
  assert.ok(budget.tokens > 8_000, `got ${budget.tokens}, expected the 8000 cached tokens counted`);
});

test("a genuinely empty usage still reports no measurement", () => {
  const cm = new ConversationManager({ contextWindow: 200_000 });
  cm.append(user("hello"));
  cm.append(assistantWithUsage("hi", 0)); // all usage fields zero
  assert.equal(cm.getBudgetUsage().source, "estimated");
});

// --- QA finding 10: no live internals handed to callers

test("REGRESSION: getHistory() returns a snapshot, not a live array", () => {
  const cm = new ConversationManager({ contextWindow: 200_000 });
  cm.append(user("a"));
  const held = cm.getHistory();
  cm.append(user("b"));
  assert.equal(held.length, 1, "an earlier snapshot must not grow underneath its holder");
  assert.equal(cm.getHistory().length, 2);
});

test("REGRESSION: mutating the caller's tools array cannot desync the overhead", () => {
  const tools = [{ name: "a", description: "d", parameters: Type.Object({}) }];
  const cm = new ConversationManager({ contextWindow: 200_000, tools });
  const overheadBefore = cm.getOverheadTokens();
  cm.append(user("hello"));

  tools.push({ name: "b", description: "d".repeat(500), parameters: Type.Object({}) });

  assert.equal(cm.getContext().tools?.length, 1, "the manager must not see the late addition");
  assert.equal(cm.getOverheadTokens(), overheadBefore);
});

test("REGRESSION: getContext returns a snapshot that cannot bypass budgeting", () => {
  const cm = new ConversationManager({ contextWindow: 1_000, systemPrompt: "short" });
  cm.append(user("kept"));

  const snapshot = cm.getContext();
  snapshot.systemPrompt = "x".repeat(10_000);
  snapshot.messages.push(user("y".repeat(10_000)));

  assert.equal(cm.getContext().systemPrompt, "short");
  assert.equal(cm.getHistory().length, 1);
  assert.ok(cm.getEstimatedTokens() <= cm.getBudgetTokens());
});

test("REGRESSION: append owns the message instead of retaining a mutable alias", () => {
  const cm = new ConversationManager({ contextWindow: 1_000 });
  const message = user("original");
  cm.append(message);
  message.content = "changed after append";

  assert.equal(cm.getHistory()[0]?.role, "user");
  assert.equal((cm.getHistory()[0] as { content: string }).content, "original");
});

// --- B2: complete durable history versus bounded provider projection

function storedRuntimeMessages(messages: readonly Message[]): StoredMessage[] {
  return messages.map((message, index) => ({
    conversationId: "conversation-1",
    seq: index,
    message: runtimeMessageToProductEnvelope(message, {
      messageId: `message-${index}`,
      configKey: "faux-default",
    }),
    storedAt: new Date(message.timestamp).toISOString(),
  }));
}

function fakeMessageRepository(rows: readonly StoredMessage[]): MessageRepository {
  return {
    async listAllCurrent() {
      return [...rows];
    },
    async listCurrent(_conversationId: string, options: { afterSeq?: number; limit?: number } = {}) {
      return rows
        .filter((row) => row.seq > (options.afterSeq ?? -1))
        .slice(0, options.limit ?? rows.length);
    },
  } as unknown as MessageRepository;
}

test("B2: reload keeps complete current history and projects a bounded provider context", async () => {
  const rows = storedRuntimeMessages(Array.from({ length: 30 }, (_, index) => user(`m${index} `.repeat(50))));
  const cm = await ConversationManager.loadCurrent({
    conversationId: "conversation-1",
    repository: fakeMessageRepository(rows),
    contextWindow: 2_000,
  });

  assert.equal(cm.getHistory().length, 30);
  assert.ok(cm.getProviderHistory().length < 30);
  assert.ok(cm.compileContext().allocation.totalInputTokens <= cm.getBudgetTokens());
});

test("B2: full reload rebuilds an anchor, while partial reload is estimated", async () => {
  const rows = storedRuntimeMessages([
    user("first"),
    assistantWithUsage("anchored", 900),
    user("after"),
  ]);

  const full = await ConversationManager.loadCurrent({
    conversationId: "conversation-1",
    repository: fakeMessageRepository(rows),
    contextWindow: 200_000,
  });
  assert.equal(full.getBudgetUsage().source, "anchored");

  const partial = await ConversationManager.loadCurrent({
    conversationId: "conversation-1",
    repository: fakeMessageRepository(rows),
    afterSeq: 0,
    contextWindow: 200_000,
  });
  assert.equal(partial.getHistory().length, 2);
  assert.equal(partial.getBudgetUsage().source, "estimated");
});

test("B2: reload uses the current-message view, so superseded rows supplied by storage stay out", async () => {
  const current = storedRuntimeMessages([user("new"), assistantWithUsage("current", 80)]);
  const cm = await ConversationManager.loadCurrent({
    conversationId: "conversation-1",
    repository: fakeMessageRepository(current),
    contextWindow: 200_000,
  });

  assert.deepEqual(
    cm.getHistory().map((message) =>
      message.role === "user"
        ? (Array.isArray(message.content) ? message.content[0] : message.content)
        : message.role === "assistant"
          ? message.content[0]
          : undefined,
    ),
    [{ type: "text", text: "new" }, { type: "text", text: "current" }],
  );
});

test("B2: reload and projection keep a tool call/result span atomic", async () => {
  const toolCall: AssistantMessage = {
    ...assistantWithUsage("", 200),
    content: [{ type: "toolCall", id: "call-atomic", name: "read_file", arguments: {} }],
    stopReason: "toolUse",
  };
  const result = toolResult("tool output", "call-atomic");
  const runtime = [
    ...Array.from({ length: 20 }, (_, index) => user(`old-${index}-${"x".repeat(200)}`)),
    toolCall,
    result,
    user("newest"),
  ];
  const cm = await ConversationManager.loadCurrent({
    conversationId: "conversation-1",
    repository: fakeMessageRepository(storedRuntimeMessages(runtime)),
    contextWindow: 1_200,
  });

  assert.equal(cm.getHistory().length, runtime.length);
  const providerHistory = cm.getProviderHistory();
  const hasCall = providerHistory.some(
    (message) =>
      message.role === "assistant" &&
      message.content.some((block) => block.type === "toolCall" && block.id === "call-atomic"),
  );
  const hasResult = providerHistory.some(
    (message) => message.role === "toolResult" && message.toolCallId === "call-atomic",
  );
  assert.equal(hasResult, hasCall, "provider projection must retain or drop the span together");
});
