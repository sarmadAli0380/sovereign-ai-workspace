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
import { dropOldestStrategy, estimateContextTokens, type TruncationStrategy } from "./truncation.ts";

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
  /** contextWindow minus reserveTokens. */
  private readonly budget: number;
  private readonly maxToolResultChars: number;
  private readonly strategy: TruncationStrategy;

  constructor(options: ConversationManagerOptions) {
    // Scaled down for small windows — an explicit `reserveTokens` is still
    // capped, since the same arithmetic breaks whoever supplied it.
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
      ...(options.tools !== undefined ? { tools: options.tools } : {}),
    };
  }

  /**
   * Appends a message, capping it first if it's a tool result, then
   * re-truncating the whole conversation.
   */
  append(message: Message): void {
    const toAppend =
      message.role === "toolResult" ? capToolResult(message, this.maxToolResultChars) : message;

    this.context.messages.push(toAppend);
    this.context.messages = this.strategy.truncate(this.context.messages, this.budget);
  }

  /** Convenience for the common case of appending several results at once. */
  appendAll(messages: readonly Message[]): void {
    for (const message of messages) this.append(message);
  }

  getHistory(): readonly Message[] {
    return this.context.messages;
  }

  /** What actually gets passed to pi-ai's `complete()`/`stream()`. */
  getContext(): Context {
    return this.context;
  }

  /** Current estimated size, against the same heuristic truncation uses. */
  getEstimatedTokens(): number {
    return estimateContextTokens(this.context.messages);
  }

  getBudgetTokens(): number {
    return this.budget;
  }
}
