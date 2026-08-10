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

import type { Api, Context, Model, Models, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ConfigEntry } from "./config.ts";
import { complete, type CompleteOptions } from "./complete.ts";
import type { ConversationManager } from "./conversation-manager.ts";
import { errorResult } from "./harness-result.ts";
import { dispatchToolCalls, ToolRegistry } from "./tool-registry.ts";
import { HarnessError, type HarnessResult } from "./types.ts";
import { validateContext } from "./validate-context.ts";

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
  /** Checked against `validateContext`'s unknown-configKey guard. */
  knownConfigKeys?: Iterable<string>;
  options?: CompleteOptions;
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
  const { models, model, entry, configKey, conversation, registry, options } = deps;

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
    done: true,
  });

  let context: Context;
  try {
    context = conversation.getContext();
    validateContext(context, configKey, deps.knownConfigKeys);
  } catch (error) {
    return failed(error, 0, "invalidContext");
  }

  // `complete()` already retries transient failures and surfaces provider
  // errors as an `AssistantMessage` with `stopReason: "error"`. The catch
  // here is for what it cannot absorb — an exhausted retry budget, an
  // abort, a malformed response — so that no path out of `step()` throws.
  const started = Date.now();
  let result: HarnessResult;
  try {
    result = await complete(models, model, entry, context, configKey, options ?? {});
  } catch (error) {
    return failed(error, Date.now() - started);
  }

  // Operational failures are run state, not conversation content. Appending
  // them made a later retry send a synthetic/provider error back to the
  // model as if it were a real assistant turn, and made the UI/persistence
  // layer treat an outage as something the assistant said.
  if (result.message.stopReason === "error" || result.message.stopReason === "aborted") {
    return { result, toolCalls: [], toolResults: [], done: true };
  }

  try {
    conversation.append(result.message);
  } catch (error) {
    return failed(error, result.latencyMs, "invalidContext");
  }

  const toolCalls = result.message.content.filter(
    (block): block is ToolCall => block.type === "toolCall",
  );

  if (toolCalls.length === 0) {
    return { result, toolCalls: [], toolResults: [], done: true };
  }

  // Tools were requested and there is nothing to run them with. Reported
  // rather than swallowed: `done: true` with the calls still visible, so a
  // caller can see what the model wanted and decide.
  if (!registry) {
    return { result, toolCalls, toolResults: [], done: true };
  }

  // `dispatchToolCalls` never rejects — every handler failure comes back as
  // an `isError` result (1.6, decision 2), so a failing tool continues the
  // exchange rather than ending it. The model gets to see the error and
  // react, which is the whole point of that decision.
  let toolResults: ToolResultMessage[];
  try {
    toolResults = await dispatchToolCalls(toolCalls, registry);
    conversation.appendAll(toolResults);
  } catch (error) {
    // dispatchToolCalls is designed never to reject, but the conversation's
    // pluggable truncation strategy can. Keep step()'s public no-throw
    // contract true across that boundary as well.
    return failed(error, result.latencyMs, "invalidContext");
  }

  return { result, toolCalls, toolResults, done: false };
}
