/**
 * 1.2 — Harness-level error wrapping.
 *
 * Failures that happen before pi-ai is reached still have to come back as a
 * `HarnessResult`, so callers have exactly one place to check for failure.
 * That means synthesising an `AssistantMessage` with `stopReason: "error"`.
 */

import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { HarnessError, HarnessResult } from "./types.ts";

/** A zeroed `Usage` — no tokens were spent, because no call was made. */
function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * Builds the `stopReason: "error"` AssistantMessage for a pre-flight
 * failure.
 *
 * `api`/`provider`/`model` are required on pi-ai's `AssistantMessage` but
 * genuinely unknown here — the failure is *why* we never resolved a model.
 * They're filled with what the config asked for where known, and the
 * harness's own marker where not, rather than left blank.
 */
export function errorMessage(options: {
  error: HarnessError;
  provider?: string;
  modelId?: string;
}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: options.error.message }],
    api: "harness-preflight",
    provider: options.provider ?? "harness",
    model: options.modelId ?? "unknown",
    usage: emptyUsage(),
    stopReason: "error",
    errorMessage: options.error.message,
    timestamp: Date.now(),
  };
}

/** Wraps a pre-flight failure into the same shape a successful call returns. */
export function errorResult(options: {
  error: HarnessError;
  configKey: string;
  provider?: string;
  modelId?: string;
  latencyMs?: number;
}): HarnessResult {
  return {
    message: errorMessage(options),
    configKey: options.configKey,
    routedVia: "native",
    latencyMs: options.latencyMs ?? 0,
  };
}
