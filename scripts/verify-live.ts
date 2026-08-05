/**
 * Live verification of the Phase 1 harness against a real provider.
 *
 *   node scripts/verify-live.ts [configKey]     # default: codex-default
 *
 * Drives one full request → tool-call → dispatch → response cycle through
 * every piece 1.2/1.4/1.5/1.6/1.7 built, using the same minimal `get_weather`
 * tool-calling test case the original spike used for Anthropic (ADR 1.1),
 * so the two legs are comparable.
 *
 * The turn cycle runs through 1.7's `step()`. The turn cap and the stopping
 * rule live in this file, not in the library — `step()` performs exactly one
 * transition and returns.
 */

import { Type } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { loadConfig } from "../src/config.ts";
import { getModels, loadModel } from "../src/load-model.ts";
import { ConversationManager } from "../src/conversation-manager.ts";
import { estimateContextTokens } from "../src/truncation.ts";
import { ToolRegistry } from "../src/tool-registry.ts";
import { step, type StepDeps } from "../src/step.ts";
import type { HarnessResult } from "../src/types.ts";

const configKey = process.argv[2] ?? "codex-default";

// --- 1.4: config → model, a single lookup with no caller-side branching

const config = loadConfig();
const { model, entry, contextWindow } = loadModel(configKey, config);

console.log(`configKey:     ${configKey}`);
console.log(`provider:      ${entry.provider}`);
console.log(`model:         ${model.id}  (api: ${model.api})`);
console.log(`contextWindow: ${contextWindow}${entry.contextWindow ? ` (config override; model advertises ${model.contextWindow})` : ""}`);

// --- auth pre-flight

const models = getModels();

// "No credential stored" and "credential stored but unusable" are different
// failures and need different fixes — an expired OAuth refresh token reports
// as the latter, and collapsing both into "not logged in" sends you looking
// in the wrong place.
const stored = await models.checkAuth(entry.provider);
if (!stored) {
  console.error(
    `\n✗ No credential stored for "${entry.provider}".\n` +
      `  Run: node scripts/login.ts ${entry.provider}`,
  );
  process.exit(1);
}

try {
  await models.getAuth(entry.provider);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`\n✗ Credential for "${entry.provider}" is stored but could not be resolved.`);
  console.error(`  ${detail.split("\n")[0]}`);
  if (/refresh_token_invalidated|session has ended|401/.test(detail)) {
    console.error(`\n  The stored OAuth token has expired. Re-authorize with:`);
    console.error(`    node scripts/login.ts ${entry.provider}`);
  }
  process.exit(1);
}

// --- 1.6: a tool registry with the spike's get_weather tool

const registry = new ToolRegistry();
registry.register({
  definition: {
    name: "get_weather",
    description: "Get the current weather for a city",
    parameters: Type.Object({
      city: Type.String({ description: "The city to get weather for" }),
    }),
  },
  async execute(args) {
    // Fixed response — this verifies the harness's plumbing, not a weather API.
    return { content: [{ type: "text", text: `18°C and sunny in ${String(args["city"])}` }] };
  },
});

// --- 1.5: conversation state, sized from the resolved model

const conversation = new ConversationManager({
  systemPrompt: "You are a concise assistant. Use tools when they are relevant.",
  tools: registry.getToolDefinitions(),
  contextWindow,
});

conversation.append({
  role: "user",
  content: "What is the weather in Paris? Use the get_weather tool.",
  timestamp: Date.now(),
});

// --- 1.7: one step per turn.
//
// This used to hand-roll the validate -> complete -> dispatch -> append
// cycle inline, hardcoded to exactly two turns, which is precisely why
// `step()` now exists: nobody could use the library without copying this
// block out of a test script. The loop below is the caller's, not the
// library's.

const deps: StepDeps = {
  models,
  model,
  entry,
  configKey,
  conversation,
  registry,
  knownConfigKeys: Object.keys(config),
  options: {
    onRetry: (attempt, max, delayMs, error) =>
      console.log(`  transient failure (${error}) — retry ${attempt}/${max} in ${delayMs}ms`),
  },
};

