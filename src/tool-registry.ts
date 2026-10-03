/**
 * 1.6 — Provider-agnostic tool calling.
 *
 * Per `phase1/adrs/1.6-tool-calling-design.md`, the four decisions locked
 * in with the user:
 *
 *  1. Tool name → handler mapping lives in its own `ToolRegistry`, not
 *     folded into `ConversationManager` (message state only) or pi-ai's
 *     `Tool` (schema only — pi-ai has no opinion on how a tool runs).
 *  2. `dispatchToolCall` auto-wraps thrown handler errors into an `isError`
 *     result — the same failure shape pi-ai's own argument-validation
 *     errors use, so callers have one failure mode, not two.
 *  3. Multiple calls in one turn run in parallel via `Promise.allSettled`,
 *     specifically not `Promise.all` — one failure must not lose the
 *     results that succeeded alongside it.
 *  4. Dispatch is decoupled from `ConversationManager`: it returns
 *     `ToolResultMessage[]` and does not append them. The orchestration
 *     loop wires the two together, which is also what applies 1.5's
 *     `maxToolResultChars` cap.
 *
 * Not written here, because pi-ai already provides it: `translateTools`
 * (each provider translates tool schemas internally) and an argument
 * validator (`validateToolCall`).
 */

import { validateToolArguments } from "@earendil-works/pi-ai";
import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { cloneJsonValue, collectJsonValueIssues, type JsonObject } from "./json.ts";
import {
  CapabilityPolicy,
  unconfiguredToolPolicyDecision,
  type ToolPolicyContext,
  type ToolPolicyDecision,
} from "./policy.ts";
import {
  defaultToolExecutionController,
  ToolExecutionController,
} from "./tool-execution.ts";

export interface ToolControlDeclaration {
  /** Product capabilities required together for this tool invocation. */
  capabilities: readonly string[];
  risk: "low" | "medium" | "high" | "critical";
  /** Declared here and enforced by the A2.2 execution-control slice. */
  timeoutMs: number;
  /** Declared here and enforced before model-context append in A2.2. */
  maxOutputChars: number;
  /** Relative capacity units consumed by one invocation. */
  concurrencyCost: number;
  sideEffect: "none" | "reversible" | "irreversible";
  idempotency: "none" | "natural" | "callerKey";
}

export interface ToolHandler {
  definition: Tool;
  controls: ToolControlDeclaration;
  execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<{
    content: ToolResultMessage["content"];
    isError?: boolean;
  }>;
}

export interface ToolExecutionContext {
  /** Shared run cancellation, including the run deadline. */
  signal?: AbortSignal;
  /** Absolute Unix-epoch deadline in milliseconds. */
  deadline?: number;
  /** Stable caller-supplied key when the declaration requires one. */
  idempotencyKey?: string;
}

export interface ToolDispatchOptions extends ToolExecutionContext {
  policy?: CapabilityPolicy;
  policyContext?: ToolPolicyContext;
  /** Deployment-scoped capacity/idempotency authority. */
  executionController?: ToolExecutionController;
  /** Keys are indexed by tool-call id and never derived from model text. */
  idempotencyKeys?: Readonly<Record<string, string>>;
  /** Awaited after normalization and before any handler in the batch starts. */
  onDecision?: (toolCall: ToolCall, decision: ToolPolicyDecision) => void | Promise<void>;
  /** Awaited before the handler starts. Rejection prevents execution. */
  onStarted?: (toolCall: ToolCall) => void | Promise<void>;
  /** Awaited after the result is known. Rejection is an orchestration failure. */
  onCompleted?: (toolCall: ToolCall, result: ToolResultMessage) => void | Promise<void>;
}

export class ToolRegistry {
  private handlers = new Map<string, ToolHandler>();

