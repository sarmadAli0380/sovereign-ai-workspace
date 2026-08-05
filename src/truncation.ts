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

import type { Context, Message, ToolCall } from "@earendil-works/pi-ai";

export interface TruncationStrategy {
  /**
   * Returns a trimmed message list that fits within `budgetTokens`.
   * Must never separate a ToolCall from its ToolResultMessage.
   */
  truncate(messages: Message[], budgetTokens: number): Message[];
}

/**
 * Token estimate: chars / CHARS_PER_TOKEN.
 *
 * Same shape of heuristic pi-coding-agent uses — deliberately no tokenizer
 * dependency.
 *
 * The original value of 4 came with a claim that it "overestimates, so the
 * budget is never blown by an underestimate". Measured against the real
 * tokenizer, that claim was false for exactly the content this harness
 * carries most of. Actual-vs-estimated at chars/4:
 *
 *   English prose   0.88x   (overestimates — fine)
 *   JSON / code     1.83x   (UNDERESTIMATES)
 *   Chinese (CJK)   2.63x   (UNDERESTIMATES)
 *
 * Tool results are mostly JSON and code, and 1.5's own research names them
 * the biggest source of context bloat — so the heuristic was weakest
 * precisely where it mattered most.
 *
 * TUNABLE, now with data behind it. 3 is a compromise: it makes English
 * comfortably safe and cuts the code underestimate from 1.83x to ~1.37x,
 * without the cost of a value that would satisfy every case. Genuinely
 * guaranteeing "never underestimates" needs ~1.5 chars/token, which would
 * overestimate English by 3x and waste most of the window — a real
 * tokenizer is the only way to have both. Flagged in findings-log.md as an
 * open decision rather than silently picked.
 */
const CHARS_PER_TOKEN = 3;

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

/**
 * Characters in a text block, including its signature.
 *
 * `TextContent.textSignature` and `ThinkingContent.thinkingSignature` hold
 * opaque payloads that pi-ai **sends back to the provider** — as
 * `redacted_thinking.data` and `thinking.signature` on Anthropic
 * (`anthropic-messages.js:894`, `:921`), and as a parsed reasoning item on
 * the OpenAI Responses path (`openai-responses-shared.js:139`). Counting
 * them as zero is the same defect as the image-block case above: real
 * payload measured as free.
 *
 * Measured against `openai-codex`: a single reasoning turn returned
 * `thinking: 0 chars, thinkingSignature: 1146 chars, textSignature: 92`,
 * and `estimateTokens` scored the whole message at 5 tokens. That is where
 * the ~37 tokens/turn of unexplained input growth in 1.8 came from — the
 * harness could see the payload all along and was not counting it.
 *
 * Deliberately charged at the same chars/token rate as prose even though
 * ciphertext is denser: the 1238 characters above cost roughly 37 tokens on
 * the wire, so chars/3 overestimates them by around an order of magnitude.
 * That is the direction this module's contract asks for, and the cost is
 * bounded — signatures only appear on assistant turns from hosted reasoning
 * models, which carry very large windows, and the anchored path prices
 * everything before the last turn from a measured count anyway. TUNABLE: a
 * separate, higher chars-per-token constant for signatures would be
 * sharper, but one provider's single measurement is not enough to pick it.
 */
function textChars(block: { text?: string; textSignature?: string }): number {
  return (block.text?.length ?? 0) + (block.textSignature?.length ?? 0);
}

export function estimateTokens(message: Message): number {
  let chars = 0;

  switch (message.role) {
    case "user":
      chars =
        typeof message.content === "string"
          ? message.content.length
          : message.content.reduce(
              (sum, block) => sum + (block.type === "text" ? textChars(block) : imageChars(block)),
              0,
            );
      break;

    case "assistant":
      for (const block of message.content) {
        if (block.type === "text") chars += textChars(block);
        else if (block.type === "thinking") {
          chars += block.thinking.length + (block.thinkingSignature?.length ?? 0);
        } else if (block.type === "toolCall") {
          chars += block.name.length + JSON.stringify(block.arguments ?? {}).length;
        }
      }
      break;

    case "toolResult":
      chars =
        message.toolName.length +
        message.content.reduce(
          (sum, block) => sum + (block.type === "text" ? textChars(block) : imageChars(block)),
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

/**
 * Per-tool cost beyond the tool's own text, for the JSON wrapper each
 * provider puts around a function definition.
 *
 * TUNABLE: 4 by analogy with the per-message constant, not measured
 * separately.
 */
const TOOL_FRAMING_TOKENS = 4;

/**
 * The tokens a `Context` costs *outside* its message list — the system
 * prompt and the tool schemas.
 *
 * These are sent on every single request and were counted nowhere until
 * 1.8. `estimateContextTokens` walks messages, and `systemPrompt`/`tools`
 * are sibling fields on the `Context`, so both the budget check and the
 * truncation decision were blind to them. Measured against a message list
 * whose entire content was one 23-token user string
 * (`phase1/adrs/1.8-token-budgeting.md`):
 *
 *   codex reported input   82   (~21 system prompt, ~38 one tool schema)
 *   ollama reported input  153
 *
 * Unlike message content, none of this is truncatable — a strategy cannot
 * drop a tool the caller registered. So it is a fixed floor charged against
 * the window, not something handed to a strategy that could not act on it.
 *
 * This overestimates, deliberately, in line with the rest of this module's
 * contract: the `get_weather` schema used in `verify-live` measures ~38
 * tokens on the wire and is estimated here at ~59. Schemas are JSON, which
 * is exactly the content chars/3 was measured weakest on, so erring high is
 * the right direction — an overestimate evicts a message early, an
 * underestimate blows the window.
 */
export function estimateOverheadTokens(
  context: Pick<Context, "systemPrompt" | "tools">,
): number {
  let total = 0;

  if (context.systemPrompt) {
    total += Math.ceil(context.systemPrompt.length / CHARS_PER_TOKEN) + 4;
  }

  for (const tool of context.tools ?? []) {
    const chars =
      tool.name.length + tool.description.length + JSON.stringify(tool.parameters ?? {}).length;
    total += Math.ceil(chars / CHARS_PER_TOKEN) + TOOL_FRAMING_TOKENS;
  }

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
