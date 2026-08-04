/**
 * Model call with bounded retry on transient transport errors.
 *
 * Not in any ADR — added after live running showed roughly 1 call in 10
 * failing with a bare `fetch failed` (a connection-level error, not an API
 * rejection), which made verification runs unreproducible.
 *
 * This is NOT the `fallbackConfigKey` that 1.4 deferred. That was
 * "auto-retry against a *different* configKey on failure" — a routing
 * policy. This retries the *same* call after a transport error, which is a
 * transport concern. The deferral stands.
 *
 * The classification and backoff are pi-ai's own (`retryAssistantCall` /
 * `isRetryableAssistantError`), not hand-rolled: deterministic failures
 * such as quota exhaustion or a bad parameter are returned immediately
 * rather than retried, which is exactly what we want — retrying
 * "Unsupported parameter: temperature" three times would only slow down a
 * real error.
 */

import { retryAssistantCall, type RetryPolicy } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Context, Model, Models } from "@earendil-works/pi-ai";
import { callOptions } from "./load-model.ts";
import type { ConfigEntry } from "./config.ts";
import type { HarnessResult } from "./types.ts";

/**
 * TUNABLE, and measured rather than guessed.
 *
 * Observed failure rates on this network: individual calls fail ~8% of the
 * time with `fetch failed`. Retrying should therefore make a two-call run
 * near-certain to succeed — but measured run-level success only went from
 * ~85% to ~87% across 15 runs.
 *
 * That gap is the interesting part: it means the failures are **bursty**,
 * not independent. When connectivity drops, every attempt inside the retry
 * window fails together, so more attempts inside a short window buy almost
 * nothing. Widening the window is what helps, hence 1000ms base rather than
 * 500ms — 3 retries then span ~7s instead of ~3.5s.
 *
 * Deliberately not tuned further: past a few seconds this stops being
 * "absorb a flaky connection" and starts being "hide an outage", and a
 * verification script should fail visibly when the network is genuinely
 * down.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 1000,
};

export interface CompleteOptions {
  policy?: RetryPolicy;
  signal?: AbortSignal;
  /** Called before each backoff sleep, so scripts can show what happened. */
  onRetry?: (attempt: number, maxAttempts: number, delayMs: number, error: string) => void;
}

/** One model call, retried on transient failure, returned as a `HarnessResult`. */
export async function complete(
  models: Models,
  model: Model<Api>,
  entry: ConfigEntry,
  context: Context,
  configKey: string,
  options: CompleteOptions = {},
): Promise<HarnessResult> {
  const started = Date.now();

  const message: AssistantMessage = await retryAssistantCall(
    () => models.complete(model, context, callOptions(entry)),
    options.policy ?? DEFAULT_RETRY_POLICY,
    options.signal,
    {
      onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
        options.onRetry?.(attempt, maxAttempts, delayMs, errorMessage);
      },
    },
  );

  return {
    message,
    configKey,
    routedVia: "native",
    latencyMs: Date.now() - started,
  };
}