  /**
   * Registers a tool. A duplicate name is an error, not a replacement.
   *
   * `validate-context.ts` carries a duplicate-name check whose comment says
   * a duplicate "silently overwrites" here — but because this was a bare
   * `Map.set`, `getToolDefinitions()` came out deduplicated and that check
   * could never fire on the intended path. It only ever guarded a hand-built
   * `tools` array, while the overwrite it was written to catch went
   * uncaught at its source. This is that source.
   *
   * Rejecting rather than replacing is deliberate: two tools claiming one
   * name is an ambiguity the caller has to resolve, and silently keeping the
   * last one means dispatch routes somewhere the caller did not choose.
   */
  register(handler: ToolHandler): void {
    const name = handler.definition.name;
    if (this.handlers.has(name)) {
      throw new Error(
        `A tool named "${name}" is already registered. ` +
          `Two tools cannot share a name — dispatch is keyed by it.`,
      );
    }
    this.handlers.set(name, {
      ...handler,
      definition: Object.freeze({ ...handler.definition }),
      controls: normalizeControls(handler.controls, name),
    });
  }

  /**
   * The `Tool[]` for `Context.tools` — definitions only. Handlers never
   * leak into what gets sent to the model.
   */
  getToolDefinitions(): Tool[] {
    return [...this.handlers.values()].map((h) => h.definition);
  }

  get(name: string): ToolHandler | undefined {
    return this.handlers.get(name);
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  get size(): number {
    return this.handlers.size;
  }
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${field} must be a positive whole number`);
  }
  return Number(value);
}

function normalizeControls(value: ToolControlDeclaration, toolName: string): ToolControlDeclaration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Tool "${toolName}" must declare controls`);
  }
  const allowedKeys = new Set([
    "capabilities",
    "risk",
    "timeoutMs",
    "maxOutputChars",
    "concurrencyCost",
    "sideEffect",
    "idempotency",
  ]);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`Tool "${toolName}" controls have unknown fields: ${unknown.join(", ")}`);
  }
  if (!Array.isArray(value.capabilities) || value.capabilities.length === 0) {
    throw new TypeError(`Tool "${toolName}" must declare at least one capability`);
  }
  const capabilities = [...value.capabilities].sort();
  if (
    capabilities.some((capability) => typeof capability !== "string" || !/^[a-z][a-z0-9.-]*$/.test(capability))
  ) {
    throw new TypeError(`Tool "${toolName}" capabilities must be stable lowercase identifiers`);
  }
  if (new Set(capabilities).size !== capabilities.length) {
    throw new TypeError(`Tool "${toolName}" capabilities must not contain duplicates`);
  }
  if (!new Set(["low", "medium", "high", "critical"]).has(value.risk)) {
    throw new TypeError(`Tool "${toolName}" risk must be low, medium, high, or critical`);
  }
  if (!new Set(["none", "reversible", "irreversible"]).has(value.sideEffect)) {
    throw new TypeError(`Tool "${toolName}" sideEffect must be none, reversible, or irreversible`);
  }
  if (!new Set(["none", "natural", "callerKey"]).has(value.idempotency)) {
    throw new TypeError(`Tool "${toolName}" idempotency must be none, natural, or callerKey`);
  }
  return Object.freeze({
    capabilities: Object.freeze(capabilities),
    risk: value.risk,
    timeoutMs: positiveInteger(value.timeoutMs, `Tool "${toolName}" timeoutMs`),
    maxOutputChars: positiveInteger(value.maxOutputChars, `Tool "${toolName}" maxOutputChars`),
    concurrencyCost: positiveInteger(value.concurrencyCost, `Tool "${toolName}" concurrencyCost`),
    sideEffect: value.sideEffect,
    idempotency: value.idempotency,
  });
}

function errorResult(toolCall: ToolCall, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text }],
    isError: true,
    timestamp: Date.now(),
  };
}

type PreparedToolCall =
  | { kind: "rejected"; toolCall: ToolCall; result: ToolResultMessage }
  | {
      kind: "decided";
      toolCall: ToolCall;
      handler: ToolHandler;
      args: JsonObject;
      decision: ToolPolicyDecision;
    };

