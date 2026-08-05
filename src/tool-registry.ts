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

export interface ToolHandler {
  definition: Tool;
  execute(args: Record<string, unknown>): Promise<{
    content: ToolResultMessage["content"];
    isError?: boolean;
  }>;
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
    this.handlers.set(name, handler);
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

/**
 * Runs one tool call. Never rejects — every failure path returns an
 * `isError` result instead (decision 2).
 */
export async function dispatchToolCall(
  toolCall: ToolCall,
  registry: ToolRegistry,
): Promise<ToolResultMessage> {
  const handler = registry.get(toolCall.name);
  if (!handler) {
    return errorResult(toolCall, `Unknown tool: ${toolCall.name}`);
  }

  // 1.6 assumed pi-ai validated tool arguments itself ("validateToolCall is
  // built in"). It doesn't — `validateToolCall`/`validateToolArguments` are
  // exported utilities that nothing inside pi-ai ever calls, so without this
  // the model's raw arguments reach the handler unchecked. A missing
  // required field then surfaces as whatever the handler happens to throw
  // ("Cannot read properties of undefined"), or worse, doesn't throw at all
  // and the handler proceeds on garbage.
  //
  // Validating here gives the model the actionable error the ADR expected,
  // in the same `isError` shape as every other failure.
  // `arguments` is normalised to `{}` before validation. Wiring validation in
  // originally dropped the old `?? {}` fallback, which broke zero-argument
  // tools: `validateToolArguments` rejects an absent `arguments` with
  // "must be object". pi-ai itself always emits `{}` so a real provider never
  // hits this, but a hand-built or replayed ToolCall does.
  const normalized: ToolCall = { ...toolCall, arguments: toolCall.arguments ?? {} };

  let args: Record<string, unknown>;
  try {
    args = validateToolArguments(handler.definition, normalized) as Record<string, unknown>;
  } catch (error) {
    return errorResult(toolCall, error instanceof Error ? error.message : String(error));
  }

  try {
    const result = await handler.execute(args);

    // The handler's return value is checked, not trusted. The type says
    // `{ content: [...] }`, but a handler reached through `any`, a
    // `JSON.parse`, or a plugin boundary can return anything — and copying
    // `result.content` unchecked produced a result with `content: undefined`
    // and `isError: false`. That reads as *success* to every caller, then
    // crashes a step later inside whoever touches `content`, far from the
    // tool that caused it. This function's documented contract is that every
    // failure path comes back as an `isError` result, so a malformed return
    // is a failure of this tool, reported here.
    if (!result || !Array.isArray(result.content)) {
      return errorResult(
        toolCall,
        `Tool "${toolCall.name}" returned a malformed result: expected { content: [...] }, got ` +
          `${result === undefined || result === null ? String(result) : JSON.stringify(result)}.`,
      );
    }

    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: result.content,
      isError: result.isError ?? false,
      timestamp: Date.now(),
    };
  } catch (error) {
    return errorResult(toolCall, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Runs every tool call in a turn in parallel.
 *
 * `dispatchToolCall` already catches everything internally, so in practice
 * `allSettled` can't see a rejection here. It's kept anyway as defense in
 * depth against a bug in `dispatchToolCall` itself, rather than relying on
 * that inner try/catch never being wrong.
 */
export async function dispatchToolCalls(
  toolCalls: ToolCall[],
  registry: ToolRegistry,
): Promise<ToolResultMessage[]> {
  const settled = await Promise.allSettled(
    toolCalls.map((call) => dispatchToolCall(call, registry)),
  );

  return settled.map((outcome, i) =>
    outcome.status === "fulfilled"
      ? outcome.value
      : errorResult(toolCalls[i]!, "Unexpected dispatch failure"),
  );
}
