/**
 * Product-owned run events shared by the runtime, UI, persistence, and audit
 * layers. This protocol deliberately does not depend on a provider message
 * type: provider messages are mapped into it at the boundary.
 */

import type { JsonObject, JsonPrimitive, JsonValue } from "./json.ts";
import { collectProductMessageIssues } from "./messages/codec.ts";
import type { ProductMessageEnvelope } from "./messages/envelope.ts";

export type { JsonObject, JsonPrimitive, JsonValue } from "./json.ts";

export const RUN_EVENT_SCHEMA_VERSION = 1 as const;

export type EventAudience = "ui" | "persistence" | "audit" | "operational";
export type FullEventAudience = "ui" | "persistence";
export type EventSensitivity = "content" | "derived-content" | "metadata";

export interface RunUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

export interface RunBudgetUsage {
  tokens: number;
  source: "anchored" | "estimated";
}

export interface RunStartedPayload {
  configKey: string;
  provider: string;
  model: string;
}

export interface TurnStartedPayload {
  inputMessageId?: string;
}

export interface MessageDeltaPayload {
  messageId: string;
  index: number;
  blockType: "text" | "thinking";
  delta: string;
}

export interface MessageCompletedPayload {
  message: ProductMessageEnvelope;
}

export interface ToolRequestedPayload {
  toolCallId: string;
  toolName: string;
  arguments: JsonObject;
}

export interface ToolDecisionPayload {
  toolCallId: string;
  toolName: string;
  /** Capability which determined the aggregate decision. */
  capability: string;
  /** Complete, sorted declaration evaluated for this call. */
  capabilities: readonly string[];
  decision: "allow" | "deny" | "requireApproval";
  reasonCode: string;
  detail?: string;
}

export interface ToolStartedPayload {
  toolCallId: string;
  toolName: string;
}

export interface ToolCompletedPayload {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  result: JsonValue;
}

export interface ApprovalRequestedPayload {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  capability: string;
  argumentsHash: string;
  expiresAt: string;
}

export interface ApprovalResolvedPayload {
  approvalId: string;
  toolCallId: string;
  decision: "approved" | "denied";
  actorId?: string;
  reasonCode?: string;
}

export interface TurnCompletedPayload {
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  usage?: RunUsage;
  budget: RunBudgetUsage;
}

export interface RunCompletedPayload {
  reason: "stop" | "maxTurns" | "needsApproval";
  usage?: RunUsage;
}

export interface RunFailedPayload {
  code: string;
  retryable: boolean;
  detail?: string;
}

export interface RunCancelledPayload {
  code: string;
  cancelledBy?: string;
  detail?: string;
}

export interface RunEventPayloadMap {
  "run.started": RunStartedPayload;
  "turn.started": TurnStartedPayload;
  "message.delta": MessageDeltaPayload;
  "message.completed": MessageCompletedPayload;
  "tool.requested": ToolRequestedPayload;
  "tool.decision": ToolDecisionPayload;
  "tool.started": ToolStartedPayload;
  "tool.completed": ToolCompletedPayload;
  "approval.requested": ApprovalRequestedPayload;
  "approval.resolved": ApprovalResolvedPayload;
  "turn.completed": TurnCompletedPayload;
  "run.completed": RunCompletedPayload;
  "run.failed": RunFailedPayload;
  "run.cancelled": RunCancelledPayload;
}

export type RunEventType = keyof RunEventPayloadMap;

export interface RunEventEnvelope<
  TType extends RunEventType,
  TPayload,
  TAudience extends EventAudience = FullEventAudience,
> {
  schemaVersion: typeof RUN_EVENT_SCHEMA_VERSION;
  eventId: string;
  runId: string;
  conversationId: string;
  sequence: number;
  turn: number;
  occurredAt: string;
  type: TType;
  causationId: string;
  correlationId?: string;
  audience: TAudience;
  sensitivity: EventSensitivity;
  payload: TPayload;
  /** The only forward-compatible location in a version-1 envelope. */
  extensions?: JsonObject;
}

export type CanonicalAudienceFor<TType extends RunEventType> =
  TType extends "message.delta" ? "ui" : FullEventAudience;

export type RunEventOf<TType extends RunEventType> = RunEventEnvelope<
  TType,
  RunEventPayloadMap[TType],
  CanonicalAudienceFor<TType>
>;

