/**
 * 1.5 — ConversationManager.
 *
 * Per `phase1/adrs/1.5-conversation-manager-design.md`, the four decisions
 * locked in with the user:
 *
 *  1. Tool-result capping is in scope here, applied at append time and
 *     separately from (and prior to) whole-conversation truncation.
 *  2. Truncation is a pluggable strategy; drop-oldest is the default.
 *  3. This is a stateful class wrapping one `Context`.
 *  4. Truncation runs on every `append()`, not lazily before a call — so
 *     the Context is always within budget and nothing can build up and
 *     then blow the window right as a call goes out.
 */

import type { Context, Message, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  dropOldestStrategy,
  estimateContextTokens,
  estimateOverheadTokens,
  type TruncationStrategy,
} from "./truncation.ts";

/**
 * TUNABLE — not settled. The ADR explicitly left these open, to be revisited
 * against real usage data rather than copied blindly from precedent.
 *
 * `reserveTokens` (16384) is pi-coding-agent's value, kept because it is the
 * one number in the surveyed harnesses with a directly comparable meaning:
 * headroom left for the model's own response plus system prompt and tools.
 *
 * `maxToolResultChars` (16000) has no direct precedent to copy — the
 * surveyed harnesses range widely (Claude Code 50k/tool, OpenClaw 16k,
 * Letta clamps to 5k under pressure) and pi-coding-agent caps at
 * summarization time rather than append time, so it has no equivalent at
 * all. 16000 sits at the conservative end of that range: ~4000 tokens,
 * roughly a quarter of the default reserve. Revisit once there is a real
 * conversation to measure.
 */
export const DEFAULT_RESERVE_TOKENS = 16_384;
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 16_000;

/**
 * Fraction of the context window the reserve may occupy when the absolute
 * default would be too large.
 *
 * `DEFAULT_RESERVE_TOKENS` came from pi-coding-agent, which targets
 * 200k-context hosted models — there, 16,384 is ~6% of the window. Applied
 * to a small self-hosted model it is nonsense: an 8,192-token local model
 * has a reserve twice its entire context, and `ConversationManager` refused
 * to construct at all.
 *
 * That was a hidden assumption that every model has a large window, which
 * is precisely what a model-agnostic harness must not assume. The reserve is
 * now the *smaller* of the absolute default and this fraction, so it scales
 * down for small models while leaving large ones exactly as they were.
 *
 * TUNABLE: 25% is a judgement call, not a measurement. It leaves 75% of a
 * small window for actual history, which is the right side to err on when
 * the alternative is not working at all.
 */
export const MAX_RESERVE_FRACTION = 0.25;

/**
 * The reserve actually applied for a given window.
 *
 * Exported because callers sizing a conversation need to predict the budget
 * without constructing one.
 */
export function resolveReserveTokens(
  contextWindow: number,
  requested: number = DEFAULT_RESERVE_TOKENS,
): number {
  return Math.min(requested, Math.floor(contextWindow * MAX_RESERVE_FRACTION));
}

/**
 * Where the current size number came from.
 *
 * `"anchored"` means it is built on a token count the provider actually
 * measured; `"estimated"` means it is entirely the chars/3 heuristic. 1.8
 * requires this to be visible rather than buried — the two have very
 * different error characteristics, and a caller debugging an unexpected
 * truncation needs to know which one it got.
 */
export type BudgetSource = "anchored" | "estimated";

export interface BudgetUsage {
  tokens: number;
  source: BudgetSource;
}

/**
 * A provider-measured input size, and the message it was measured at.
 *
 * `tokens` covers the system prompt, the tools, and every message *before*
 * `messageIndex` — that is exactly the request that produced the assistant
 * message now sitting at `messageIndex`.
 */
interface UsageAnchor {
  tokens: number;
  messageIndex: number;
}

