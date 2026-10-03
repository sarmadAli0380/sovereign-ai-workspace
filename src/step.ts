/**
 * One transition of a conversation — deliberately not a loop.
 *
 * Everything the harness needed to drive a request → tool-call → response
 * cycle existed after 1.6, except the piece that puts them together. Both
 * verification scripts wrote that out by hand, hardcoded to exactly two
 * turns, so nobody could use the library without copying from a test.
 *
 * ## Why this is a step and not an agent loop
 *
 * `step()` performs **exactly one** model call. If the model asked for
 * tools it dispatches them, appends the results, and **returns** — it never
 * calls the model a second time. A caller that wants iteration writes it
 * themselves:
 *
 * ```ts
 * let turns = 0;
 * let outcome = await step(deps);
 * while (!outcome.done && turns++ < 10) outcome = await step(deps);
 * ```
 *
 * The distinction is *who decides when to stop*. An agent loop decides;
 * this does not. The stopping rule, the turn cap and the failure policy
 * stay in the application, visible, instead of becoming library defaults
 * nobody reads. That is the property 1.7 was protecting when it described
 * this harness's value as **subtraction** — a model call with nothing
 * attached.
 *
 * It also cannot reach for anything the caller did not hand it: dispatch
 * goes through the caller's own `ToolRegistry`, and the harness ships no
 * built-in tools. There is no filesystem access to wander into.
 *
 * ## The error contract, finally implemented
 *
 * `types.ts`, `harness-result.ts` and `validate-context.ts` all describe
 * one rule: a failure comes back as a `HarnessResult` carrying
 * `stopReason: "error"`, so a caller checks one place regardless of where
 * the failure happened. Nothing implemented it — `validateContext` threw
 * uncaught in both scripts, and `errorResult` had no caller outside its own
 * test. `validate-context.ts` even names "the orchestration loop" as the
 * component that would convert the throw. This is that component.
 *
 * Note the division of labour: `validateContext` still throws, because a
 * caller must not be able to proceed past it by accident. `step()` is the
 * one place that catches.
 */

import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  Models,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { cloneData } from "./clone-data.ts";
import { collectAssistantMessageIssues } from "./conformance.ts";
import type { ConfigEntry } from "./config.ts";
import { completeAssistantCall, type CompleteOptions } from "./complete.ts";
import type { ConversationManager } from "./conversation-manager.ts";
import { errorResult } from "./harness-result.ts";
import type { CapabilityPolicy, ToolPolicyContext, ToolPolicyDecision } from "./policy.ts";
import type { ToolExecutionController } from "./tool-execution.ts";
import { dispatchToolCalls, ToolRegistry } from "./tool-registry.ts";
import { HarnessError, type HarnessResult } from "./types.ts";
import { validateContext } from "./validate-context.ts";

/** Raw provider events for this single model call, delivered in stream order. */
export type StepEventSink = (event: AssistantMessageEvent) => void | Promise<void>;

export type StepLifecycleEvent =
  | { type: "message.completed"; message: AssistantMessage }
  | { type: "tool.requested"; toolCall: ToolCall }
  | { type: "tool.decision"; toolCall: ToolCall; decision: ToolPolicyDecision }
  | { type: "tool.started"; toolCall: ToolCall }
  | { type: "tool.completed"; toolCall: ToolCall; result: ToolResultMessage };

export type StepLifecycleSink = (event: StepLifecycleEvent) => void | Promise<void>;

export interface StepDeps {
  models: Models;
  model: Model<Api>;
  entry: ConfigEntry;
  configKey: string;
  conversation: ConversationManager;
  /**
   * Optional. Without one, a model that asks for a tool ends the step with
   * `done: true` and `stopReason: "toolUse"` — the caller is told what was
   * requested and decides what to do, rather than having the request
   * silently dropped.
   */
  registry?: ToolRegistry;
  /** Pure capability policy. A registry without one fails closed as denied. */
  toolPolicy?: CapabilityPolicy;
  /** Authenticated product identity supplied by the caller, never the conversation. */
  toolPolicyContext?: ToolPolicyContext;
  /** Deployment-scoped A2.2 concurrency and idempotency authority. */
  toolExecutionController?: ToolExecutionController;
  /** Trusted caller keys indexed by tool-call id; never taken from model arguments. */
  toolIdempotencyKeys?: Readonly<Record<string, string>>;
  /** Checked against `validateContext`'s unknown-configKey guard. */
  knownConfigKeys?: Iterable<string>;
  options?: CompleteOptions;
  /** Absolute deadline passed to tool handlers; provider cancellation uses `options.signal`. */
  deadline?: number;
  /**
   * Optional acknowledgement sink for pi-ai's provider stream. Events are
   * delivered in order, including the terminal `done` or `error` event. With
   * no sink, `step()` retains its existing result-only behavior.
   */
  onEvent?: StepEventSink;
  /** Validated message and tool lifecycle acknowledgement boundary for `run()`. */
  onLifecycleEvent?: StepLifecycleSink;
}

