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

// 1.5 — conversation state
export {
  capToolResult,
  ConversationManager,
  DEFAULT_MAX_TOOL_RESULT_CHARS,
  DEFAULT_RESERVE_TOKENS,
  type ConversationManagerOptions,
} from "./conversation-manager.ts";
export {
  dropOldestStrategy,
  estimateContextTokens,
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
