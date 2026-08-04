/**
 * 1.5 — Truncation strategies.
 *
 * Per `phase1/adrs/1.5-conversation-manager-design.md`, truncation is a
 * pluggable strategy with drop-oldest as the Phase 1 default, so
 * summarization can be swapped in later without touching
 * `ConversationManager` itself.
 *
 * The ADR fixed the contract (walk backwards from newest; never separate a
 * ToolCall from its ToolResultMessage) and explicitly left the cut-point
 * algorithm to implementation time. What follows is that algorithm.
 */

import type { Message, ToolCall } from "@earendil-works/pi-ai";

export interface TruncationStrategy {
  /**
   * Returns a trimmed message list that fits within `budgetTokens`.
   * Must never separate a ToolCall from its ToolResultMessage.
   */
  truncate(messages: Message[], budgetTokens: number): Message[];
}

/**
 * Token estimate: chars / 4.
 *
 * Same heuristic pi-coding-agent uses — deliberately no tokenizer
 * dependency, and deliberately conservative (it overestimates, so the
 * budget is never blown by an underestimate).
 *
 * TUNABLE: 4 chars/token is an English-text average. Code and non-Latin
 * scripts run denser; if real usage shows the estimate drifting, this
 * divisor is the knob.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Character cost charged for an image block.
 *
 * Images have no text to measure, and counting them as zero — which this
 * did originally — breaks the "always within budget" guarantee outright:
 * a conversation of screenshots reported 100/100 tokens while actually
 * holding megabytes of base64.
 *
 * The base64 payload length is used as the char count. That badly
 * overestimates what providers *bill* for an image (typically ~1–2k
 * tokens), but it is honest about what is actually being carried, and
 * this heuristic's stated contract is to overestimate rather than
 * underestimate. TUNABLE: switch to a flat per-image constant if image
 * traffic turns out to evict too aggressively.
 */
function imageChars(block: { data?: string }): number {
  return block.data?.length ?? 0;
}

export function estimateTokens(message: Message): number {
  let chars = 0;

  switch (message.role) {
    case "user":
      chars =
        typeof message.content === "string"
          ? message.content.length
          : message.content.reduce(
              (sum, block) =>
                sum + (block.type === "text" ? block.text.length : imageChars(block)),
              0,
            );
      break;

    case "assistant":
      for (const block of message.content) {
        if (block.type === "text") chars += block.text.length;
        else if (block.type === "thinking") chars += block.thinking.length;
        else if (block.type === "toolCall") {
          chars += block.name.length + JSON.stringify(block.arguments ?? {}).length;
        }
      }
      break;

    case "toolResult":
      chars =
        message.toolName.length +
        message.content.reduce(
          (sum, block) => sum + (block.type === "text" ? block.text.length : imageChars(block)),
          0,
        );
      break;
  }

  // Per-message overhead for role framing and delimiters, which every
  // provider adds and none of them bills as zero.
  // TUNABLE: 4 is a rough constant, not a measured value.
  return Math.ceil(chars / CHARS_PER_TOKEN) + 4;
}

export function estimateContextTokens(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) total += estimateTokens(message);
  return total;
}

function toolCallIds(message: Message): string[] {
  if (message.role !== "assistant") return [];
  return message.content
    .filter((block): block is ToolCall => block.type === "toolCall")
    .map((block) => block.id);
}

/**
 * True when `messages.slice(start)` contains no `toolResult` whose
 * originating `toolCall` falls outside the window.
 */
function isValidStart(messages: Message[], start: number): boolean {
  const available = new Set<string>();
  for (let i = start; i < messages.length; i++) {
    const message = messages[i]!;
    for (const id of toolCallIds(message)) available.add(id);
    if (message.role === "toolResult" && !available.has(message.toolCallId)) return false;
  }
  return true;
}

/**
 * Drop-oldest.
 *
 * Walks backwards from the newest message accumulating the token estimate,
 * and cuts at the oldest message that still fits. The cut index is then
 * pushed forward until it lands on a valid boundary — never on a
 * `toolResult` whose originating `toolCall` would be left behind.
 *
 * A single message larger than the whole budget is still kept when it is
 * the newest one: dropping everything would leave an empty context, which
 * is strictly worse than a slightly-over-budget one. `ConversationManager`
 * caps tool results at append time (`maxToolResultChars`), which is what
 * actually prevents that case in practice.
 */
export const dropOldestStrategy: TruncationStrategy = {
  truncate(messages: Message[], budgetTokens: number): Message[] {
    if (messages.length === 0) return messages;

    let used = 0;
    let cut = messages.length; // index of the first message we keep

    for (let i = messages.length - 1; i >= 0; i--) {
      const cost = estimateTokens(messages[i]!);
      if (used + cost > budgetTokens && cut < messages.length) break;
      used += cost;
      cut = i;
    }

    if (cut === 0) return messages;

    // Move the cut to a boundary where no `toolResult` is left without the
    // `AssistantMessage` carrying its `ToolCall` — the pair has to stay
    // atomic or every provider rejects the context.
    //
    // Searched forward first (drop the orphans, staying closest to budget).
    // If no forward boundary works — which happens when the history *ends*
    // in orphaned tool results — search backward instead, to pull the
    // originating tool call back in. Index 0 is always valid, so this
    // terminates.
    //
    // Going over budget is the deliberate lesser evil here: an invalid
    // context is rejected outright, whereas an oversized one still runs.
    for (let start = cut; start < messages.length; start++) {
      if (isValidStart(messages, start)) return messages.slice(start);
    }
    for (let start = cut - 1; start > 0; start--) {
      if (isValidStart(messages, start)) return messages.slice(start);
    }
    return messages;
  },
};