export type RunEvent = {
  [TType in RunEventType]: RunEventOf<TType>;
}[RunEventType];

export const RUN_EVENT_TYPES = [
  "run.started",
  "turn.started",
  "message.delta",
  "message.completed",
  "tool.requested",
  "tool.decision",
  "tool.started",
  "tool.completed",
  "approval.requested",
  "approval.resolved",
  "turn.completed",
  "run.completed",
  "run.failed",
  "run.cancelled",
] as const satisfies readonly RunEventType[];

export const TERMINAL_RUN_EVENT_TYPES = [
  "run.completed",
  "run.failed",
  "run.cancelled",
] as const satisfies readonly RunEventType[];

const EVENT_TYPE_SET = new Set<string>(RUN_EVENT_TYPES);
const TERMINAL_TYPE_SET = new Set<string>(TERMINAL_RUN_EVENT_TYPES);
const FULL_AUDIENCES = new Set<string>(["ui", "persistence"]);
const SENSITIVITIES = new Set<string>(["content", "derived-content", "metadata"]);

export const RUN_EVENT_SENSITIVITY = {
  "run.started": "metadata",
  "turn.started": "metadata",
  "message.delta": "content",
  "message.completed": "content",
  "tool.requested": "content",
  "tool.decision": "content",
  "tool.started": "metadata",
  "tool.completed": "content",
  "approval.requested": "derived-content",
  "approval.resolved": "metadata",
  "turn.completed": "metadata",
  "run.completed": "metadata",
  "run.failed": "content",
  "run.cancelled": "content",
} as const satisfies Record<RunEventType, EventSensitivity>;

