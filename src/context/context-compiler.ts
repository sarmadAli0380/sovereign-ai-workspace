import { createHash } from "node:crypto";
import type { Context, Message, Tool, UserMessage } from "@earendil-works/pi-ai";
import { cloneData } from "../clone-data.ts";
import {
  dropOldestStrategy,
  estimateContextTokens,
  estimateOverheadTokens,
  type TruncationStrategy,
} from "../truncation.ts";
import { collectContextIssues } from "../validate-context.ts";
import {
  DEFAULT_SYSTEM_TEMPLATE_VERSION,
  delimitUntrustedToolResults,
  orderTools,
  PROMPT_LAYOUT_VERSION,
  renderSystemPrompt,
  retrievedContextMessage,
  type RetrievedContextItem,
  type VersionedSystemInstruction,
} from "./prompt-layout.ts";

/** TUNABLE: retrieved material may reserve at most 25% by default. */
export const DEFAULT_RETRIEVED_CONTEXT_FRACTION = 0.25;

const VERSION_PATTERN = /^[a-zA-Z0-9._-]+$/;

export interface ContextCompilerOptions {
  contextWindow: number;
  outputReserveTokens: number;
  systemPrompt?: string;
  systemPromptVersion?: string;
  systemInstructions?: readonly VersionedSystemInstruction[];
  systemTemplateVersion?: string;
  tools?: readonly Tool[];
  maxRetrievedContextTokens?: number;
  strategy?: TruncationStrategy;
}

export interface ContextCompilationInput {
  /** Complete available history. The compiler never mutates or truncates this input. */
  completeHistory: readonly Message[];
  /** Provider-measured input for the request that produced this assistant message. */
  historyAnchor?: ContextHistoryTokenAnchor;
  retrievedContext?: readonly RetrievedContextItem[];
  /** The current user input, kept outside history so its allocation is explicit. */
  currentInput?: UserMessage;
}

export interface ContextHistoryTokenAnchor {
  /** Includes fixed overhead and every history message before `messageIndex`. */
  tokens: number;
  messageIndex: number;
}

export type ContextBudgetSource = "anchored" | "estimated";

export interface ContextBudgetUsage {
  /** Effective input size used to enforce the provider input allocation. */
  tokens: number;
  source: ContextBudgetSource;
}

export interface ContextTokenAllocation {
  contextWindow: number;
  fixedOverheadTokens: number;
  historyBudgetTokens: number;
  /** Heuristic size of the projected history; budgetUsage carries provenance. */
  historyTokens: number;
  retrievedContextBudgetTokens: number;
  retrievedContextTokens: number;
  currentInputTokens: number;
  outputReserveTokens: number;
  /** Anchored when valid, otherwise the conservative heuristic total. */
  totalInputTokens: number;
  unusedInputTokens: number;
}

export interface PromptFingerprint {
  algorithm: "sha256";
  promptLayoutVersion: typeof PROMPT_LAYOUT_VERSION;
  systemTemplateVersion: string;
  instructionVersions: readonly string[];
  hashes: {
    system: string;
    tools: string;
    history: string;
    retrievedContext: string;
    currentInput: string;
    allocations: string;
  };
  digest: string;
}

export interface ContextProjectionSummary {
  completeHistoryMessages: number;
  projectedHistoryMessages: number;
  retainedHistoryMessages: number;
  derivedHistoryMessages: number;
  droppedHistoryMessages: number;
  retrievedItems: number;
  includedRetrievedItems: number;
  omittedRetrievedItems: number;
}

export interface CompiledProviderContext {
  context: Context;
  allocation: ContextTokenAllocation;
  budgetUsage: ContextBudgetUsage;
  fingerprint: PromptFingerprint;
  projection: ContextProjectionSummary;
}

export class ContextCompilationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ContextCompilationError";
  }
}

