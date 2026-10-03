import { cloneJsonValue, collectJsonValueIssues, type JsonObject, type JsonValue } from "./json.ts";

export type ToolPolicyDecisionKind = "allow" | "deny" | "requireApproval";

export interface ToolPolicyContext {
  deploymentId: string;
  roleId: string;
  workspaceId: string;
}

export interface ToolPolicySubject {
  toolName: string;
  capabilities: readonly string[];
  risk: "low" | "medium" | "high" | "critical";
  sideEffect: "none" | "reversible" | "irreversible";
}

export interface ToolPolicyInput extends ToolPolicyContext, ToolPolicySubject {
  /** Schema-validated, JSON-owned arguments. Conversation content is never an input. */
  normalizedArguments: JsonObject;
}

export interface CapabilityPolicyRule {
  deploymentId: string | "*";
  roleId: string | "*";
  workspaceId: string | "*";
  capability: string | "*";
  /** Optional exact subset match against normalized top-level arguments. */
  argumentEquals?: JsonObject;
  decision: ToolPolicyDecisionKind;
  /** Stable, machine-readable product code. */
  reasonCode: string;
}

export interface CapabilityPolicyConfig {
  rules: readonly CapabilityPolicyRule[];
}

export interface CapabilityDecision {
  capability: string;
  decision: ToolPolicyDecisionKind;
  reasonCode: string;
}

export interface ToolPolicyDecision {
  decision: ToolPolicyDecisionKind;
  reasonCode: string;
  /** The lexically first capability responsible for the aggregate decision. */
  capability: string;
  capabilityDecisions: readonly CapabilityDecision[];
}

const RULE_KEYS = new Set([
  "deploymentId",
  "roleId",
  "workspaceId",
  "capability",
  "argumentEquals",
  "decision",
  "reasonCode",
]);

function requireIdentifier(value: unknown, field: string, allowWildcard = false): asserts value is string {
  if (
    typeof value !== "string" ||
    (value !== "*" && !/^[A-Za-z0-9_][A-Za-z0-9._:/-]*$/.test(value)) ||
    (!allowWildcard && value === "*")
  ) {
    throw new TypeError(`${field} must be a non-empty identifier${allowWildcard ? " or *" : ""}`);
  }
}

function requireCapability(value: unknown, field: string, allowWildcard = false): asserts value is string {
  if (
    typeof value !== "string" ||
    (!allowWildcard && value === "*") ||
    (value !== "*" && !/^[a-z][a-z0-9.-]*$/.test(value))
  ) {
    throw new TypeError(`${field} must be a stable lowercase capability${allowWildcard ? " or *" : ""}`);
  }
}

function requireReasonCode(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value)) {
    throw new TypeError(`${field} must be a stable lowercase reason code`);
  }
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as JsonObject;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`)
    .join(",")}}`;
}

function argumentsMatch(expected: JsonObject | undefined, actual: JsonObject): boolean {
  if (!expected) return true;
  return Object.entries(expected).every(
    ([key, value]) => key in actual && canonicalJson(actual[key]!) === canonicalJson(value),
  );
}

function selectorMatches(selector: string, actual: string): boolean {
  return selector === "*" || selector === actual;
}

function specificity(rule: CapabilityPolicyRule): number {
  return (
    Number(rule.deploymentId !== "*") +
    Number(rule.roleId !== "*") +
    Number(rule.workspaceId !== "*") +
    Number(rule.capability !== "*") +
    Object.keys(rule.argumentEquals ?? {}).length
  );
}

function validateRule(rule: CapabilityPolicyRule, index: number): CapabilityPolicyRule {
  if (typeof rule !== "object" || rule === null || Array.isArray(rule)) {
    throw new TypeError(`rules[${index}] must be an object`);
  }
  const unknown = Object.keys(rule).filter((key) => !RULE_KEYS.has(key));
  if (unknown.length > 0) throw new TypeError(`rules[${index}] has unknown fields: ${unknown.join(", ")}`);
  requireIdentifier(rule.deploymentId, `rules[${index}].deploymentId`, true);
  requireIdentifier(rule.roleId, `rules[${index}].roleId`, true);
  requireIdentifier(rule.workspaceId, `rules[${index}].workspaceId`, true);
  requireCapability(rule.capability, `rules[${index}].capability`, true);
  if (!new Set<ToolPolicyDecisionKind>(["allow", "deny", "requireApproval"]).has(rule.decision)) {
    throw new TypeError(`rules[${index}].decision must be allow, deny, or requireApproval`);
  }
  requireReasonCode(rule.reasonCode, `rules[${index}].reasonCode`);
  if (rule.argumentEquals !== undefined) {
    const issues: string[] = [];
    collectJsonValueIssues(rule.argumentEquals, `rules[${index}].argumentEquals`, issues);
    if (issues.length > 0 || Array.isArray(rule.argumentEquals) || rule.argumentEquals === null) {
      throw new TypeError(issues[0] ?? `rules[${index}].argumentEquals must be a JSON object`);
    }
  }
  return Object.freeze({
    ...rule,
    ...(rule.argumentEquals
      ? { argumentEquals: Object.freeze(cloneJsonValue(rule.argumentEquals)) }
      : {}),
  });
}