function prepareToolCall(
  toolCall: ToolCall,
  registry: ToolRegistry,
  options: ToolDispatchOptions,
): PreparedToolCall {
  const handler = registry.get(toolCall.name);
  if (!handler) {
    return { kind: "rejected", toolCall, result: errorResult(toolCall, `Unknown tool: ${toolCall.name}`) };
  }

  const normalized: ToolCall = { ...toolCall, arguments: toolCall.arguments ?? {} };
  let args: Record<string, unknown>;
  try {
    args = validateToolArguments(handler.definition, normalized) as Record<string, unknown>;
  } catch (error) {
    return {
      kind: "rejected",
      toolCall,
      result: errorResult(toolCall, error instanceof Error ? error.message : String(error)),
    };
  }
  const issues: string[] = [];
  collectJsonValueIssues(args, "tool arguments", issues);
  if (issues.length > 0 || Array.isArray(args) || args === null) {
    return {
      kind: "rejected",
      toolCall,
      result: errorResult(toolCall, issues[0] ?? "Tool arguments must be a JSON object"),
    };
  }
  const ownedArgs = cloneJsonValue(args as JsonObject);
  const decision =
    options.policy && options.policyContext
      ? options.policy.evaluate({
          ...options.policyContext,
          toolName: handler.definition.name,
          capabilities: handler.controls.capabilities,
          risk: handler.controls.risk,
          sideEffect: handler.controls.sideEffect,
          normalizedArguments: ownedArgs,
        })
      : unconfiguredToolPolicyDecision(handler.controls.capabilities);
  return {
    kind: "decided",
    toolCall: { ...toolCall, arguments: ownedArgs },
    handler,
    args: ownedArgs,
    decision,
  };
}

function policyResult(prepared: Extract<PreparedToolCall, { kind: "decided" }>): ToolResultMessage {
  const verb = prepared.decision.decision === "deny" ? "denied" : "requires approval";
  return errorResult(
    prepared.toolCall,
    `Tool "${prepared.toolCall.name}" ${verb} by policy (${prepared.decision.reasonCode})`,
  );
}

function batchSuspendedResult(
  prepared: Extract<PreparedToolCall, { kind: "decided" }>,
): ToolResultMessage {
  if (prepared.decision.decision !== "allow") return policyResult(prepared);
  return errorResult(
    prepared.toolCall,
    `Tool "${prepared.toolCall.name}" was not started because another call in the batch requires approval (policy.batch-suspended)`,
  );
}

async function executePrepared(
  prepared: PreparedToolCall,
  options: ToolDispatchOptions,
): Promise<ToolResultMessage> {
  const complete = async (result: ToolResultMessage): Promise<ToolResultMessage> => {
    await options.onCompleted?.(prepared.toolCall, result);
    return result;
  };
  if (prepared.kind === "rejected") return complete(prepared.result);
  if (prepared.decision.decision !== "allow") return complete(policyResult(prepared));
  const controls = prepared.handler.controls;
  const idempotencyKey = options.idempotencyKeys?.[prepared.toolCall.id] ?? options.idempotencyKey;
  if (controls.sideEffect !== "none" && controls.idempotency === "callerKey") {
    if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
      return complete(errorResult(prepared.toolCall, "execution.idempotency-key-required"));
    }
  }

  const controller = options.executionController ?? defaultToolExecutionController;
  const perform = async (): Promise<ToolResultMessage> => {
    const lease = controller.tryAcquire(controls.capabilities, controls.concurrencyCost);
    if (!lease) return errorResult(prepared.toolCall, "execution.concurrency-limit");
    if (options.signal?.aborted) {
      lease.release();
      return errorResult(prepared.toolCall, "execution.cancelled-before-start");
    }

    const now = Date.now();
    const toolDeadline = now + controls.timeoutMs;
    const effectiveDeadline = options.deadline === undefined
      ? toolDeadline
      : Math.min(toolDeadline, options.deadline);
    if (!Number.isFinite(effectiveDeadline) || effectiveDeadline <= now) {
      lease.release();
      return errorResult(prepared.toolCall, "execution.deadline-exceeded");
    }

    try {
      await options.onStarted?.(prepared.toolCall);
    } catch (error) {
      lease.release();
      throw error;
    }
    const callController = new AbortController();
    const cancel = (): void => callController.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(
      () => callController.abort(new Error("execution.timeout")),
      Math.min(effectiveDeadline - now, 2_147_483_647),
    );

    let execution: Promise<Awaited<ReturnType<ToolHandler["execute"]>>>;
    try {
      execution = Promise.resolve(prepared.handler.execute(prepared.args, {
        signal: callController.signal,
        deadline: effectiveDeadline,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }));
    } catch (error) {
      execution = Promise.reject(error);
    }
    // A timeout bounds the runtime response, but an uncooperative handler may
    // still be doing external work. Hold capacity until that promise settles.
    execution.then(lease.release, lease.release);

    try {
      const result = await Promise.race([
        execution,
        new Promise<never>((_resolve, reject) => {
          const aborted = (): void => reject(
            callController.signal.reason instanceof Error
              ? callController.signal.reason
              : new Error("execution.cancelled"),
          );
          if (callController.signal.aborted) aborted();
          else callController.signal.addEventListener("abort", aborted, { once: true });
        }),
      ]);
      if (!result || !Array.isArray(result.content)) {
        return errorResult(
          prepared.toolCall,
          `Tool "${prepared.toolCall.name}" returned a malformed result: expected { content: [...] }, got ` +
            `${result === undefined || result === null ? String(result) : JSON.stringify(result)}.`,
        );
      }
      const outputChars = JSON.stringify(result.content).length;
      if (outputChars > controls.maxOutputChars) {
        return errorResult(prepared.toolCall, "execution.output-limit-exceeded");
      }
      return {
        role: "toolResult",
        toolCallId: prepared.toolCall.id,
        toolName: prepared.toolCall.name,
        content: result.content,
        isError: result.isError ?? false,
        timestamp: Date.now(),
      };
    } catch (error) {
      return errorResult(
        prepared.toolCall,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
    }
  };

  let toolResult: ToolResultMessage;
  if (controls.sideEffect !== "none" && controls.idempotency === "callerKey" && idempotencyKey) {
    const scope = [
      options.policyContext?.deploymentId ?? "unknown-deployment",
      options.policyContext?.workspaceId ?? "unknown-workspace",
      prepared.toolCall.name,
      idempotencyKey,
    ].join("\u0000");
    toolResult = await controller.idempotentResult(scope, perform).promise;
    toolResult = { ...toolResult, toolCallId: prepared.toolCall.id, toolName: prepared.toolCall.name };
  } else {
    toolResult = await perform();
  }
  return complete(toolResult);
}

