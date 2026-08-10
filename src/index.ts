/**
 * Phase 1 model-agnostic harness — public surface.
 *
 * Built on @earendil-works/pi-ai per ADR-002. Everything here is either a
 * re-export of pi-ai's own ontology (1.2) or one of the four pieces the
 * harness genuinely owns: config routing (1.4), conversation state (1.5),
 * and tool dispatch (1.6).
 */

// 1.2 — schema/ontology
export type {
  AssistantMessage,
  Context,
  HarnessErrorKind,
  HarnessResult,
  Message,
  Tool,
  ToolCall,
  ToolResultMessage,
  Usage,
} from "./types.ts";
export { HarnessError } from "./types.ts";
export { errorMessage, errorResult } from "./harness-result.ts";
export { collectContextIssues, validateContext, type ContextIssue } from "./validate-context.ts";

// 1.4 — config + routing
export {
  DEFAULT_CONFIG_PATH,
  loadConfig,
  parseConfig,
  type ConfigEntry,
  type HarnessConfig,
} from "./config.ts";
export { callOptions, getModels, loadModel, type ResolvedModel } from "./load-model.ts";
export { complete, DEFAULT_RETRY_POLICY, type CompleteOptions } from "./complete.ts";
export {
  assistantMessageFingerprint,
  collectAssistantMessageIssues,
  inspectOllamaRuntime,
  type AssistantConformanceOptions,
  type OllamaRuntimeObservation,
} from "./conformance.ts";

// 1.7 — one transition of a conversation. Deliberately not a loop: the
// caller owns iteration, and this is the one place that turns a failure
// into a HarnessResult rather than a throw.
export { step, type StepDeps, type StepResult } from "./step.ts";

// 1.5 — conversation state
export {
  capToolResult,
  ConversationManager,
  DEFAULT_MAX_TOOL_RESULT_CHARS,
  DEFAULT_RESERVE_TOKENS,
  type BudgetSource,
  type BudgetUsage,
  type ConversationManagerOptions,
} from "./conversation-manager.ts";
export {
  dropOldestStrategy,
  estimateContextTokens,
  estimateOverheadTokens,
  estimateTokens,
  type TruncationStrategy,
} from "./truncation.ts";

// 1.6 — tool calling
export {
  dispatchToolCall,
  dispatchToolCalls,
  ToolRegistry,
  type ToolHandler,
} from "./tool-registry.ts";

// 2.4 — memory sizing. Not part of the inference path; it is arithmetic
// over model metadata, used to decide what a given box can serve.
export {
  BITS_PER_WEIGHT,
  DEVICE_MEMORY_RESERVE_BYTES,
  estimateMemory,
  fitsIn,
  FIXED_OVERHEAD_BYTES,
  gb,
  kvBytesPerToken,
  maxContextFor,
  RUNTIME_BYTES_PER_TOKEN,
  type FitVerdict,
  type ModelGeometry,
  type SizingEstimate,
  type SizingInput,
} from "./sizing.ts";