export class RunEventValidationError extends TypeError {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid RunEvent:\n- ${issues.join("\n- ")}`);
    this.name = "RunEventValidationError";
    this.issues = [...issues];
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isWholeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    ISO_TIMESTAMP.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function checkUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: string[],
): void {
  const known = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) issues.push(`${path}.${key}: unknown field`);
  }
}

function requireString(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[],
): void {
  if (!isNonEmptyString(value[key])) issues.push(`${path}.${key}: must be a non-empty string`);
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: string[],
): void {
  if (value[key] !== undefined && !isNonEmptyString(value[key])) {
    issues.push(`${path}.${key}: must be a non-empty string when present`);
  }
}

function collectJsonIssues(value: unknown, path: string, issues: string[], seen: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) issues.push(`${path}: JSON numbers must be finite`);
    return;
  }
  if (typeof value !== "object") {
    issues.push(`${path}: must contain only JSON values`);
    return;
  }
  if (seen.has(value)) {
    issues.push(`${path}: circular references are not JSON serializable`);
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) issues.push(`${path}[${index}]: sparse arrays are not canonical JSON`);
      else collectJsonIssues(value[index], `${path}[${index}]`, issues, seen);
    }
    const extraKeys = Object.keys(value).filter((key) => !/^\d+$/.test(key));
    if (extraKeys.length > 0) issues.push(`${path}: arrays cannot have named fields`);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      issues.push(`${path}: must be a plain JSON object`);
      seen.delete(value);
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      collectJsonIssues(item, `${path}.${key}`, issues, seen);
    }
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    issues.push(`${path}: symbol-keyed fields are not JSON serializable`);
  }
  seen.delete(value);
}

function validateUsage(value: unknown, path: string, issues: string[]): void {
  if (!isObject(value)) {
    issues.push(`${path}: must be an object`);
    return;
  }
  const fields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
  checkUnknownKeys(value, fields, path, issues);
  for (const field of fields) {
    if (!isWholeNumber(value[field]) || (value[field] as number) < 0) {
      issues.push(`${path}.${field}: must be a non-negative whole number`);
    }
  }
}

function validatePayload(type: RunEventType, value: unknown, issues: string[]): void {
  const path = "payload";
  if (!isObject(value)) {
    issues.push(`${path}: must be an object`);
    return;
  }

  switch (type) {
    case "run.started":
      checkUnknownKeys(value, ["configKey", "provider", "model"], path, issues);
      for (const key of ["configKey", "provider", "model"]) requireString(value, key, path, issues);
      break;
    case "turn.started":
      checkUnknownKeys(value, ["inputMessageId"], path, issues);
      optionalString(value, "inputMessageId", path, issues);
      break;
    case "message.delta":
      checkUnknownKeys(value, ["messageId", "index", "blockType", "delta"], path, issues);
      requireString(value, "messageId", path, issues);
      if (!isWholeNumber(value["index"]) || (value["index"] as number) < 0) {
        issues.push(`${path}.index: must be a non-negative whole number`);
      }
      if (value["blockType"] !== "text" && value["blockType"] !== "thinking") {
        issues.push(`${path}.blockType: must be "text" or "thinking"`);
      }
      if (typeof value["delta"] !== "string") issues.push(`${path}.delta: must be a string`);
      break;
    case "message.completed":
      checkUnknownKeys(value, ["message"], path, issues);
      if (!("message" in value)) issues.push(`${path}.message: is required`);
      else {
        for (const issue of collectProductMessageIssues(value["message"])) {
          const suffix = issue.startsWith("message") ? issue.slice("message".length) : `.${issue}`;
          issues.push(`${path}.message${suffix}`);
        }
      }
      break;
    case "tool.requested":
      checkUnknownKeys(value, ["toolCallId", "toolName", "arguments"], path, issues);
      requireString(value, "toolCallId", path, issues);
      requireString(value, "toolName", path, issues);
      if (!isObject(value["arguments"])) issues.push(`${path}.arguments: must be an object`);
      else collectJsonIssues(value["arguments"], `${path}.arguments`, issues, new Set());
      break;
    case "tool.decision":
      checkUnknownKeys(
        value,
        ["toolCallId", "toolName", "capability", "capabilities", "decision", "reasonCode", "detail"],
        path,
        issues,
      );
      requireString(value, "toolCallId", path, issues);
      requireString(value, "toolName", path, issues);
      requireString(value, "capability", path, issues);
      if (!Array.isArray(value["capabilities"]) || value["capabilities"].length === 0) {
        issues.push(`${path}.capabilities: must be a non-empty array`);
      } else {
        const capabilities = value["capabilities"];
        for (let index = 0; index < capabilities.length; index += 1) {
          if (typeof capabilities[index] !== "string" || capabilities[index].length === 0) {
            issues.push(`${path}.capabilities[${index}]: must be a non-empty string`);
          }
        }
        if (new Set(capabilities).size !== capabilities.length) {
          issues.push(`${path}.capabilities: must not contain duplicates`);
        }
        if (capabilities.some((capability, index) => index > 0 && capability < capabilities[index - 1])) {
          issues.push(`${path}.capabilities: must be sorted`);
        }
        if (
          typeof value["capability"] === "string" &&
          !capabilities.includes(value["capability"])
        ) {
          issues.push(`${path}.capability: must be present in capabilities`);
        }
      }
      if (!new Set(["allow", "deny", "requireApproval"]).has(String(value["decision"]))) {
        issues.push(`${path}.decision: must be allow, deny, or requireApproval`);
      }
      requireString(value, "reasonCode", path, issues);
      optionalString(value, "detail", path, issues);
      break;
    case "tool.started":
      checkUnknownKeys(value, ["toolCallId", "toolName"], path, issues);
      requireString(value, "toolCallId", path, issues);
      requireString(value, "toolName", path, issues);
      break;
    case "tool.completed":
      checkUnknownKeys(value, ["toolCallId", "toolName", "isError", "result"], path, issues);
      requireString(value, "toolCallId", path, issues);
      requireString(value, "toolName", path, issues);
      if (typeof value["isError"] !== "boolean") issues.push(`${path}.isError: must be a boolean`);
      if (!("result" in value)) issues.push(`${path}.result: is required`);
      else collectJsonIssues(value["result"], `${path}.result`, issues, new Set());
      break;
    case "approval.requested":
      checkUnknownKeys(
        value,
        ["approvalId", "toolCallId", "toolName", "capability", "argumentsHash", "expiresAt"],
        path,
        issues,
      );
      for (const key of [
        "approvalId",
        "toolCallId",
        "toolName",
        "capability",
        "argumentsHash",
        "expiresAt",
      ]) {
        requireString(value, key, path, issues);
      }
      if (
        typeof value["argumentsHash"] === "string" &&
        !/^[a-f0-9]{64}$/.test(value["argumentsHash"])
      ) {
        issues.push(`${path}.argumentsHash: must be a lowercase SHA-256 hex digest`);
      }
      if (typeof value["expiresAt"] === "string" && !isTimestamp(value["expiresAt"])) {
        issues.push(`${path}.expiresAt: must be an RFC 3339 timestamp`);
      }
      break;
    case "approval.resolved":
      checkUnknownKeys(
        value,
        ["approvalId", "toolCallId", "decision", "actorId", "reasonCode"],
        path,
        issues,
      );
      requireString(value, "approvalId", path, issues);
      requireString(value, "toolCallId", path, issues);
      if (value["decision"] !== "approved" && value["decision"] !== "denied") {
        issues.push(`${path}.decision: must be approved or denied`);
      }
      optionalString(value, "actorId", path, issues);
      optionalString(value, "reasonCode", path, issues);
      break;
    case "turn.completed":
      checkUnknownKeys(value, ["stopReason", "usage", "budget"], path, issues);
      if (!new Set(["stop", "length", "toolUse", "error", "aborted"]).has(String(value["stopReason"]))) {
        issues.push(`${path}.stopReason: is missing or unknown`);
      }
      if (value["usage"] !== undefined) validateUsage(value["usage"], `${path}.usage`, issues);
      if (!isObject(value["budget"])) {
        issues.push(`${path}.budget: must be an object`);
      } else {
        checkUnknownKeys(value["budget"], ["tokens", "source"], `${path}.budget`, issues);
        if (!isWholeNumber(value["budget"]["tokens"]) || (value["budget"]["tokens"] as number) < 0) {
          issues.push(`${path}.budget.tokens: must be a non-negative whole number`);
        }
        if (value["budget"]["source"] !== "anchored" && value["budget"]["source"] !== "estimated") {
          issues.push(`${path}.budget.source: must be anchored or estimated`);
        }
      }
      break;
    case "run.completed":
      checkUnknownKeys(value, ["reason", "usage"], path, issues);
      if (
        value["reason"] !== "stop" &&
        value["reason"] !== "maxTurns" &&
        value["reason"] !== "needsApproval"
      ) {
        issues.push(`${path}.reason: must be stop, maxTurns, or needsApproval`);
      }
      if (value["usage"] !== undefined) validateUsage(value["usage"], `${path}.usage`, issues);
      break;
    case "run.failed":
      checkUnknownKeys(value, ["code", "retryable", "detail"], path, issues);
      requireString(value, "code", path, issues);
      if (typeof value["retryable"] !== "boolean") {
        issues.push(`${path}.retryable: must be a boolean`);
      }
      optionalString(value, "detail", path, issues);
      break;
    case "run.cancelled":
      checkUnknownKeys(value, ["code", "cancelledBy", "detail"], path, issues);
      requireString(value, "code", path, issues);
      optionalString(value, "cancelledBy", path, issues);
      optionalString(value, "detail", path, issues);
      break;
  }
}

/** Validate an untrusted canonical UI/persistence event before projection. */
export function collectRunEventIssues(value: unknown): string[] {
  const issues: string[] = [];
  if (!isObject(value)) return ["event: must be an object"];

  checkUnknownKeys(
    value,
    [
      "schemaVersion",
      "eventId",
      "runId",
      "conversationId",
      "sequence",
      "turn",
      "occurredAt",
      "type",
      "causationId",
      "correlationId",
      "audience",
      "sensitivity",
      "payload",
      "extensions",
    ],
    "event",
    issues,
  );

  if (value["schemaVersion"] !== RUN_EVENT_SCHEMA_VERSION) {
    issues.push(
      `event.schemaVersion: unsupported version ${String(value["schemaVersion"])}; supported version is ${RUN_EVENT_SCHEMA_VERSION}`,
    );
  }
  for (const key of ["eventId", "runId", "conversationId", "occurredAt", "causationId"]) {
    requireString(value, key, "event", issues);
  }
  optionalString(value, "correlationId", "event", issues);
  for (const key of ["sequence", "turn"]) {
    if (!isWholeNumber(value[key]) || (value[key] as number) < 0) {
      issues.push(`event.${key}: must be a non-negative whole number`);
    }
  }
  if (typeof value["occurredAt"] === "string" && !isTimestamp(value["occurredAt"])) {
    issues.push("event.occurredAt: must be an RFC 3339 timestamp");
  }
  if (!EVENT_TYPE_SET.has(String(value["type"]))) {
    issues.push(`event.type: unknown event type ${JSON.stringify(value["type"])}`);
  }
  if (!FULL_AUDIENCES.has(String(value["audience"]))) {
    issues.push(
      `event.audience: a canonical content event must target ui or persistence; use projectRunEvent for ${JSON.stringify(value["audience"])}`,
    );
  }
  if (value["type"] === "message.delta" && value["audience"] !== "ui") {
    issues.push("event.audience: message.delta is ephemeral and may target only ui");
  }
  if (!SENSITIVITIES.has(String(value["sensitivity"]))) {
    issues.push(`event.sensitivity: unknown sensitivity ${JSON.stringify(value["sensitivity"])}`);
  }

  if (EVENT_TYPE_SET.has(String(value["type"]))) {
    const type = value["type"] as RunEventType;
    if (value["sensitivity"] !== RUN_EVENT_SENSITIVITY[type]) {
      issues.push(
        `event.sensitivity: ${type} must be classified as ${RUN_EVENT_SENSITIVITY[type]}`,
      );
    }
    validatePayload(type, value["payload"], issues);
  }

  if (value["extensions"] !== undefined) {
    if (!isObject(value["extensions"])) issues.push("event.extensions: must be an object");
    else collectJsonIssues(value["extensions"], "event.extensions", issues, new Set());
  }
  return issues;
}

export function parseRunEvent(value: unknown): RunEvent {
  const issues = collectRunEventIssues(value);
  if (issues.length > 0) throw new RunEventValidationError(issues);
  return value as RunEvent;
}

export interface RunEventSequenceOptions {
  /** Require a complete run: run.started first and exactly one terminal event last. */
  complete?: boolean;
}

/**
 * Validate invariants that cannot be checked on one event in isolation.
 * Gaps are allowed because audience projections may omit future event types;
 * sequence values only need to be unique and strictly increasing.
 */
export function collectRunEventSequenceIssues(
  events: readonly RunEvent[],
  options: RunEventSequenceOptions = {},
): string[] {
  const issues: string[] = [];
  if (events.length === 0) {
    if (options.complete) issues.push("sequence: a complete run cannot be empty");
    return issues;
  }

  const first = events[0] as RunEvent;
  const eventIds = new Set<string>();
  let previousSequence = -1;
  let previousTurn = -1;
  let runStartedCount = 0;
  let terminalCount = 0;
  let eventAfterTerminal = false;

  events.forEach((event, index) => {
    for (const issue of collectRunEventIssues(event)) {
      issues.push(`event[${index}].${issue}`);
    }
    if (event.runId !== first.runId) issues.push(`event[${index}]: runId changed within the run`);
    if (event.conversationId !== first.conversationId) {
      issues.push(`event[${index}]: conversationId changed within the run`);
    }
    if (eventIds.has(event.eventId)) issues.push(`event[${index}]: duplicate eventId ${event.eventId}`);
    eventIds.add(event.eventId);
    if (event.sequence <= previousSequence) {
      issues.push(`event[${index}]: sequence must be unique and strictly increasing`);
    }
    if (event.turn < previousTurn) issues.push(`event[${index}]: turn cannot move backwards`);
    previousSequence = event.sequence;
    previousTurn = event.turn;

    if (event.type === "run.started") runStartedCount += 1;
    if (terminalCount > 0) eventAfterTerminal = true;
    if (TERMINAL_TYPE_SET.has(event.type)) {
      terminalCount += 1;
    }
  });

  if (terminalCount > 1) issues.push("sequence: a run cannot contain more than one terminal event");
  if (eventAfterTerminal) {
    issues.push("sequence: no event may follow a terminal event");
  }
  if (options.complete) {
    if (first.type !== "run.started") issues.push("sequence: a complete run must start with run.started");
    if (runStartedCount !== 1) issues.push("sequence: a complete run must contain exactly one run.started event");
    if (terminalCount !== 1) issues.push("sequence: a complete run must contain exactly one terminal event");
  }
  return issues;
}

export function assertRunEventSequence(
  events: readonly RunEvent[],
  options: RunEventSequenceOptions = {},
): void {
  const issues = collectRunEventSequenceIssues(events, options);
  if (issues.length > 0) throw new RunEventValidationError(issues);
}

export function isTerminalRunEvent(event: RunEvent): boolean {
  return TERMINAL_TYPE_SET.has(event.type);
}