export interface StepResult {
  /** The model's response, or a synthesised `stopReason: "error"` result. */
  result: HarnessResult;
  /** Tool calls the model asked for. Empty unless `stopReason` was `toolUse`. */
  toolCalls: ToolCall[];
  /**
   * Results of dispatching those calls — already appended to the
   * conversation. Empty when there was no registry, or nothing to run.
   */
  toolResults: ToolResultMessage[];
  /** Deterministic decisions made before any handler in this batch started. */
  toolDecisions: ToolPolicyDecision[];
  /** Calls which suspended the batch for a later A3 approval/resume flow. */
  pendingToolCalls: ToolCall[];
  /**
   * True when this step ended the exchange: the model stopped, or it
   * errored, or it asked for tools and there was no registry to run them.
   *
   * False means only that a caller *could* usefully step again — never that
   * it must.
   */
  done: boolean;
}

/**
 * Runs one transition: validate, call, and dispatch any requested tools.
 *
 * Never throws. Every failure — pre-flight validation, a provider error, a
 * transport failure that outlived retries — comes back as `result` with
 * `stopReason: "error"` and `done: true`.
 */
export async function step(deps: StepDeps): Promise<StepResult> {
  const {
    models,
    model,
    entry,
    configKey,
    conversation,
    registry,
    toolPolicy,
    toolPolicyContext,
    toolExecutionController,
    toolIdempotencyKeys,
    options,
    deadline,
    onEvent,
    onLifecycleEvent,
  } = deps;

  const failed = (
    error: unknown,
    latencyMs = 0,
    fallbackKind: "invalidContext" | "providerError" = "providerError",
  ): StepResult => ({
    result: errorResult({
      error:
        error instanceof HarnessError
          ? error
          : new HarnessError(
              fallbackKind,
              error instanceof Error ? error.message : String(error),
            ),
      configKey,
      provider: entry.provider,
      modelId: entry.modelId,
      latencyMs,
    }),
    toolCalls: [],
    toolResults: [],
    toolDecisions: [],
    pendingToolCalls: [],
    done: true,
  });

  let context: Context;
  try {
    context = conversation.getContext();
    validateContext(context, configKey, deps.knownConfigKeys);
  } catch (error) {
    return failed(error, 0, "invalidContext");
  }

  // One provider stream is both the live event source and the source of the
  // final AssistantMessage. `completeAssistantCall` retains the established
  // bounded retry and active-call cancellation behavior without falling back
  // to a second, non-streaming model path.
  const started = Date.now();
  let result: HarnessResult;
  try {
    result = await completeAssistantCall(
      async (streamOptions) => {
        const stream = models.stream(model, context, streamOptions);
        if (!onEvent) return stream.result();

        // Consume through the terminal event before returning the same
        // stream's result. Awaiting the sink makes ordering and delivery
        // acknowledgement explicit instead of racing the returned result.
        for await (const event of stream) await onEvent(cloneData(event));
        return stream.result();
      },
      entry,
      configKey,
      options ?? {},
    );
  } catch (error) {
    return failed(error, Date.now() - started);
  }

  // Operational failures are run state, not conversation content. Appending
  // them made a later retry send a synthetic/provider error back to the
  // model as if it were a real assistant turn, and made the UI/persistence
  // layer treat an outage as something the assistant said.
  if (result.message.stopReason === "error" || result.message.stopReason === "aborted") {
    return { result, toolCalls: [], toolResults: [], toolDecisions: [], pendingToolCalls: [], done: true };
  }

  // Cancellation wins the race until the completed response crosses the
  // acknowledgement/history boundary. A provider may ignore an AbortSignal
  // and still resolve successfully; treating that late response as a normal
  // assistant turn would make cancellation cosmetic.
  if (options?.signal?.aborted) {
    return {
      result: {
        ...result,
        message: {
          ...result.message,
          content: [],
          stopReason: "aborted",
          errorMessage: undefined,
        },
      },
      toolCalls: [],
      toolResults: [],
      toolDecisions: [],
      pendingToolCalls: [],
      done: true,
    };
  }

  const messageIssues = collectAssistantMessageIssues(result.message);
  if (messageIssues.length > 0) {
    return failed(
      new HarnessError(
        "providerError",
        `Provider returned an invalid completed assistant message: ${messageIssues.join("; ")}`,
      ),
      result.latencyMs,
    );
  }

  try {
    await onLifecycleEvent?.({ type: "message.completed", message: cloneData(result.message) });
    conversation.append(result.message);
  } catch (error) {
    return failed(error, result.latencyMs, "invalidContext");
  }

  const toolCalls = result.message.content.filter(
    (block): block is ToolCall => block.type === "toolCall",
  );

  try {
    for (const toolCall of toolCalls) {
      await onLifecycleEvent?.({ type: "tool.requested", toolCall: cloneData(toolCall) });
    }
  } catch (error) {
    return failed(error, result.latencyMs);
  }

  if (toolCalls.length === 0) {
    return { result, toolCalls: [], toolResults: [], toolDecisions: [], pendingToolCalls: [], done: true };
  }

  // Tools were requested and there is nothing to run them with. Reported
  // rather than swallowed: `done: true` with the calls still visible, so a
  // caller can see what the model wanted and decide.
  if (!registry) {
    return {
      result,
      toolCalls,
      toolResults: [],
      toolDecisions: [],
      pendingToolCalls: toolCalls.map((call) => cloneData(call)),
      done: true,
    };
  }

  // Handler failures come back as `isError` results (1.6, decision 2), so a
  // failing or denied tool remains model-visible. Policy/lifecycle failures
  // may still reject because crossing that control boundary is orchestration
  // failure, not something a tool result may disguise.
  let toolResults: ToolResultMessage[];
  const toolDecisions: ToolPolicyDecision[] = [];
  const decisionByCallId = new Map<string, ToolPolicyDecision>();
  const normalizedCallById = new Map<string, ToolCall>();
  try {
    toolResults = await dispatchToolCalls(toolCalls, registry, {
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(deadline !== undefined ? { deadline } : {}),
      ...(toolPolicy ? { policy: toolPolicy } : {}),
      ...(toolPolicyContext ? { policyContext: toolPolicyContext } : {}),
      ...(toolExecutionController ? { executionController: toolExecutionController } : {}),
      ...(toolIdempotencyKeys ? { idempotencyKeys: toolIdempotencyKeys } : {}),
      onDecision: async (toolCall, decision) => {
        const ownedDecision = cloneData(decision);
        toolDecisions.push(ownedDecision);
        decisionByCallId.set(toolCall.id, ownedDecision);
        normalizedCallById.set(toolCall.id, cloneData(toolCall));
        await onLifecycleEvent?.({
          type: "tool.decision",
          toolCall: cloneData(toolCall),
          decision: ownedDecision,
        });
      },
      onStarted: async (toolCall) => {
        await onLifecycleEvent?.({ type: "tool.started", toolCall: cloneData(toolCall) });
      },
      onCompleted: async (toolCall, toolResult) => {
        await onLifecycleEvent?.({
          type: "tool.completed",
          toolCall: cloneData(toolCall),
          result: cloneData(toolResult),
        });
      },
    });
    const pendingToolCalls = toolCalls
      .filter((call) => decisionByCallId.get(call.id)?.decision === "requireApproval")
      .map((call) => normalizedCallById.get(call.id) ?? call);
    if (pendingToolCalls.length > 0) {
      return {
        result,
        toolCalls,
        toolResults: [],
        toolDecisions,
        pendingToolCalls: pendingToolCalls.map((call) => cloneData(call)),
        done: true,
      };
    }
    conversation.appendAll(toolResults);
  } catch (error) {
    // Policy/lifecycle acknowledgement can reject, as can the conversation's
    // pluggable truncation strategy. Keep step()'s public no-throw contract
    // true across each boundary.
    return failed(error, result.latencyMs, "invalidContext");
  }

  return {
    result,
    toolCalls,
    toolResults,
    toolDecisions,
    pendingToolCalls: [],
    done: false,
  };
}
