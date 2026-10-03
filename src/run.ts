/**
 * A bounded agent run over the public one-transition `step()` primitive.
 *
 * `run()` owns only loop concerns: identity, turn count, deadline/cancellation,
 * aggregate usage/latency, canonical event emission, and the stopping reason.
 * Provider calls and tool dispatch remain owned by `step()`.
 */

import { randomUUID } from "node:crypto";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { AssistantMessageEvent, ToolCall, Usage } from "@earendil-works/pi-ai";
import type { RunEventSink } from "./event-transport.ts";
import {
  parseRunEvent,
  RUN_EVENT_SCHEMA_VERSION,
  RUN_EVENT_SENSITIVITY,
  type RunEventOf,
  type RunEventPayloadMap,
  type RunEventType,
  type RunEvent,
  type RunUsage,
  type JsonValue,
} from "./events.ts";
import { runtimeMessageToProductEnvelope } from "./messages/codec.ts";
import { createApprovalRequest, type ApprovalRequest } from "./approval.ts";
import { step, type StepDeps, type StepLifecycleEvent } from "./step.ts";

export type RunReason =
  | "stop"
  | "maxTurns"
  | "cancelled"
  | "error"
  | "needsApproval"
  | "persistenceUnavailable";

export interface RunOptions {
  /** Stable product identity supplied by the caller. */
  conversationId: string;
  /** Command/event which caused this run. */
  causationId: string;
  correlationId?: string;
  /** Durable user message which initiated the first turn, when one exists. */
  inputMessageId?: string;
  /** Required positive bound; there is deliberately no autonomous default. */
  maxTurns: number;
  /** Required absolute Unix-epoch deadline in milliseconds. */
  deadline: number;
  signal?: AbortSignal;
  /** Required acknowledgement boundary for the canonical product events. */
  onEvent: RunEventSink;
  runId?: string;
  /** Deterministic test/replay hooks. Production defaults are UUID and Date.now. */
  idFactory?: () => string;
  now?: () => number;
  /** Required only when capability policy can suspend for human approval. */
  approvalTtlMs?: number;
}

export interface RunResult {
  runId: string;
  conversationId: string;
  reason: RunReason;
  turns: number;
  usage: RunUsage;
  /** Sum of provider-step latency across attempted turns. */
  latencyMs: number;
  /** Wall-clock duration including tools, sinks, and retry backoff. */
  elapsedMs: number;
  /** Populated only for a suspended tool request with no execution gateway. */
  pendingToolCalls: readonly ToolCall[];
  /** Persistable bindings populated for policy-driven approval suspension. */
  pendingApprovals: readonly ApprovalRequest[];
  /** Failure/cancellation code mirrored by the terminal event when publishable. */
  code?: string;
}

const ZERO_USAGE: RunUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
};

function requireNonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function addUsage(target: RunUsage, usage: Usage): void {
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.totalTokens += usage.totalTokens;
}

function toRunUsage(usage: Usage): RunUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
  };
}

