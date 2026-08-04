/**
 * 1.2 — Pre-flight `Context` validation.
 *
 * The one real gap the ADR identified: pi-ai validates tool call
 * *arguments* on the way back (`validateToolCall`), but nothing validates a
 * `Context` on the way *in*. This guard runs at the harness boundary,
 * before handoff to pi-ai, so harness-level misconfiguration surfaces as a
 * clear error instead of a confusing provider-level one.
 *
 * The ADR named three checks (empty messages, malformed tool schema,
 * unknown configKey) but left them un-itemized. Itemized below; each check
 * says which of the three it implements, or is marked as an addition.
 */

import type { Context, Tool } from "@earendil-works/pi-ai";
import { HarnessError } from "./types.ts";

/** One problem found in a Context. Collected so a caller sees all of them at once. */
export interface ContextIssue {
  path: string;
  message: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * ADR check 2 — "a tool whose `parameters` isn't a valid TypeBox schema".
 *
 * A full JSON Schema meta-validation would be overkill here; what actually
 * breaks providers is a `parameters` that isn't an object schema at all.
 * TypeBox's `Type.Object()` always emits `{ type: "object", properties }`,
 * and every provider's tool-translation step assumes that shape.
 */
function validateToolSchema(tool: Tool, index: number, issues: ContextIssue[]): void {
  const path = `tools[${index}]`;

  // A null/non-object entry has to be caught before any property access —
  // this is a *validator*, so it must report malformed input as an issue,
  // not crash with a TypeError the caller can't interpret.
  if (typeof tool !== "object" || tool === null) {
    issues.push({ path, message: `Tool at index ${index} is not an object.` });
    return;
  }

  if (typeof tool.name !== "string" || tool.name.length === 0) {
    issues.push({ path: `${path}.name`, message: "Tool name must be a non-empty string." });
  }

  const params: unknown = tool.parameters;
  if (!isPlainObject(params)) {
    issues.push({
      path: `${path}.parameters`,
      message: `Tool "${tool.name}" has no parameters schema. Expected a TypeBox schema object (e.g. Type.Object({...})).`,
    });
    return;
  }

  if (params["type"] !== "object") {
    issues.push({
      path: `${path}.parameters`,
      message: `Tool "${tool.name}" parameters must be an object schema (type: "object"), got type: ${JSON.stringify(params["type"])}.`,
    });
    return;
  }

  if (params["properties"] !== undefined && !isPlainObject(params["properties"])) {
    issues.push({
      path: `${path}.parameters.properties`,
      message: `Tool "${tool.name}" parameters.properties must be an object.`,
    });
  }

  // Addition, not in the ADR's list: `required` naming a property that
  // doesn't exist is silently accepted by some providers and rejected by
  // others. Cheap to catch here, and the asymmetry is exactly the kind of
  // provider-specific surprise the harness exists to flatten.
  const required: unknown = params["required"];
  const properties = isPlainObject(params["properties"]) ? params["properties"] : {};
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key === "string" && !(key in properties)) {
        issues.push({
          path: `${path}.parameters.required`,
          message: `Tool "${tool.name}" marks "${key}" as required but does not define it in properties.`,
        });
      }
    }
  } else if (required !== undefined) {
    issues.push({
      path: `${path}.parameters.required`,
      message: `Tool "${tool.name}" parameters.required must be an array of property names.`,
    });
  }
}

/**
 * Collects every problem with a `Context` without throwing.
 *
 * `knownConfigKeys` is optional: pass it to include ADR check 3 (unknown
 * configKey). Omit it when validating a Context in isolation, with no
 * config loaded.
 */
export function collectContextIssues(
  context: Context,
  configKey?: string,
  knownConfigKeys?: Iterable<string>,
): ContextIssue[] {
  const issues: ContextIssue[] = [];

  if (typeof context !== "object" || context === null) {
    return [{ path: "context", message: "Context must be an object." }];
  }

  // ADR check 3 — unknown configKey.
  if (configKey !== undefined && knownConfigKeys !== undefined) {
    const known = new Set(knownConfigKeys);
    if (!known.has(configKey)) {
      const available = [...known].sort().join(", ") || "(none)";
      issues.push({
        path: "configKey",
        message: `Unknown configKey "${configKey}". Available: ${available}.`,
      });
    }
  }

  // ADR check 1 — empty messages.
  if (!Array.isArray(context.messages)) {
    issues.push({ path: "messages", message: "Context.messages must be an array." });
  } else if (context.messages.length === 0) {
    issues.push({
      path: "messages",
      message: "Context.messages is empty — there is nothing to send to the model.",
    });
  }

  // ADR check 2 — malformed tool schema.
  if (context.tools !== undefined) {
    if (!Array.isArray(context.tools)) {
      issues.push({ path: "tools", message: "Context.tools must be an array when present." });
    } else {
      const seen = new Set<string>();
      context.tools.forEach((tool, i) => {
        validateToolSchema(tool, i, issues);
        // Addition, not in the ADR's list: duplicate tool names make
        // dispatch ambiguous — 1.6's ToolRegistry is keyed by name, so a
        // duplicate silently overwrites. Worth catching before the call.
        if (typeof tool?.name === "string") {
          if (seen.has(tool.name)) {
            issues.push({
              path: `tools[${i}].name`,
              message: `Duplicate tool name "${tool.name}".`,
            });
          }
          seen.add(tool.name);
        }
      });
    }
  }

  return issues;
}

/**
 * The guard itself. Throws `HarnessError` on the first validation failure,
 * with every issue listed in the message.
 *
 * Throws rather than returning a result because callers should not be able
 * to proceed past it by accident; the orchestration loop converts the throw
 * into a `HarnessResult` with `stopReason: "error"` (see `errorResult`).
 */
export function validateContext(
  context: Context,
  configKey?: string,
  knownConfigKeys?: Iterable<string>,
): void {
  const issues = collectContextIssues(context, configKey, knownConfigKeys);
  if (issues.length === 0) return;

  const kind = issues.some((i) => i.path === "configKey") ? "unknownConfigKey" : "invalidContext";
  const detail = issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n");
  throw new HarnessError(kind, `Context failed pre-flight validation:\n${detail}`);
}
