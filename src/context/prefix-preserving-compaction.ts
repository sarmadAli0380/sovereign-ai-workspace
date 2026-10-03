import { createHash } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import {
  estimateContextTokens,
  estimateTokens,
  type TruncationStrategy,
} from "../truncation.ts";

export const PREFIX_COMPACTION_LAYOUT_VERSION =
  "sovereign.prefix-compaction.v1" as const;
export const DEFAULT_PREFIX_COMPACTION_FRACTION = 0.25;
const MARKER_PREAMBLE = "SOVEREIGN HISTORY COMPACTION MANIFEST v1";

export interface PrefixCompactionManifest {
  layoutVersion: typeof PREFIX_COMPACTION_LAYOUT_VERSION;
  sourceStartIndex: number;
  sourceEndIndex: number;
  sourceMessageCount: number;
  sourceSha256: string;
  summaryGenerated: false;
  rebuildable: true;
}

export interface PrefixPreservingCompactionOptions {
  /** Maximum fraction of the message budget spent on the immutable old prefix. */
  prefixFraction?: number;
}

interface AtomicMessageGroup {
  start: number;
  end: number;
  messages: Message[];
  tokens: number;
}

function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("messages contain a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "undefined") return "null";
  if (typeof value !== "object") {
    throw new TypeError(`messages contain unsupported ${typeof value} data`);
  }
  if (seen.has(value)) throw new TypeError("messages contain a circular reference");
  seen.add(value);
  let serialized: string;
  if (Array.isArray(value)) {
    serialized = `[${value.map((item) => canonical(item, seen)).join(",")}]`;
  } else {
    const record = value as Record<string, unknown>;
    serialized = `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key], seen)}`)
      .join(",")}}`;
  }
  seen.delete(value);
  return serialized;
}

function hashMessages(messages: readonly Message[]): string {
  return createHash("sha256").update(canonical(messages), "utf8").digest("hex");
}

function toolCallIds(message: Message): string[] {
  if (message.role !== "assistant") return [];
  return message.content
    .filter((block) => block.type === "toolCall")
    .map((block) => block.id);
}

/**
 * Groups every span crossed by a tool call/result link into one indivisible unit.
 * A malformed orphan is deliberately left visible for ContextCompiler to reject.
 */
function atomicGroups(messages: Message[]): AtomicMessageGroup[] {
  const groups: AtomicMessageGroup[] = [];
  let start = 0;
  let outstanding = new Set<string>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    for (const id of toolCallIds(message)) outstanding.add(id);
    if (message.role === "toolResult") outstanding.delete(message.toolCallId);
    if (outstanding.size === 0) {
      const grouped = messages.slice(start, index + 1);
      groups.push({
        start,
        end: index,
        messages: grouped,
        tokens: estimateContextTokens(grouped),
      });
      start = index + 1;
    }
  }
  if (start < messages.length) {
    const grouped = messages.slice(start);
    groups.push({
      start,
      end: messages.length - 1,
      messages: grouped,
      tokens: estimateContextTokens(grouped),
    });
  }
  return groups;
}

function createManifestMessage(
  messages: readonly Message[],
  sourceStartIndex: number,
  sourceEndIndex: number,
): Message {
  const source = messages.slice(sourceStartIndex, sourceEndIndex + 1);
  const manifest: PrefixCompactionManifest = {
    layoutVersion: PREFIX_COMPACTION_LAYOUT_VERSION,
    sourceStartIndex,
    sourceEndIndex,
    sourceMessageCount: source.length,
    sourceSha256: hashMessages(source),
    summaryGenerated: false,
    rebuildable: true,
  };
  return {
    role: "user",
    content:
      `${MARKER_PREAMBLE}\n` +
      "Earlier source messages were omitted from this bounded provider projection. " +
      "This manifest is not a summary and asserts no facts from the omitted content.\n" +
      `${JSON.stringify(manifest)}`,
    timestamp: messages[sourceStartIndex]?.timestamp ?? 0,
  };
}

export function isPrefixCompactionMarker(message: Message): boolean {
  return (
    message.role === "user" &&
    typeof message.content === "string" &&
    message.content.startsWith(`${MARKER_PREAMBLE}\n`)
  );
}

export function readPrefixCompactionManifest(
  message: Message,
): PrefixCompactionManifest | undefined {
  if (!isPrefixCompactionMarker(message) || typeof message.content !== "string") return undefined;
  const line = message.content.split("\n").at(-1);
  if (!line) return undefined;
  let parsed: PrefixCompactionManifest;
  try {
    parsed = JSON.parse(line) as PrefixCompactionManifest;
  } catch {
    return undefined;
  }
  if (
    parsed.layoutVersion !== PREFIX_COMPACTION_LAYOUT_VERSION ||
    parsed.summaryGenerated !== false ||
    parsed.rebuildable !== true ||
    !Number.isInteger(parsed.sourceStartIndex) ||
    !Number.isInteger(parsed.sourceEndIndex) ||
    !Number.isInteger(parsed.sourceMessageCount) ||
    parsed.sourceStartIndex < 0 ||
    parsed.sourceEndIndex < parsed.sourceStartIndex ||
    parsed.sourceMessageCount !== parsed.sourceEndIndex - parsed.sourceStartIndex + 1 ||
    !/^[a-f0-9]{64}$/.test(parsed.sourceSha256)
  ) {
    return undefined;
  }
  return parsed;
}

/**
 * Preserve a stable old prefix and the newest suffix, replacing only the
 * bounded middle with a deterministic, rebuildable omission manifest.
 * No source content is summarized or copied into the manifest.
 */
export function createPrefixPreservingCompactionStrategy(
  options: PrefixPreservingCompactionOptions = {},
): TruncationStrategy {
  const prefixFraction = options.prefixFraction ?? DEFAULT_PREFIX_COMPACTION_FRACTION;
  if (!Number.isFinite(prefixFraction) || prefixFraction < 0 || prefixFraction >= 1) {
    throw new TypeError("prefixFraction must be a finite number from 0 (inclusive) to 1 (exclusive)");
  }

  return {
    isDerivedMessage: isPrefixCompactionMarker,
    truncate(messages: Message[], budgetTokens: number): Message[] {
      if (messages.length === 0 || estimateContextTokens(messages) <= budgetTokens) {
        return messages;
      }

      const groups = atomicGroups(messages);
      const newest = groups.at(-1)!;
      if (newest.tokens > budgetTokens) return [...newest.messages];

      let prefixEnd = -1;
      let prefixTokens = 0;
      const prefixBudget = Math.floor(budgetTokens * prefixFraction);
      // Reserve the configured share before filling the suffix. Otherwise a
      // backwards greedy walk consumes every spare token and never actually
      // preserves the prefix the strategy is named for.
      for (let index = 0; index < groups.length - 2; index += 1) {
        const candidate = groups[index]!;
        const candidatePrefixTokens = prefixTokens + candidate.tokens;
        if (candidatePrefixTokens > prefixBudget) break;
        const omittedStart = candidate.end + 1;
        const omittedEnd = newest.start - 1;
        const marker = createManifestMessage(messages, omittedStart, omittedEnd);
        if (candidatePrefixTokens + newest.tokens + estimateTokens(marker) > budgetTokens) break;
        prefixEnd = index;
        prefixTokens = candidatePrefixTokens;
      }

      let suffixStart = groups.length - 1;
      let suffixTokens = newest.tokens;
      // Leave at least one group in the omitted middle; otherwise there is no
      // compaction and the all-messages fast path above should have won.
      for (let index = groups.length - 2; index > prefixEnd + 1; index -= 1) {
        const candidate = groups[index]!;
        const omittedStart = prefixEnd >= 0 ? groups[prefixEnd]!.end + 1 : 0;
        const marker = createManifestMessage(messages, omittedStart, candidate.start - 1);
        if (
          prefixTokens + suffixTokens + candidate.tokens + estimateTokens(marker) >
          budgetTokens
        ) {
          break;
        }
        suffixStart = index;
        suffixTokens += candidate.tokens;
      }

      const omittedStart = prefixEnd >= 0 ? groups[prefixEnd]!.end + 1 : 0;
      const omittedEnd = groups[suffixStart]!.start - 1;
      if (omittedStart > omittedEnd) {
        return groups.slice(suffixStart).flatMap((group) => group.messages);
      }
      const marker = createManifestMessage(messages, omittedStart, omittedEnd);
      const projected = [
        ...groups.slice(0, prefixEnd + 1).flatMap((group) => group.messages),
        marker,
        ...groups.slice(suffixStart).flatMap((group) => group.messages),
      ];

      // Tiny budgets can fit the newest message but not even the omission
      // manifest. In that edge case, match the safe drop-oldest baseline;
      // ContextCompiler still rejects an oversized newest atomic group.
      return estimateContextTokens(projected) <= budgetTokens
        ? projected
        : groups.slice(suffixStart).flatMap((group) => group.messages);
    },
  };
}

export const prefixPreservingCompactionStrategy =
  createPrefixPreservingCompactionStrategy();