/**
 * Pure, fail-closed capability policy. Rules are data, not callbacks, so
 * conversation text and tool output have no route into authorization.
 */
export class CapabilityPolicy {
  readonly #rules: readonly CapabilityPolicyRule[];

  constructor(config: CapabilityPolicyConfig) {
    if (typeof config !== "object" || config === null || !Array.isArray(config.rules)) {
      throw new TypeError("policy.rules must be an array");
    }
    this.#rules = Object.freeze(config.rules.map(validateRule));
  }

  evaluate(input: ToolPolicyInput): ToolPolicyDecision {
    const allowedInputKeys = new Set([
      "deploymentId",
      "roleId",
      "workspaceId",
      "toolName",
      "capabilities",
      "risk",
      "sideEffect",
      "normalizedArguments",
    ]);
    const unknownInputKeys = Object.keys(input).filter((key) => !allowedInputKeys.has(key));
    if (unknownInputKeys.length > 0) {
      throw new TypeError(`policy input has unknown fields: ${unknownInputKeys.join(", ")}`);
    }
    requireIdentifier(input.deploymentId, "deploymentId");
    requireIdentifier(input.roleId, "roleId");
    requireIdentifier(input.workspaceId, "workspaceId");
    requireIdentifier(input.toolName, "toolName");
    if (!Array.isArray(input.capabilities) || input.capabilities.length === 0) {
      throw new TypeError("capabilities must be a non-empty array");
    }
    const capabilities = [...new Set(input.capabilities)].sort();
    if (capabilities.length !== input.capabilities.length) {
      throw new TypeError("capabilities must not contain duplicates");
    }
    for (const capability of capabilities) requireCapability(capability, "capability");
    if (!new Set(["low", "medium", "high", "critical"]).has(input.risk)) {
      throw new TypeError("risk must be low, medium, high, or critical");
    }
    if (!new Set(["none", "reversible", "irreversible"]).has(input.sideEffect)) {
      throw new TypeError("sideEffect must be none, reversible, or irreversible");
    }
    const argumentIssues: string[] = [];
    collectJsonValueIssues(input.normalizedArguments, "normalizedArguments", argumentIssues);
    if (argumentIssues.length > 0) throw new TypeError(argumentIssues[0]);

    const decisions = capabilities.map((capability): CapabilityDecision => {
      const matches = this.#rules.filter(
        (rule) =>
          selectorMatches(rule.deploymentId, input.deploymentId) &&
          selectorMatches(rule.roleId, input.roleId) &&
          selectorMatches(rule.workspaceId, input.workspaceId) &&
          selectorMatches(rule.capability, capability) &&
          argumentsMatch(rule.argumentEquals, input.normalizedArguments),
      );
      if (matches.length === 0) {
        return { capability, decision: "deny", reasonCode: "policy.no-matching-rule" };
      }
      const highest = Math.max(...matches.map(specificity));
      const winners = matches.filter((rule) => specificity(rule) === highest);
      const outcomes = new Set(winners.map((rule) => `${rule.decision}\u0000${rule.reasonCode}`));
      if (outcomes.size !== 1) {
        return { capability, decision: "deny", reasonCode: "policy.ambiguous" };
      }
      const winner = winners[0]!;
      return { capability, decision: winner.decision, reasonCode: winner.reasonCode };
    });

    const selected =
      decisions.find((item) => item.decision === "deny") ??
      decisions.find((item) => item.decision === "requireApproval") ??
      decisions[0]!;
    return Object.freeze({
      decision: selected.decision,
      reasonCode: selected.reasonCode,
      capability: selected.capability,
      capabilityDecisions: Object.freeze(decisions.map((item) => Object.freeze(item))),
    });
  }
}

export function unconfiguredToolPolicyDecision(
  declaredCapabilities: readonly string[],
): ToolPolicyDecision {
  const capabilities = [...new Set(declaredCapabilities)].sort();
  const capabilityDecisions = capabilities.map((capability) =>
    Object.freeze({
      capability,
      decision: "deny" as const,
      reasonCode: "policy.unconfigured",
    }),
  );
  return Object.freeze({
    decision: "deny",
    reasonCode: "policy.unconfigured",
    capability: capabilities[0] ?? "policy",
    capabilityDecisions: Object.freeze(capabilityDecisions),
  });
}
