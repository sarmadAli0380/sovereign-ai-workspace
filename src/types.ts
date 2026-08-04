/**
 * 1.2 — Unified schema, mapped onto pi-ai's ontology.
 *
 * Per `phase1/adrs/1.2-schema-ontology-mapping.md`: there is no custom
 * message schema here. pi-ai's own types ARE the harness's wire contract,
 * so this module re-exports them unchanged and adds only what pi-ai has no
 * concept of — the harness's own per-call metadata.
 *
 * Explicitly NOT rebuilt (see the ADR): UnifiedMessage, a tool-schema
 * validator (`validateToolCall` covers it), a usage/cost shape (`Usage`
 * has it).
 */

import type {
  AssistantMessage,
  Context,
  Message,
  Tool,
  ToolCall,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";

// Adopted as-is. Re-exported so harness consumers have one import site and
// the "app code only ever talks to pi-ai types" property stays visible.
export type {
  AssistantMessage,
  Context,
  Message,
  Tool,
  ToolCall,
  ToolResultMessage,
  Usage,
};

/**
 * What the harness adds on top of a single pi-ai model call.
 *
 * `message` is the untouched pi-ai type — nothing is repacked or renamed.
 */
export interface HarnessResult {
  message: AssistantMessage;
  /** Which `model.config.json` entry resolved this call. */
  configKey: string;
  /**
   * ADR-002's routing choice made visible. Always `"native"` in Phase 1 —
   * no gateway provider is registered yet, so there is nothing else to
   * report. Kept in the shape (rather than added later) so callers that
   * log or persist a HarnessResult don't need a migration when the
   * LiteLLM gateway lands in Phase 5.
   */
  routedVia: "native" | "gateway";
  latencyMs: number;
}

/**
 * A harness-level failure that happened *before* pi-ai was reached — an
 * unknown configKey, a context that failed pre-flight validation, a
 * provider that resolved to no model.
 *
 * Per the ADR these resolve to the same `HarnessResult` shape as a success,
 * so a caller checks `result.message.stopReason === "error"` in exactly one
 * place regardless of whether the failure was inside or outside pi-ai's
 * reach.
 */
export type HarnessErrorKind =
  | "unknownConfigKey"
  | "modelNotFound"
  | "invalidContext"
  | "providerError";

export class HarnessError extends Error {
  readonly kind: HarnessErrorKind;

  constructor(kind: HarnessErrorKind, message: string) {
    super(message);
    this.name = "HarnessError";
    this.kind = kind;
  }
}
