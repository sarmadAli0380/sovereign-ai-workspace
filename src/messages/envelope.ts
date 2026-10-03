import type { JsonObject, JsonValue } from "../json.ts";

export const PRODUCT_MESSAGE_SCHEMA_VERSION = 1 as const;

export type ProductMessageRole = "user" | "assistant" | "toolResult";
export type ProductAssistantStopReason = "stop" | "length" | "toolUse";

export interface ProductTextBlock {
  type: "text";
  text: string;
  /** Opaque provider continuity data; never interpreted by product code. */
  signature?: string;
}

export interface ProductThinkingBlock {
  type: "thinking";
  text: string;
  /** Opaque provider continuity data; never interpreted by product code. */
  signature?: string;
  redacted?: boolean;
}

export interface ProductImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ProductToolCallBlock {
  type: "toolCall";
  toolCallId: string;
  toolName: string;
  arguments: JsonObject;
  /** Opaque provider continuity data attached to this tool request. */
  thoughtSignature?: string;
}

export type ProductMessageBlock =
  | ProductTextBlock
  | ProductThinkingBlock
  | ProductImageBlock
  | ProductToolCallBlock;

export interface ProductCostUsd {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface ProductMessageUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens?: number;
  reasoningTokens?: number;
  totalTokens: number;
  /** pi-ai documents its cost values as US dollars. */
  costUsd: ProductCostUsd;
}

export interface ProductDiagnosticError {
  name?: string;
  message: string;
  stack?: string;
  code?: string | number;
}

export interface ProductDiagnostic {
  type: string;
  occurredAt: string;
  error?: ProductDiagnosticError;
  details?: JsonObject;
}

export interface ProductProviderMetadata {
  api: string;
  provider: string;
  model: string;
  configKey?: string;
  responseModel?: string;
  responseId?: string;
  diagnostics?: readonly ProductDiagnostic[];
}

export interface ProductAssistantMetadata {
  stopReason: ProductAssistantStopReason;
  /** Provider diagnostic text attached to an otherwise completed response. */
  diagnosticMessage?: string;
}

export interface ProductToolResultMetadata {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  details?: JsonValue;
  addedToolNames?: readonly string[];
}

export interface ProductProviderExtensionBlock {
  provider: string;
  kind: string;
  data: JsonObject;
}

export interface ProductMessageExtensions {
  /** Explicit opt-in only. Raw provider payload capture remains off by default. */
  providerBlocks: readonly ProductProviderExtensionBlock[];
}

/** Product-owned version-1 message stored by Phase B and exposed by public APIs. */
export interface ProductMessageEnvelopeV1 {
  schemaVersion: typeof PRODUCT_MESSAGE_SCHEMA_VERSION;
  messageId: string;
  role: ProductMessageRole;
  createdAt: string;
  content: readonly ProductMessageBlock[];
  provider?: ProductProviderMetadata;
  assistant?: ProductAssistantMetadata;
  toolResult?: ProductToolResultMetadata;
  usage?: ProductMessageUsage;
  extensions?: ProductMessageExtensions;
}

export type ProductMessageEnvelope = ProductMessageEnvelopeV1;

export interface ProductRunFailedMetadata {
  kind: "failed";
  code: string;
  occurredAt: string;
  retryable: boolean;
  detail?: string;
  provider?: ProductProviderMetadata;
  usage?: ProductMessageUsage;
  extensions?: ProductMessageExtensions;
}

export interface ProductRunCancelledMetadata {
  kind: "cancelled";
  code: string;
  occurredAt: string;
  detail?: string;
  provider?: ProductProviderMetadata;
  usage?: ProductMessageUsage;
  extensions?: ProductMessageExtensions;
}

export type ProductRunTermination =
  | ProductRunFailedMetadata
  | ProductRunCancelledMetadata;

export type ProductAssistantPersistenceOutcome =
  | { kind: "message"; message: ProductMessageEnvelope }
  | { kind: "terminal"; terminal: ProductRunTermination };