function describe(label: string, result: HarnessResult): void {
  const m = result.message;
  console.log(`\n--- ${label} ---`);
  console.log(`stopReason:  ${m.stopReason}`);
  console.log(`blocks:      ${m.content.map((b) => b.type).join(", ") || "(none)"}`);
  console.log(`usage:       in=${m.usage.input} out=${m.usage.output} total=${m.usage.totalTokens}`);
  console.log(`latencyMs:   ${result.latencyMs}`);
  if (m.errorMessage) console.log(`errorMessage: ${m.errorMessage}`);

  const text = m.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (text) console.log(`text:        ${text.slice(0, 300)}`);
}

/** Structural conformity checks — shape, not wording. */
function checkShape(m: AssistantMessage): string[] {
  const failures: string[] = [];

  // Checked FIRST and deliberately: a failed call still carries every
  // required field, so a pure field-presence check reports a network error
  // or an auth failure as a conforming response. Verifying the shape of an
  // error message proves nothing about the provider.
  if (m.stopReason === "error" || m.stopReason === "aborted") {
    failures.push(`call did not succeed (stopReason: ${m.stopReason}): ${m.errorMessage ?? "no detail"}`);
  }

  if (m.role !== "assistant") failures.push("role is not 'assistant'");
  if (!Array.isArray(m.content)) failures.push("content is not an array");
  if (typeof m.stopReason !== "string") failures.push("stopReason missing");
  if (typeof m.usage?.input !== "number") failures.push("usage.input missing");
  if (typeof m.usage?.output !== "number") failures.push("usage.output missing");
  if (typeof m.usage?.totalTokens !== "number") failures.push("usage.totalTokens missing");
  if (typeof m.usage?.cost?.total !== "number") failures.push("usage.cost.total missing");
  if (typeof m.provider !== "string") failures.push("provider missing");
  if (typeof m.model !== "string") failures.push("model missing");
  if (typeof m.timestamp !== "number") failures.push("timestamp missing");
  return failures;
}

// The turn cap lives here, in the caller, where it is visible — `step()`
// has no opinion about when to stop. Two is enough to exercise a tool
// round trip; a real application would choose its own.
const MAX_TURNS = 4;
const results: HarnessResult[] = [];
let turn = 0;
let outcome = await step(deps);

for (;;) {
  turn += 1;
  results.push(outcome.result);
  describe(turn === 1 ? "turn 1" : `turn ${turn} (after tool results)`, outcome.result);

  if (turn === 1) console.log(`\ntool calls requested: ${outcome.toolCalls.length}`);
  for (const result of outcome.toolResults) {
    console.log(`  ${result.toolName} -> isError=${result.isError}`);
  }

  if (outcome.done || turn >= MAX_TURNS) break;
  outcome = await step(deps);
}

const exercisedTools = results.length > 1;

// --- report

const failures = results.flatMap((r, i) =>
  checkShape(r.message).map((f) => `turn ${i + 1}: ${f}`),
);

console.log(`\n=== summary ===`);
console.log(`messages in context: ${conversation.getHistory().length}`);
// 1.8 requires the anchored and pure-heuristic numbers side by side, so the
// anchor's accuracy stays a measurement rather than an assumption. The
// overhead is broken out too: it is the part the budget used to be blind to,
// and the part no truncation strategy can ever reclaim.
const budget = conversation.getBudgetUsage();
const heuristic =
  estimateContextTokens(conversation.getHistory()) + conversation.getOverheadTokens();
console.log(
  `context tokens:      ${budget.tokens} / ${conversation.getBudgetTokens()} budget (${budget.source})`,
);
console.log(
  `  pure heuristic:    ${heuristic}` +
    (budget.source === "anchored"
      ? `  (anchor moved it by ${budget.tokens - heuristic >= 0 ? "+" : ""}${budget.tokens - heuristic})`
      : ""),
);
console.log(`  of which overhead: ${conversation.getOverheadTokens()} (system prompt + tool schemas)`);
console.log(`tool call round-trip: ${exercisedTools ? "exercised" : "NOT exercised (model did not call the tool)"}`);

if (failures.length > 0) {
  console.error(`\n✗ Structural conformity failures:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`\n✓ AssistantMessage shape conforms for ${entry.provider}/${model.id}.`);