/**
 * The anchor a message provides, or `undefined` if it provides none.
 *
 * Zero input counts as *no measurement*, not as a measurement of zero: a
 * non-empty request cannot cost nothing, so a zero means the provider (or
 * the transport) did not report. `odysseus` reached the same rule from the
 * other direction, emitting a usage event only when a count is non-zero
 * after shipping a bug where usage riding on a non-empty finish delta was
 * silently dropped.
 *
 * Cache fields are added because they are input-side tokens the server
 * holds. Every measurement taken so far reported them as 0, so this is
 * arithmetic that has not yet been exercised — but omitting them would
 * understate the context on a provider that reports cached input outside
 * `input`, and understating is the dangerous direction.
 */
function anchorFrom(message: Message, messageIndex: number): UsageAnchor | undefined {
  if (message.role !== "assistant") return undefined;
  const usage = message.usage;
  if (!usage) return undefined;

  // Gate on the SUM, not on `input`. Gating on `input` discarded the
  // measurement in exactly the case caching works: pi-ai normalises OpenAI
  // usage as `input = max(0, prompt_tokens − cacheRead − cacheWrite)`
  // (`api/openai-completions.js:1069`), so a fully cached prefix arrives as
  // `input: 0, cacheRead: 8000` — a real 8000-token request that read as no
  // measurement at all, falling back to a heuristic hundreds of times
  // smaller. "A non-empty request cannot cost nothing" is true of the sum
  // and false of `input` alone.
  const tokens = usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  if (!Number.isFinite(tokens) || tokens <= 0) return undefined;

  return { tokens, messageIndex };
}

export interface ConversationManagerOptions {
  systemPrompt?: string;
  tools?: Context["tools"];
  /** From the resolved Model (1.4's `loadModel()`). */
  contextWindow: number;
  reserveTokens?: number;
  maxToolResultChars?: number;
  /** Default: drop-oldest. */
  strategy?: TruncationStrategy;
}

/**
 * Caps a tool result's text content to `maxChars` total across all blocks.
 *
 * Truncation is marked inline rather than silent — a model that sees its
 * file read was cut short can ask for a narrower range, whereas a silently
 * truncated result reads as a complete one and invites wrong conclusions.
 * Image blocks pass through untouched; they aren't measured in characters.
 */
export function capToolResult(
  message: ToolResultMessage,
  maxChars: number,
): ToolResultMessage {
  let budget = maxChars;
  let didTruncate = false;

  const content = message.content.map((block) => {
    if (block.type !== "text") return block;
    if (budget <= 0) {
      // Only a block that actually loses content counts as truncated. An
      // empty block loses nothing, and claiming otherwise tells the model
      // its result was cut short when it wasn't — the marker exists so the
      // model can re-request a narrower range, so a false one is worse
      // than none.
      if (block.text.length > 0) didTruncate = true;
      return { ...block, text: "" } satisfies TextContent;
    }
    if (block.text.length <= budget) {
      budget -= block.text.length;
      return block;
    }
    const kept = block.text.slice(0, budget);
    budget = 0;
    didTruncate = true;
    return { ...block, text: kept } satisfies TextContent;
  });

  if (!didTruncate) return message;

  const original = message.content.reduce(
    (sum, block) => sum + (block.type === "text" ? block.text.length : 0),
    0,
  );

  return {
    ...message,
    content: [
      ...content.filter((block) => block.type !== "text" || block.text.length > 0),
      {
        type: "text",
        text: `\n\n[truncated by harness: ${original} chars exceeded maxToolResultChars=${maxChars}]`,
      },
    ],
  };
}

export class ConversationManager {
  private context: Context;
  /** contextWindow minus reserveTokens. Covers the whole Context. */
  private readonly budget: number;
  /**
   * The system prompt and tool schemas, charged once.
   *
   * Fixed for the manager's lifetime: both are constructor options with no
   * setter, so this is computed once rather than on every `append()` —
   * serializing twenty JSON schemas per appended message would be real work
   * for a value that cannot change.
   */
  private readonly overheadTokens: number;
  /** What is left of `budget` for messages, after the overhead floor. */
  private readonly messageBudget: number;
  private readonly maxToolResultChars: number;
  private readonly strategy: TruncationStrategy;
  /**
   * The most recent provider-measured input size, if there is one.
   *
   * Undefined until a response reports usage, and again after any
   * truncation — see `append()`.
   */
  private anchor: UsageAnchor | undefined;