function assertWholeNumber(name: string, value: number, positive: boolean): void {
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    (positive ? value <= 0 : value < 0)
  ) {
    throw new ContextCompilationError(
      `${name} must be a finite ${positive ? "positive" : "non-negative"} whole number`,
    );
  }
}

function assertVersion(name: string, value: string): void {
  if (!VERSION_PATTERN.test(value)) {
    throw new ContextCompilationError(
      `${name} must contain only letters, numbers, dot, underscore, or hyphen`,
    );
  }
}

function compareStable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertToolResultLinks(messages: readonly Message[]): void {
  const available = new Set<string>();
  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") available.add(block.id);
      }
    } else if (message.role === "toolResult") {
      if (!available.has(message.toolCallId)) {
        throw new ContextCompilationError(
          `messages[${index}] is an orphaned tool result for ${JSON.stringify(message.toolCallId)}`,
        );
      }
      available.delete(message.toolCallId);
    }
  }
}

function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ContextCompilationError("prompt data contains a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "undefined") return "null";
  if (typeof value !== "object") {
    throw new ContextCompilationError(`prompt data contains unsupported ${typeof value} value`);
  }
  if (seen.has(value)) throw new ContextCompilationError("prompt data contains a circular reference");
  seen.add(value);
  let serialized: string;
  if (Array.isArray(value)) {
    serialized = `[${value.map((item) => canonical(item, seen)).join(",")}]`;
  } else {
    serialized = `{${Object.keys(value as object)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], seen)}`,
      )
      .join(",")}}`;
  }
  seen.delete(value);
  return serialized;
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function fingerprint(
  systemTemplateVersion: string,
  instructionVersions: readonly string[],
  systemPrompt: string | undefined,
  tools: readonly Tool[],
  history: readonly Message[],
  retrieved: readonly Message[],
  currentInput: UserMessage | undefined,
  allocation: ContextTokenAllocation,
): PromptFingerprint {
  const hashes = {
    system: hash(systemPrompt ?? null),
    tools: hash(tools),
    history: hash(history),
    retrievedContext: hash(retrieved),
    currentInput: hash(currentInput ?? null),
    allocations: hash(allocation),
  };
  const withoutDigest = {
    algorithm: "sha256" as const,
    promptLayoutVersion: PROMPT_LAYOUT_VERSION,
    systemTemplateVersion,
    instructionVersions: [...instructionVersions],
    hashes,
  };
  return { ...withoutDigest, digest: hash(withoutDigest) };
}

export class ContextCompiler {
  readonly #contextWindow: number;
  readonly #outputReserveTokens: number;
  readonly #systemTemplateVersion: string;
  readonly #instructions: readonly VersionedSystemInstruction[];
  readonly #systemPrompt?: string;
  readonly #tools: readonly Tool[];
  readonly #maxRetrievedContextTokens?: number;
  readonly #strategy: TruncationStrategy;

  constructor(options: ContextCompilerOptions) {
    assertWholeNumber("contextWindow", options.contextWindow, true);
    assertWholeNumber("outputReserveTokens", options.outputReserveTokens, false);
    if (options.outputReserveTokens >= options.contextWindow) {
      throw new ContextCompilationError("outputReserveTokens must be smaller than contextWindow");
    }
    if (options.maxRetrievedContextTokens !== undefined) {
      assertWholeNumber("maxRetrievedContextTokens", options.maxRetrievedContextTokens, false);
    }
    this.#contextWindow = options.contextWindow;
    this.#outputReserveTokens = options.outputReserveTokens;
    this.#systemTemplateVersion =
      options.systemTemplateVersion ?? DEFAULT_SYSTEM_TEMPLATE_VERSION;
    assertVersion("systemTemplateVersion", this.#systemTemplateVersion);

    const instructions: VersionedSystemInstruction[] = [
      ...(options.systemPrompt !== undefined
        ? [
            {
              id: "base",
              version: options.systemPromptVersion ?? this.#systemTemplateVersion,
              text: options.systemPrompt,
            },
          ]
        : []),
      ...(options.systemInstructions ?? []),
    ];
    for (const [index, instruction] of instructions.entries()) {
      assertVersion(`systemInstructions[${index}].version`, instruction.version);
    }
    this.#instructions = instructions
      .map((instruction) => ({ ...instruction }))
      .sort((left, right) =>
        compareStable(left.id, right.id) || compareStable(left.version, right.version),
      );
    this.#systemPrompt = renderSystemPrompt(this.#instructions);
    this.#tools = orderTools(options.tools ?? []);
    this.#maxRetrievedContextTokens = options.maxRetrievedContextTokens;
    this.#strategy = options.strategy ?? dropOldestStrategy;
  }

  compile(input: ContextCompilationInput): CompiledProviderContext {
    if (input.currentInput?.role !== undefined && input.currentInput.role !== "user") {
      throw new ContextCompilationError("currentInput must be a user message");
    }
    const history = delimitUntrustedToolResults(input.completeHistory);
    const anchor = input.historyAnchor;
    if (anchor !== undefined) {
      assertWholeNumber("historyAnchor.tokens", anchor.tokens, true);
      assertWholeNumber("historyAnchor.messageIndex", anchor.messageIndex, false);
      if (anchor.messageIndex >= history.length) {
        throw new ContextCompilationError("historyAnchor.messageIndex must identify a history message");
      }
      if (history[anchor.messageIndex]?.role !== "assistant") {
        throw new ContextCompilationError("historyAnchor.messageIndex must identify an assistant message");
      }
    }
    const currentInput = input.currentInput ? cloneData(input.currentInput) : undefined;
    const fixedOverheadTokens = estimateOverheadTokens({
      ...(this.#systemPrompt !== undefined ? { systemPrompt: this.#systemPrompt } : {}),
      ...(this.#tools.length > 0 ? { tools: this.#tools as Tool[] } : {}),
    });
    const currentInputTokens = currentInput ? estimateContextTokens([currentInput]) : 0;
    const inputLimit = this.#contextWindow - this.#outputReserveTokens;
    const availableAfterFixedAndCurrent =
      inputLimit - fixedOverheadTokens - currentInputTokens;
    if (availableAfterFixedAndCurrent < 0) {
      throw new ContextCompilationError(
        "fixed prompt/tool overhead plus current input exceeds the input allocation",
      );
    }

    const requestedRetrievedBudget =
      this.#maxRetrievedContextTokens ??
      Math.floor(availableAfterFixedAndCurrent * DEFAULT_RETRIEVED_CONTEXT_FRACTION);
    const retrievedContextBudgetTokens = Math.min(
      requestedRetrievedBudget,
      availableAfterFixedAndCurrent,
    );
    const retrievedItems = input.retrievedContext ?? [];
    const retrievedMessages: UserMessage[] = [];
    let retrievedContextTokens = 0;
    for (const item of retrievedItems) {
      const message = retrievedContextMessage(item, 0);
      const tokens = estimateContextTokens([message]);
      if (retrievedContextTokens + tokens > retrievedContextBudgetTokens) break;
      retrievedMessages.push(message);
      retrievedContextTokens += tokens;
    }

    const estimatedHistoryBudgetTokens = availableAfterFixedAndCurrent - retrievedContextTokens;
    let historyBudgetTokens = estimatedHistoryBudgetTokens;
    let projectedHistory: Message[];
    let budgetSource: ContextBudgetSource = "estimated";

    if (anchor === undefined) {
      projectedHistory = this.#strategy.truncate(cloneData(history), historyBudgetTokens);
    } else {
      const estimatedAnchoredPrefix = estimateContextTokens(
        history.slice(0, anchor.messageIndex),
      );
      historyBudgetTokens = Math.max(
        0,
        inputLimit - currentInputTokens - retrievedContextTokens - anchor.tokens +
          estimatedAnchoredPrefix,
      );
      const anchoredProjection = this.#strategy.truncate(
        cloneData(history),
        historyBudgetTokens,
      );
      const anchoredDerived = anchoredProjection.filter((message) =>
        this.#strategy.isDerivedMessage?.(message),
      ).length;

      if (anchoredProjection.length === history.length && anchoredDerived === 0) {
        projectedHistory = anchoredProjection;
        budgetSource = "anchored";
      } else {
        // A projection that cuts into or derives from the measured prefix no
        // longer matches the anchor. Keep its conservative cut, then enforce
        // the ordinary estimated budget again.
        projectedHistory = this.#strategy.truncate(
          anchoredProjection,
          estimatedHistoryBudgetTokens,
        );
        historyBudgetTokens = estimatedHistoryBudgetTokens;
      }
    }
    const derivedHistoryMessages = projectedHistory.filter((message) =>
      this.#strategy.isDerivedMessage?.(message),
    ).length;
    const retainedHistoryMessages = projectedHistory.length - derivedHistoryMessages;
    assertToolResultLinks(projectedHistory);
    const historyTokens = estimateContextTokens(projectedHistory);
    const budgetUsage: ContextBudgetUsage = budgetSource === "anchored"
      ? {
          tokens:
            anchor!.tokens +
            estimateContextTokens(projectedHistory.slice(anchor!.messageIndex)) +
            retrievedContextTokens +
            currentInputTokens,
          source: "anchored",
        }
      : {
          tokens:
            fixedOverheadTokens + historyTokens + retrievedContextTokens + currentInputTokens,
          source: "estimated",
        };
    if (budgetSource === "estimated" && historyTokens > historyBudgetTokens) {
      throw new ContextCompilationError(
        `history projection requires ${historyTokens} tokens but only ${historyBudgetTokens} are available; ` +
          "the newest message or an atomic tool-call/result group cannot fit",
      );
    }

    const messages = [
      ...projectedHistory,
      ...retrievedMessages,
      ...(currentInput ? [currentInput] : []),
    ];
    const context: Context = {
      ...(this.#systemPrompt !== undefined ? { systemPrompt: this.#systemPrompt } : {}),
      messages: cloneData(messages),
      ...(this.#tools.length > 0 ? { tools: cloneData([...this.#tools]) } : {}),
    };
    const issues = collectContextIssues(context);
    if (issues.length > 0) {
      throw new ContextCompilationError(
        `compiled provider context is invalid:\n${issues
          .map((issue) => `- ${issue.path}: ${issue.message}`)
          .join("\n")}`,
      );
    }

    const totalInputTokens = budgetUsage.tokens;
    if (totalInputTokens > inputLimit) {
      throw new ContextCompilationError(
        `compiled input requires ${totalInputTokens} tokens but its allocation is ${inputLimit}`,
      );
    }
    const allocation: ContextTokenAllocation = {
      contextWindow: this.#contextWindow,
      fixedOverheadTokens,
      historyBudgetTokens,
      historyTokens,
      retrievedContextBudgetTokens,
      retrievedContextTokens,
      currentInputTokens,
      outputReserveTokens: this.#outputReserveTokens,
      totalInputTokens,
      unusedInputTokens: inputLimit - totalInputTokens,
    };
    return {
      context,
      allocation,
      budgetUsage,
      fingerprint: fingerprint(
        this.#systemTemplateVersion,
        this.#instructions.map((instruction) => instruction.version),
        this.#systemPrompt,
        this.#tools,
        projectedHistory,
        retrievedMessages,
        currentInput,
        allocation,
      ),
      projection: {
        completeHistoryMessages: input.completeHistory.length,
        projectedHistoryMessages: projectedHistory.length,
        retainedHistoryMessages,
        derivedHistoryMessages,
        droppedHistoryMessages: input.completeHistory.length - retainedHistoryMessages,
        retrievedItems: retrievedItems.length,
        includedRetrievedItems: retrievedMessages.length,
        omittedRetrievedItems: retrievedItems.length - retrievedMessages.length,
      },
    };
  }
}
