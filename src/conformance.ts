/** Runtime checks used by the live provider-conformance scripts. */

const STOP_REASONS = new Set(["stop", "length", "toolUse", "error", "aborted"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export interface AssistantConformanceOptions {
  /** Reject provider/transport failures rather than validating their wrapper shape. */
  requireSuccess?: boolean;
  /** Require at least one well-formed toolCall content block. */
  requireToolCall?: boolean;
  /** Require at least one non-empty text content block. */
  requireText?: boolean;
}

export interface OllamaRuntimeObservation {
  contextLength?: number;
  sizeVramBytes?: number;
  issues: string[];
}

/**
 * Compare Ollama's live runner state with the context window the harness
 * budgets against. Model metadata describes theoretical capacity; `/api/ps`
 * reports what this deployment actually serves.
 */
export function inspectOllamaRuntime(
  payload: unknown,
  modelId: string,
  expectedContextLength: number,
): OllamaRuntimeObservation {
  if (!isObject(payload) || !Array.isArray(payload["models"])) {
    return { issues: ["Ollama /api/ps response does not contain a models array"] };
  }

  const running = payload["models"].find(
    (candidate) =>
      isObject(candidate) &&
      (candidate["model"] === modelId || candidate["name"] === modelId),
  );
  if (!isObject(running)) {
    return { issues: [`Ollama does not report ${modelId} as a running model`] };
  }

  const contextLength = running["context_length"];
  const sizeVramBytes = running["size_vram"];
  const issues: string[] = [];
  if (!finiteNumber(contextLength) || !Number.isInteger(contextLength) || contextLength <= 0) {
    issues.push("Ollama runtime context_length is not a positive whole number");
  } else if (contextLength !== expectedContextLength) {
    issues.push(
      `Ollama serves context ${contextLength}, but the harness budgets for ${expectedContextLength}`,
    );
  }
  if (!finiteNumber(sizeVramBytes) || sizeVramBytes < 0) {
    issues.push("Ollama runtime size_vram is not a finite non-negative number");
  }

  return {
    ...(finiteNumber(contextLength) ? { contextLength } : {}),
    ...(finiteNumber(sizeVramBytes) ? { sizeVramBytes } : {}),
    issues,
  };
}

/**
 * Validate the runtime shape, not the TypeScript annotation.
 *
 * Provider and plugin boundaries can return malformed JSON while still being
 * cast as an AssistantMessage. Conformance evidence must inspect the value it
 * received rather than trusting two malformed providers to agree with each
 * other.
 */
export function collectAssistantMessageIssues(
  message: unknown,
  options: AssistantConformanceOptions = {},
): string[] {
  const issues: string[] = [];
  if (!isObject(message)) return ["message is not an object"];

  if (message["role"] !== "assistant") issues.push("role is not 'assistant'");
  for (const field of ["api", "provider", "model"]) {
    if (typeof message[field] !== "string" || message[field].length === 0) {
      issues.push(`${field} must be a non-empty string`);
    }
  }

  const stopReason = message["stopReason"];
  if (typeof stopReason !== "string" || !STOP_REASONS.has(stopReason)) {
    issues.push("stopReason is missing or unknown");
  } else if (options.requireSuccess && (stopReason === "error" || stopReason === "aborted")) {
    issues.push(
      `call did not succeed (stopReason: ${stopReason}): ${
        typeof message["errorMessage"] === "string" ? message["errorMessage"] : "no detail"
      }`,
    );
  }

  if (!finiteNumber(message["timestamp"])) issues.push("timestamp must be a finite number");

  const usage = message["usage"];
  if (!isObject(usage)) {
    issues.push("usage is not an object");
  } else {
    for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
      if (!finiteNumber(usage[field]) || (usage[field] as number) < 0) {
        issues.push(`usage.${field} must be a finite non-negative number`);
      }
    }
    const cost = usage["cost"];
    if (!isObject(cost)) {
      issues.push("usage.cost is not an object");
    } else {
      for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"]) {
        if (!finiteNumber(cost[field]) || (cost[field] as number) < 0) {
          issues.push(`usage.cost.${field} must be a finite non-negative number`);
        }
      }
    }
  }

  const content = message["content"];
  let toolCalls = 0;
  let nonEmptyText = 0;
  if (!Array.isArray(content)) {
    issues.push("content is not an array");
  } else {
    content.forEach((block, index) => {
      if (!isObject(block) || typeof block["type"] !== "string") {
        issues.push(`content[${index}] is not a typed block`);
        return;
      }
      switch (block["type"]) {
        case "text":
          if (typeof block["text"] !== "string") issues.push(`content[${index}].text is not a string`);
          else if (block["text"].trim().length > 0) nonEmptyText++;
          break;
        case "thinking":
          if (typeof block["thinking"] !== "string") {
            issues.push(`content[${index}].thinking is not a string`);
          }
          break;
        case "toolCall":
          toolCalls++;
          if (typeof block["id"] !== "string" || !block["id"]) {
            issues.push(`content[${index}].id must be a non-empty string`);
          }
          if (typeof block["name"] !== "string" || !block["name"]) {
            issues.push(`content[${index}].name must be a non-empty string`);
          }
          if (!isObject(block["arguments"])) {
            issues.push(`content[${index}].arguments must be an object`);
          }
          break;
        default:
          issues.push(`content[${index}] has unknown type ${JSON.stringify(block["type"])}`);
      }
    });
  }

  if (options.requireToolCall && toolCalls === 0) issues.push("no toolCall block was returned");
  if (options.requireText && nonEmptyText === 0) issues.push("no non-empty text block was returned");
  return issues;
}

/** Structural fingerprint for diagnostics after each value passes validation. */
export function assistantMessageFingerprint(message: Record<string, unknown>): Record<string, string> {
  const shape: Record<string, string> = {};
  for (const [key, value] of Object.entries(message)) {
    shape[key] = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  }
  if (isObject(message["usage"])) {
    for (const [key, value] of Object.entries(message["usage"])) {
      shape[`usage.${key}`] = value === null ? "null" : typeof value;
    }
    const cost = message["usage"]["cost"];
    if (isObject(cost)) {
      for (const [key, value] of Object.entries(cost)) {
        shape[`usage.cost.${key}`] = value === null ? "null" : typeof value;
      }
    }
  }
  if (Array.isArray(message["content"])) {
    shape["content[].types"] = [
      ...new Set(
        message["content"].map((block) =>
          isObject(block) && typeof block["type"] === "string" ? block["type"] : "(invalid)",
        ),
      ),
    ]
      .sort()
      .join("|");
  }
  return shape;
}
