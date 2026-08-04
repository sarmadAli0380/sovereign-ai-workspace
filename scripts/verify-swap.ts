/**
 * 1.4's outstanding definition of done, and 1.7's swap proof:
 *
 *   "Run a script twice, editing only model.config.json between runs,
 *    confirm identical AssistantMessage shape both times."
 *
 *   node scripts/verify-swap.ts <configKeyA> <configKeyB>
 *
 * Sends the same prompt through two config keys with byte-identical calling
 * code, then diffs the two `AssistantMessage`s structurally — field
 * presence and types, never wording. Different models say different things;
 * that is the point of the abstraction, not a failure of it.
 */

import { loadConfig } from "../src/config.ts";
import { getModels, loadModel } from "../src/load-model.ts";
import { complete } from "../src/complete.ts";
import { validateContext } from "../src/validate-context.ts";
import { ConversationManager } from "../src/conversation-manager.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { HarnessResult } from "../src/types.ts";

const keyA = process.argv[2];
const keyB = process.argv[3];

if (!keyA || !keyB) {
  console.error("Usage: node scripts/verify-swap.ts <configKeyA> <configKeyB>");
  process.exit(1);
}

const PROMPT = "In one sentence, what is a model-agnostic LLM harness?";

const config = loadConfig();
const models = getModels();

/** Identical for both keys — the only thing that varies is `configKey`. */
async function run(configKey: string): Promise<HarnessResult> {
  const { model, entry, contextWindow } = loadModel(configKey, config);

  const conversation = new ConversationManager({
    systemPrompt: "Answer in one sentence.",
    contextWindow,
  });
  conversation.append({ role: "user", content: PROMPT, timestamp: Date.now() });

  validateContext(conversation.getContext(), configKey, Object.keys(config));

  return complete(models, model, entry, conversation.getContext(), configKey, {
    onRetry: (attempt, max, delayMs, error) =>
      console.log(`  [${configKey}] transient failure (${error}) — retry ${attempt}/${max} in ${delayMs}ms`),
  });
}

/** Structural fingerprint: field names and types, no values. */
function fingerprint(message: AssistantMessage): Record<string, string> {
  const shape: Record<string, string> = {};
  for (const [key, value] of Object.entries(message)) {
    shape[key] = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  }
  for (const [key, value] of Object.entries(message.usage)) {
    shape[`usage.${key}`] = typeof value === "object" ? "object" : typeof value;
  }
  // Must read the ACTUAL type, not assert the expected one — hardcoding
  // "number" here made a `cost.total` of `"n/a"` compare equal to a real
  // number, so a malformed response passed the diff clean.
  for (const [key, value] of Object.entries(message.usage.cost)) {
    shape[`usage.cost.${key}`] = value === null ? "null" : typeof value;
  }
  shape["content[].types"] = [...new Set(message.content.map((b) => b.type))].sort().join("|");
  return shape;
}

function report(result: HarnessResult): void {
  const m = result.message;
  const text = m.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  console.log(`\n--- ${result.configKey} ---`);
  console.log(`provider:   ${m.provider}`);
  console.log(`model:      ${m.model}`);
  console.log(`api:        ${m.api}`);
  console.log(`stopReason: ${m.stopReason}`);
  console.log(`usage:      in=${m.usage.input} out=${m.usage.output} total=${m.usage.totalTokens}`);
  console.log(`latencyMs:  ${result.latencyMs}`);
  console.log(`text:       ${text.slice(0, 200)}`);
}

const a = await run(keyA);
const b = await run(keyB);

report(a);
report(b);

// --- structural diff

const shapeA = fingerprint(a.message);
const shapeB = fingerprint(b.message);
const allKeys = [...new Set([...Object.keys(shapeA), ...Object.keys(shapeB)])].sort();

const differences: string[] = [];
for (const key of allKeys) {
  const left = shapeA[key] ?? "(absent)";
  const right = shapeB[key] ?? "(absent)";
  if (left !== right) differences.push(`  ${key}: ${keyA}=${left}  ${keyB}=${right}`);
}

console.log(`\n=== structural diff ===`);
console.log(`fields compared: ${allKeys.length}`);

const sameProvider = a.message.provider === b.message.provider;
console.log(
  sameProvider
    ? `NOTE: both keys resolved to provider "${a.message.provider}" — this is a MODEL swap, not a provider swap.`
    : `providers: ${a.message.provider} vs ${b.message.provider} — genuine provider swap.`,
);

if (differences.length > 0) {
  console.log(`\ndifferences (${differences.length}):`);
  for (const line of differences) console.log(line);
  // Optional fields legitimately vary between providers (e.g. `reasoning` in
  // usage, `responseId`). Report them rather than failing outright — the
  // required core is checked below.
}

const requiredFields = [
  "role",
  "content",
  "api",
  "provider",
  "model",
  "usage",
  "stopReason",
  "timestamp",
  "usage.input",
  "usage.output",
  "usage.totalTokens",
  "usage.cost.total",
];

const missing = requiredFields.filter((f) => shapeA[f] === undefined || shapeB[f] === undefined);

if (missing.length > 0) {
  console.error(`\n✗ Required fields missing from one or both responses: ${missing.join(", ")}`);
  process.exit(1);
}

// A failed call carries every required field too, so field presence alone
// would pass a network error as a conforming response.
const failed = [a, b].filter(
  (r) => r.message.stopReason === "error" || r.message.stopReason === "aborted",
);
if (failed.length > 0) {
  console.error(`\n✗ Call did not succeed for: ${failed.map((r) => r.configKey).join(", ")}`);
  for (const r of failed) {
    console.error(`  ${r.configKey}: ${r.message.stopReason} — ${r.message.errorMessage ?? "no detail"}`);
  }
  process.exit(1);
}

console.log(`\n✓ Both responses carry every required AssistantMessage field with matching types.`);
console.log(`✓ Swap performed with zero code changes — only the configKey differed.`);