  constructor(options: ConversationManagerOptions) {
    // Scaled down for small windows — an explicit `reserveTokens` is still
    // capped, since the same arithmetic breaks whoever supplied it.
    // Checked with `Number.isFinite`, not truthiness, and checked here
    // rather than downstream. `NaN <= 0` is `false`, so a NaN window sailed
    // past both guards below and produced a NaN budget — which no message
    // can ever exceed, disabling truncation entirely while every accessor
    // still reported success. Rejecting the input is the only place this
    // can be caught once.
    if (!Number.isFinite(options.contextWindow)) {
      throw new Error(
        `contextWindow must be a finite number, got ${options.contextWindow}. ` +
          `A non-finite window disables truncation rather than widening it.`,
      );
    }
    if (options.reserveTokens !== undefined && !Number.isFinite(options.reserveTokens)) {
      throw new Error(`reserveTokens must be a finite number, got ${options.reserveTokens}.`);
    }

    const reserve = resolveReserveTokens(
      options.contextWindow,
      options.reserveTokens ?? DEFAULT_RESERVE_TOKENS,
    );
    this.budget = options.contextWindow - reserve;

    if (this.budget <= 0) {
      throw new Error(
        `contextWindow (${options.contextWindow}) is too small to hold any messages after a reserve of ${reserve}.`,
      );
    }

    this.maxToolResultChars = options.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;
    this.strategy = options.strategy ?? dropOldestStrategy;

    this.context = {
      ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
      messages: [],
      // Copied, not aliased. `overheadTokens` below is computed once from
      // these, so a caller mutating the array they passed in would change
      // what gets sent while the cached cost stayed stale — and the doc on
      // `overheadTokens` promises they are fixed for this object's lifetime.
      // A copy is what makes that promise true rather than aspirational.
      ...(options.tools !== undefined ? { tools: [...options.tools] } : {}),
    };

    // 1.8: the system prompt and tool schemas are sent on every request and
    // no strategy can drop them, so they come off the budget up front rather
    // than being handed to truncation as if they were negotiable.
    this.overheadTokens = estimateOverheadTokens(this.context);
    this.messageBudget = this.budget - this.overheadTokens;

    if (this.messageBudget <= 0) {
      // A conversation that can never hold a single message is a
      // configuration error, not a runtime condition — a caller registering
      // this many tools against this window has nothing to send.
      throw new Error(
        `contextWindow (${options.contextWindow}) leaves no room for messages: ` +
          `a reserve of ${reserve} plus ${this.overheadTokens} tokens of system prompt ` +
          `and tool schemas already exhausts it.`,
      );
    }
  }

  /**
   * Appends a message, capping it first if it's a tool result, then
   * re-truncating the whole conversation.
   */
  append(message: Message): void {
    const toAppend =
      message.role === "toolResult" ? capToolResult(message, this.maxToolResultChars) : message;

    const previous = this.context.messages;
    previous.push(toAppend);

    // Anchor before truncating: this measurement describes a request that
    // has already gone out, so it is a fact about the past regardless of
    // what truncation is about to do to the future. A response that carries
    // no usable usage does NOT clear the anchor — it simply fails to
    // advance it, and the estimated span widens by one turn. Usage absence
    // is a per-response transport event, not a provider losing the ability
    // to report.
    const anchored = anchorFrom(toAppend, previous.length - 1);
    if (anchored) this.anchor = anchored;

    let kept = this.strategy.truncate(previous, this.truncationBudget());

    // Truncation invalidates the anchor: its token count covered messages
    // that are no longer here, so it now describes a conversation that does
    // not exist. Reducing it correctly is possible but fiddly and easy to
    // get subtly wrong; dropping it is conservative and self-healing, since
    // the very next response re-anchors.
    if (kept.length !== previous.length || kept[0] !== previous[0]) {
      this.anchor = undefined;

      // ...and then truncate AGAIN, against the unanchored budget.
      //
      // The first pass ran against a budget widened by the anchor. Once the
      // anchor is gone that allowance is gone with it, and the set it kept
      // can be well over the plain budget — measured at 4013 tokens against
      // a 3000 budget. Leaving it would break decision 4 in this class's
      // doc comment ("the Context is always within budget") at the worst
      // possible moment, since `append()` is the last thing to run before a
      // call goes out. The old code self-healed on the *next* append, one
      // turn too late.
      kept = this.strategy.truncate(kept, this.messageBudget);
    }

    this.context.messages = kept;
  }

