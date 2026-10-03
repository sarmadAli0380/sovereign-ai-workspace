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
 * B2 revises decision 4 for the product: complete conversation history is
 * durable, and truncation is a bounded provider projection computed for
 * each call. `append()` must not delete history.
 */

import type { Context, Message, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import { cloneData } from "./clone-data.ts";
import {
  ContextCompiler,
  type ContextBudgetSource,
  type CompiledProviderContext,
} from "./context/context-compiler.ts";
import {
  dropOldestStrategy,
  estimateOverheadTokens,
  type TruncationStrategy,
} from "./truncation.ts";
import { productEnvelopeToRuntimeMessage } from "./messages/codec.ts";
import type { MessageRepository } from "./storage/repositories/messages.ts";

function assertNonNegativeWholeNumber(name: string, value: number): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative whole number, got ${value}.`);
  }
}

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
  if (!Number.isFinite(contextWindow) || !Number.isInteger(contextWindow) || contextWindow <= 0) {
    throw new Error(`contextWindow must be a finite positive whole number, got ${contextWindow}.`);
  }
  assertNonNegativeWholeNumber("reserveTokens", requested);
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
export type BudgetSource = ContextBudgetSource;

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

export interface LoadConversationOptions extends ConversationManagerOptions {
  conversationId: string;
  repository: MessageRepository;
  /** Omit both range fields to load the complete current history. */
  afterSeq?: number;
  limit?: number;
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
  assertNonNegativeWholeNumber("maxToolResultChars", maxChars);
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
  private readonly compiler: ContextCompiler;
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
  private readonly maxToolResultChars: number;
  private loadedFromStart = true;
  /**
   * The most recent provider-measured input size, if there is one.
   *
   * Undefined until a response reports usage, or after a partial load where
   * the measured prefix is unavailable.
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
    if (
      !Number.isFinite(options.contextWindow) ||
      !Number.isInteger(options.contextWindow) ||
      options.contextWindow <= 0
    ) {
      throw new Error(
        `contextWindow must be a finite positive whole number, got ${options.contextWindow}. ` +
          `A non-finite window disables truncation rather than widening it.`,
      );
    }
    if (options.reserveTokens !== undefined) {
      assertNonNegativeWholeNumber("reserveTokens", options.reserveTokens);
    }
    if (options.maxToolResultChars !== undefined) {
      assertNonNegativeWholeNumber("maxToolResultChars", options.maxToolResultChars);
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
    const strategy = options.strategy ?? dropOldestStrategy;

    this.context = {
      ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
      messages: [],
      // Copied, not aliased. `overheadTokens` below is computed once from
      // these, so a caller mutating the array they passed in would change
      // what gets sent while the cached cost stayed stale — and the doc on
      // `overheadTokens` promises they are fixed for this object's lifetime.
      // A copy is what makes that promise true rather than aspirational.
      ...(options.tools !== undefined ? { tools: cloneData(options.tools) } : {}),
    };
    this.compiler = new ContextCompiler({
      contextWindow: options.contextWindow,
      outputReserveTokens: reserve,
      ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
      ...(options.tools !== undefined ? { tools: options.tools } : {}),
      strategy,
    });

    // 1.8: the system prompt and tool schemas are sent on every request and
    // no strategy can drop them, so they come off the budget up front rather
    // than being handed to truncation as if they were negotiable.
    this.overheadTokens = estimateOverheadTokens(this.context);
    const messageBudget = this.budget - this.overheadTokens;

    if (messageBudget <= 0) {
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

  static async loadCurrent(options: LoadConversationOptions): Promise<ConversationManager> {
    const isCompleteLoad = options.afterSeq === undefined && options.limit === undefined;
    const rows = isCompleteLoad
      ? await options.repository.listAllCurrent(options.conversationId)
      : await options.repository.listCurrent(options.conversationId, {
          ...(options.afterSeq !== undefined ? { afterSeq: options.afterSeq } : {}),
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
        });
    const manager = new ConversationManager(options);
    manager.context.messages = rows.map((row) => productEnvelopeToRuntimeMessage(row.message));
    manager.loadedFromStart = isCompleteLoad || (options.afterSeq ?? -1) === -1;
    manager.rebuildAnchor();
    return manager;
  }

  /** Appends a message to complete history, capping tool results first. */
  append(message: Message): void {
    // Own the stored value. Otherwise a caller can mutate a message after
    // append and bypass both token accounting and tool-result capping.
    const owned = cloneData(message);
    const toAppend =
      owned.role === "toolResult" ? capToolResult(owned, this.maxToolResultChars) : owned;

    this.context.messages.push(toAppend);

    // A response that carries no usable usage does NOT clear the anchor —
    // it simply fails to advance it, and the estimated span widens by one
    // turn. A partial load cannot safely anchor because the measured prefix
    // may be outside memory.
    const anchored = this.loadedFromStart
      ? anchorFrom(toAppend, this.context.messages.length - 1)
      : undefined;
    if (anchored) this.anchor = anchored;
  }

  private rebuildAnchor(): void {
    this.anchor = undefined;
    if (!this.loadedFromStart) return;
    for (const [index, message] of this.context.messages.entries()) {
      const anchored = anchorFrom(message, index);
      if (anchored) this.anchor = anchored;
    }
  }

  /** Convenience for the common case of appending several results at once. */
  appendAll(messages: readonly Message[]): void {
    for (const message of messages) this.append(message);
  }

  /**
   * A snapshot of the history.
   *
   * Copied rather than handed out live. This is the complete loaded
   * transcript, not necessarily what the provider sees on the next call.
   */
  getHistory(): readonly Message[] {
    return cloneData(this.context.messages);
  }

  /**
   * What gets passed to pi-ai's `complete()`/`stream()`.
   *
   * Returned as an owned snapshot. Exposing the live object let callers add
   * messages or mutate the system prompt/tool schemas without re-running
   * projection or recomputing the cached overhead, breaking the class's core
   * provider-budget invariant.
   */
  getContext(): Context {
    // Preserve the manager's established empty-context contract so callers
    // such as `step()` can run their normal pre-flight validation and return
    // a structured invalid-context result. A provider projection is only
    // meaningful once there is something to send.
    if (this.context.messages.length === 0) return cloneData(this.context);
    return this.compileContext().context;
  }

  /** The A0-P.1 provider projection, allocation evidence, and safe fingerprint. */
  compileContext(): CompiledProviderContext {
    return this.compiler.compile({
      completeHistory: this.context.messages,
      ...(this.anchor ? { historyAnchor: this.anchor } : {}),
    });
  }

  /** The message slice used for the next provider call. */
  getProviderHistory(): readonly Message[] {
    return cloneData(this.compileContext().context.messages);
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
    if (this.context.messages.length === 0) {
      return {
        tokens: this.overheadTokens,
        source: "estimated",
      };
    }
    return this.compileContext().budgetUsage;
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