function linkAbortSignal(
  source: AbortSignal | undefined,
  controller: AbortController,
): (() => void) | undefined {
  if (!source) return undefined;
  const abort = (): void => controller.abort(source.reason);
  if (source.aborted) abort();
  else source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

export async function run(deps: StepDeps, options: RunOptions): Promise<RunResult> {
  if (!Number.isFinite(options.maxTurns) || !Number.isInteger(options.maxTurns) || options.maxTurns <= 0) {
    throw new TypeError(`maxTurns must be a positive whole number, got ${options.maxTurns}`);
  }
  if (!Number.isFinite(options.deadline)) {
    throw new TypeError(`deadline must be a finite Unix-epoch millisecond value, got ${options.deadline}`);
  }
  requireNonEmpty(options.conversationId, "conversationId");
  requireNonEmpty(options.causationId, "causationId");
  if (options.correlationId !== undefined) requireNonEmpty(options.correlationId, "correlationId");
  if (options.inputMessageId !== undefined) requireNonEmpty(options.inputMessageId, "inputMessageId");

  const now = options.now ?? Date.now;
  const idFactory = options.idFactory ?? randomUUID;
  const runId = options.runId ?? idFactory();
  requireNonEmpty(runId, "runId");
  const startedAt = now();
  if (!Number.isFinite(startedAt)) throw new TypeError("now() must return a finite timestamp");

  const usage: RunUsage = { ...ZERO_USAGE };
  let turns = 0;
  let latencyMs = 0;
  let sequence = 0;
  const eventIds = new Set<string>();
  let currentMessageId = "";
  let publicationFailed = false;
  let publicationFailure: unknown;
  let deadlineExceeded = false;
  let emitTail: Promise<void> = Promise.resolve();

  const controller = new AbortController();
  const unlinkSignals = [
    linkAbortSignal(options.signal, controller),
    linkAbortSignal(deps.options?.signal, controller),
  ].filter((unlink): unlink is () => void => unlink !== undefined);

  let deadlineTimer: NodeJS.Timeout | undefined;
  const expireDeadlineIfElapsed = (): boolean => {
    if (!controller.signal.aborted && Date.now() >= options.deadline) {
      deadlineExceeded = true;
      controller.abort(new Error("run deadline exceeded"));
    }
    return deadlineExceeded;
  };
  const armDeadline = (): void => {
    const remaining = options.deadline - Date.now();
    if (remaining <= 0) {
      expireDeadlineIfElapsed();
      return;
    }
    deadlineTimer = setTimeout(armDeadline, Math.min(remaining, 2_147_483_647));
  };
  armDeadline();

  const elapsed = (): number => Math.max(0, now() - startedAt);
  const result = (
    reason: RunReason,
    pendingToolCalls: readonly ToolCall[] = [],
    code?: string,
    pendingApprovals: readonly ApprovalRequest[] = [],
  ): RunResult => ({
    runId,
    conversationId: options.conversationId,
    reason,
    turns,
    usage: { ...usage },
    latencyMs,
    elapsedMs: elapsed(),
    pendingToolCalls: pendingToolCalls.map((call) => structuredClone(call)),
    pendingApprovals: pendingApprovals.map((request) => structuredClone(request)),
    ...(code ? { code } : {}),
  });

  const emit = <TType extends RunEventType>(
    type: TType,
    payload: RunEventPayloadMap[TType],
    turn: number,
  ): Promise<void> => {
    const publication = emitTail.then(async () => {
      if (publicationFailed) throw publicationFailure;
      const eventId = idFactory();
      requireNonEmpty(eventId, "eventId");
      if (eventIds.has(eventId)) throw new TypeError(`duplicate eventId ${eventId}`);
      eventIds.add(eventId);
      const occurredAtMs = now();
      if (!Number.isFinite(occurredAtMs)) throw new TypeError("now() must return a finite timestamp");
      const event = parseRunEvent({
        schemaVersion: RUN_EVENT_SCHEMA_VERSION,
        eventId,
        runId,
        conversationId: options.conversationId,
        sequence: sequence++,
        turn,
        occurredAt: new Date(occurredAtMs).toISOString(),
        type,
        causationId: options.causationId,
        ...(options.correlationId ? { correlationId: options.correlationId } : {}),
        audience: type === "message.delta" ? "ui" : "persistence",
        sensitivity: RUN_EVENT_SENSITIVITY[type],
        payload,
      }) as RunEventOf<TType>;
      try {
        await options.onEvent(structuredClone(event) as RunEvent);
      } catch (error) {
        publicationFailed = true;
        publicationFailure = error;
        controller.abort(error);
        throw error;
      }
    });
    emitTail = publication.catch(() => undefined);
    return publication;
  };

  const finish = async (
    reason: Exclude<RunReason, "persistenceUnavailable">,
    turn: number,
    pending: readonly ToolCall[] = [],
    detail?: string,
    approvals: readonly ApprovalRequest[] = [],
  ): Promise<RunResult> => {
    try {
      if (reason === "stop" || reason === "maxTurns" || reason === "needsApproval") {
        await emit("run.completed", { reason, usage: { ...usage } }, turn);
        return result(reason, pending, undefined, approvals);
      }
      if (reason === "cancelled") {
        const code = deadlineExceeded
          ? "deadline.exceeded"
          : controller.signal.aborted
            ? "caller.cancelled"
            : "provider.aborted";
        await emit("run.cancelled", { code, ...(detail ? { detail } : {}) }, turn);
        return result(reason, [], code);
      }
      const code = "runtime.failed";
      await emit("run.failed", { code, retryable: false, ...(detail ? { detail } : {}) }, turn);
      return result(reason, [], code);
    } catch (error) {
      if (publicationFailed) {
        return result("persistenceUnavailable", [], "persistence.unavailable");
      }
      throw error;
    }
  };

  const onProviderEvent = async (event: AssistantMessageEvent): Promise<void> => {
    if (event.type === "start") currentMessageId = idFactory();
    if (event.type !== "text_delta" && event.type !== "thinking_delta") return;
    if (!currentMessageId) currentMessageId = idFactory();
    await emit(
      "message.delta",
      {
        messageId: currentMessageId,
        index: event.contentIndex,
        blockType: event.type === "text_delta" ? "text" : "thinking",
        delta: event.delta,
      },
      turns,
    );
  };

  const onLifecycleEvent = async (event: StepLifecycleEvent): Promise<void> => {
    try {
      switch (event.type) {
        case "message.completed": {
          if (!currentMessageId) currentMessageId = idFactory();
          await emit(
            "message.completed",
            {
              message: runtimeMessageToProductEnvelope(event.message, {
                messageId: currentMessageId,
                configKey: deps.configKey,
              }),
            },
            turns,
          );
          break;
        }
        case "tool.requested":
          await emit(
            "tool.requested",
            {
              toolCallId: event.toolCall.id,
              toolName: event.toolCall.name,
              arguments: event.toolCall.arguments ?? {},
            },
            turns,
          );
          break;
        case "tool.decision":
          await emit(
            "tool.decision",
            {
              toolCallId: event.toolCall.id,
              toolName: event.toolCall.name,
              capability: event.decision.capability,
              capabilities: event.decision.capabilityDecisions.map((item) => item.capability),
              decision: event.decision.decision,
              reasonCode: event.decision.reasonCode,
            },
            turns,
          );
          break;
        case "tool.started":
          await emit(
            "tool.started",
            { toolCallId: event.toolCall.id, toolName: event.toolCall.name },
            turns,
          );
          break;
        case "tool.completed":
          await emit(
            "tool.completed",
            {
              toolCallId: event.toolCall.id,
              toolName: event.toolCall.name,
              isError: event.result.isError,
              result: runtimeMessageToProductEnvelope(
                event.result,
                { messageId: idFactory() },
              ) as unknown as JsonValue,
            },
            turns,
          );
          break;
      }
    } catch (error) {
      controller.abort(error);
      throw error;
    }
  };

  try {
    try {
      await emit(
        "run.started",
        { configKey: deps.configKey, provider: deps.entry.provider, model: deps.entry.modelId },
        0,
      );
    } catch (error) {
      if (publicationFailed) {
        return result("persistenceUnavailable", [], "persistence.unavailable");
      }
      throw error;
    }

    if (controller.signal.aborted) return finish("cancelled", 0);

    for (let turn = 1; turn <= options.maxTurns; turn += 1) {
      turns = turn;
      currentMessageId = "";
      await emit(
        "turn.started",
        turn === 1 && options.inputMessageId !== undefined
          ? { inputMessageId: options.inputMessageId }
          : {},
        turn,
      );

      const outcome = await step({
        ...deps,
        options: { ...deps.options, signal: controller.signal },
        deadline: options.deadline,
        onEvent: onProviderEvent,
        onLifecycleEvent,
      });
      // A tool and the run can share the same absolute deadline. Under a
      // busy event loop the tool's timer may settle first even though the
      // run deadline has already elapsed; do not wait for the sibling timer
      // callback before deciding whether another turn is allowed.
      expireDeadlineIfElapsed();
      latencyMs += outcome.result.latencyMs;
      addUsage(usage, outcome.result.message.usage);

      if (publicationFailed) {
        return result("persistenceUnavailable", [], "persistence.unavailable");
      }

      const stopReason = outcome.result.message.stopReason;
      let pendingApprovals: ApprovalRequest[] = [];
      if (outcome.pendingToolCalls.length > 0) {
        const approvalDecisions = outcome.toolDecisions.filter(
          (decision) => decision.decision === "requireApproval",
        );
        if (approvalDecisions.length > 0) {
          if (!Number.isFinite(options.approvalTtlMs) || !Number.isInteger(options.approvalTtlMs) || Number(options.approvalTtlMs) <= 0) {
            throw new TypeError("approvalTtlMs must be a positive whole number when approval is required");
          }
          pendingApprovals = outcome.pendingToolCalls.map((toolCall, index) => {
            const decision = approvalDecisions[index];
            if (!decision) throw new Error("approval decision/call mismatch");
            return createApprovalRequest({
              runId,
              conversationId: options.conversationId,
              toolCall,
              decision,
              ttlMs: Number(options.approvalTtlMs),
              now,
              idFactory,
            });
          });
          for (const approval of pendingApprovals) {
            await emit("approval.requested", {
              approvalId: approval.approvalId,
              toolCallId: approval.toolCall.id,
              toolName: approval.toolCall.name,
              capability: approval.capability,
              argumentsHash: approval.argumentsHash,
              expiresAt: approval.expiresAt,
            }, turn);
          }
        }
      }
      await emit(
        "turn.completed",
        {
          stopReason,
          usage: toRunUsage(outcome.result.message.usage),
          budget: deps.conversation.getBudgetUsage(),
        },
        turn,
      );

      if (stopReason === "aborted") {
        return finish("cancelled", turn, [], outcome.result.message.errorMessage);
      }
      if (stopReason === "error") {
        const retryable = isRetryableAssistantError(outcome.result.message);
        const code = outcome.result.message.api === "harness-preflight"
          ? "runtime.preflight"
          : "provider.error";
        try {
          await emit(
            "run.failed",
            {
              code,
              retryable,
              ...(outcome.result.message.errorMessage
                ? { detail: outcome.result.message.errorMessage }
                : {}),
            },
            turn,
          );
          return result("error", [], code);
        } catch (error) {
          if (publicationFailed) {
            return result("persistenceUnavailable", [], "persistence.unavailable");
          }
          throw error;
        }
      }
      if (outcome.done) {
        if (stopReason === "toolUse" && outcome.pendingToolCalls.length > 0) {
          return finish("needsApproval", turn, outcome.pendingToolCalls, undefined, pendingApprovals);
        }
        return finish("stop", turn);
      }
      // A completed final response wins if cancellation arrives only after it
      // crossed the message acknowledgement/history boundary. A run that
      // still needs another turn does not continue after cancellation.
      if (controller.signal.aborted) {
        return finish("cancelled", turn);
      }
      if (turn === options.maxTurns) return finish("maxTurns", turn);
    }

    // The validated positive integer bound makes this unreachable.
    return finish("maxTurns", turns);
  } catch (error) {
    if (publicationFailed) {
      return result("persistenceUnavailable", [], "persistence.unavailable");
    }
    return finish("error", turns, [], error instanceof Error ? error.message : String(error));
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    for (const unlink of unlinkSignals) unlink();
  }
}