  /**
   * The budget handed to the truncation strategy, in the strategy's own
   * units.
   *
   * A strategy measures the whole message list with the heuristic (1.5's
   * contract, unchanged). When an anchor exists, the prefix it covers has a
   * *measured* cost that the heuristic will get wrong — so rather than
   * change the strategy interface, the budget is shifted by the difference:
   * give back whatever heuristic weight the anchored prefix carries, and
   * take away what it actually cost.
   *
   *   allowed = budget − anchor.tokens + heuristic(anchored prefix)
   *
   * The strategy then enforces `heuristic(kept) <= allowed`, which reduces
   * exactly to `heuristic(suffix) <= budget − anchor.tokens` — the
   * condition we want — for as long as it keeps the prefix intact. If it
   * drops into the prefix, the anchor is invalidated above and the next
   * turn re-derives everything.
   *
   * Note `this.budget`, not `this.messageBudget`: the anchor is a measured
   * *request* size, so the system prompt and tool schemas are already
   * inside it. Subtracting the overhead again would double-charge it.
   */
  private truncationBudget(): number {
    if (!this.anchor) return this.messageBudget;
    const prefix = estimateContextTokens(this.context.messages.slice(0, this.anchor.messageIndex));
    return Math.max(0, this.budget - this.anchor.tokens + prefix);
  }

  /** Convenience for the common case of appending several results at once. */
  appendAll(messages: readonly Message[]): void {
    for (const message of messages) this.append(message);
  }

  /**
   * A snapshot of the history.
   *
   * Copied rather than handed out live. `append()` pushes into the array and
   * then replaces it wholesale on truncation, so a caller holding an earlier
   * result ended up with a list that was neither the old history nor the
   * current one — it had seen some appends and none of the truncation. A
   * snapshot is at least a coherent moment in time.
   */
  getHistory(): readonly Message[] {
    return [...this.context.messages];
  }

  /** What actually gets passed to pi-ai's `complete()`/`stream()`. */
  getContext(): Context {
    return this.context;
  }

  /**
   * Current size of the whole Context — messages *and* the system prompt
   * and tool schemas — anchored on a measured count where one is available.
   *
   * Comparable against `getBudgetTokens()`. Before 1.8 this counted messages
   * only, which made the pair incomparable and under-reported every
   * conversation by the fixed overhead.
   */
  getEstimatedTokens(): number {
    return this.getBudgetUsage().tokens;
  }

  /**
   * The same number, with its provenance.
   *
   * Anchored: a provider-measured input plus the heuristic over only what
   * has been appended since. The heuristic's error then applies to one
   * turn's delta instead of compounding over the whole history — which is
   * the actual defect 1.8 fixes. Per-turn accuracy stays mediocre
   * (measured: −38 tokens on codex, +1046 on qwen3:4b) and that is fine,
   * because the next response re-anchors on truth.
   *
   * Estimated: the pure heuristic over everything, which is what the whole
   * conversation used to get.
   */
  getBudgetUsage(): BudgetUsage {
    if (!this.anchor) {
      return {
        tokens: estimateContextTokens(this.context.messages) + this.overheadTokens,
        source: "estimated",
      };
    }
    return {
      tokens:
        this.anchor.tokens +
        estimateContextTokens(this.context.messages.slice(this.anchor.messageIndex)),
      source: "anchored",
    };
  }

  /** The non-message part of the estimate: system prompt plus tool schemas. */
  getOverheadTokens(): number {
    return this.overheadTokens;
  }

  /** contextWindow minus the reserve — the allowance for the whole Context. */
  getBudgetTokens(): number {
    return this.budget;
  }
}