/**
 * Runs one tool call. Tool/validation failures return an `isError` result
 * (decision 2). An optional lifecycle acknowledgement may reject because
 * losing the runtime journal is an orchestration failure, not a tool result.
 */
export async function dispatchToolCall(
  toolCall: ToolCall,
  registry: ToolRegistry,
  options: ToolDispatchOptions = {},
): Promise<ToolResultMessage> {
  const prepared = prepareToolCall(toolCall, registry, options);
  if (prepared.kind === "decided") {
    await options.onDecision?.(toolCall, prepared.decision);
    if (prepared.decision.decision === "requireApproval") return policyResult(prepared);
  }
  return executePrepared(prepared, options);
}

/**
 * Runs every tool call in a turn in parallel.
 *
 * Without lifecycle callbacks, `dispatchToolCall` catches tool failures and
 * `allSettled` remains defense in depth. With callbacks, their rejection is
 * propagated after all in-flight calls settle so journal failure cannot be
 * disguised as a model-visible tool error.
 */
export async function dispatchToolCalls(
  toolCalls: ToolCall[],
  registry: ToolRegistry,
  options: ToolDispatchOptions = {},
): Promise<ToolResultMessage[]> {
  const prepared = toolCalls.map((call) => prepareToolCall(call, registry, options));
  for (const item of prepared) {
    if (item.kind === "decided") await options.onDecision?.(item.toolCall, item.decision);
  }

  // Approval is a batch suspension boundary. No sibling handler may start
  // before every call is decided, and none starts when any call needs a human.
  if (prepared.some((item) => item.kind === "decided" && item.decision.decision === "requireApproval")) {
    return prepared.map((item) =>
      item.kind === "decided"
        ? batchSuspendedResult(item)
        : item.result,
    );
  }

  const settled = await Promise.allSettled(
    prepared.map((item) => executePrepared(item, options)),
  );

  // Lifecycle callbacks are acknowledgement boundaries owned by the
  // orchestrator. Unlike a tool failure, losing one must fail the step rather
  // than be disguised as an ordinary tool result.
  if (options.onDecision || options.onStarted || options.onCompleted) {
    const rejected = settled.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    if (rejected) throw rejected.reason;
  }

  return settled.map((outcome, i) =>
    outcome.status === "fulfilled"
      ? outcome.value
      : errorResult(toolCalls[i]!, "Unexpected dispatch failure"),
  );
}
