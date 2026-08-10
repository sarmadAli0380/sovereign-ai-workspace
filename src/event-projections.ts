import { createHash } from "node:crypto";
import {
  parseRunEvent,
  type ApprovalRequestedPayload,
  type ApprovalResolvedPayload,
  type EventAudience,
  type EventSensitivity,
  type JsonValue,
  type RunCompletedPayload,
  type RunEvent,
  type RunEventEnvelope,
  type RunEventPayloadMap,
  type RunEventType,
  type RunStartedPayload,
  type RunUsage,
  type ToolStartedPayload,
  type TurnCompletedPayload,
  type TurnStartedPayload,
} from "./events.ts";

export interface ContentFingerprint {
  bytes: number;
  sha256: string;
}

export interface AuditMessageDeltaPayload {
  messageId: string;
  index: number;
  blockType: "text" | "thinking";
  deltaBytes: number;
  deltaHash: string;
}

export interface OperationalMessageDeltaPayload {
  messageId: string;
  index: number;
  blockType: "text" | "thinking";
  deltaBytes: number;
}

export interface AuditMessageCompletedPayload {
  messageId: string;
  role: "user" | "assistant" | "toolResult";
  provider?: string;
  model?: string;
  usage?: RunUsage;
  contentBytes: number;
  contentHash: string;
}

export type OperationalMessageCompletedPayload = Omit<
  AuditMessageCompletedPayload,
  "contentHash"
>;

export interface AuditToolRequestedPayload {
  toolCallId: string;
  toolName: string;
  argumentsBytes: number;
  argumentsHash: string;
}

export type OperationalToolRequestedPayload = Omit<
  AuditToolRequestedPayload,
  "argumentsHash"
>;

export interface ProjectedToolDecisionPayload {
  toolCallId: string;
  toolName: string;
  decision: "allow" | "deny" | "requireApproval";
  reasonCode: string;
}

export interface AuditToolCompletedPayload {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  resultBytes: number;
  resultHash: string;
}

export type OperationalToolCompletedPayload = Omit<
  AuditToolCompletedPayload,
  "resultHash"
>;

export interface ProjectedRunFailedPayload {
  code: string;
  retryable: boolean;
}

export interface ProjectedRunCancelledPayload {
  code: string;
  cancelledBy?: string;
}

export type OperationalApprovalRequestedPayload = Omit<
  ApprovalRequestedPayload,
  "argumentsHash"
>;

export interface AuditRunEventPayloadMap {
  "run.started": RunStartedPayload;
  "turn.started": TurnStartedPayload;
  "message.delta": AuditMessageDeltaPayload;
  "message.completed": AuditMessageCompletedPayload;
  "tool.requested": AuditToolRequestedPayload;
  "tool.decision": ProjectedToolDecisionPayload;
  "tool.started": ToolStartedPayload;
  "tool.completed": AuditToolCompletedPayload;
  "approval.requested": OperationalApprovalRequestedPayload;
  "approval.resolved": ApprovalResolvedPayload;
  "turn.completed": TurnCompletedPayload;
  "run.completed": RunCompletedPayload;
  "run.failed": ProjectedRunFailedPayload;
  "run.cancelled": ProjectedRunCancelledPayload;
}

export interface OperationalRunEventPayloadMap {
  "run.started": RunStartedPayload;
  "turn.started": TurnStartedPayload;
  "message.delta": OperationalMessageDeltaPayload;
  "message.completed": OperationalMessageCompletedPayload;
  "tool.requested": OperationalToolRequestedPayload;
  "tool.decision": ProjectedToolDecisionPayload;
  "tool.started": ToolStartedPayload;
  "tool.completed": OperationalToolCompletedPayload;
  "approval.requested": ApprovalRequestedPayload;
  "approval.resolved": ApprovalResolvedPayload;
  "turn.completed": TurnCompletedPayload;
  "run.completed": RunCompletedPayload;
  "run.failed": ProjectedRunFailedPayload;
  "run.cancelled": ProjectedRunCancelledPayload;
}

type AudiencePayloadMap<TAudience extends EventAudience> =
  TAudience extends "audit"
    ? AuditRunEventPayloadMap
    : TAudience extends "operational"
      ? OperationalRunEventPayloadMap
      : RunEventPayloadMap;

export type ProjectedEventType<TAudience extends EventAudience> =
  TAudience extends "audit" | "persistence"
    ? Exclude<RunEventType, "message.delta">
    : RunEventType;

export type AudienceRunEvent<TAudience extends EventAudience> = {
  [TType in ProjectedEventType<TAudience>]: AudienceRunEventOf<TAudience, TType>;
}[ProjectedEventType<TAudience>];

export type AudienceRunEventOf<
  TAudience extends EventAudience,
  TType extends RunEventType,
> = TType extends ProjectedEventType<TAudience>
  ? RunEventEnvelope<TType, AudiencePayloadMap<TAudience>[TType], TAudience>
  : never;

export type RunEventProjection<
  TAudience extends EventAudience,
  TType extends RunEventType,
> = TType extends ProjectedEventType<TAudience>
  ? AudienceRunEventOf<TAudience, TType>
  : null;

export type ProjectedRunEvent = {
  [TAudience in EventAudience]: AudienceRunEvent<TAudience>;
}[EventAudience];

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const object = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key] as JsonValue)}`)
    .join(",")}}`;
}

function fingerprintText(value: string): ContentFingerprint {
  return {
    bytes: Buffer.byteLength(value, "utf8"),
    sha256: createHash("sha256").update(value, "utf8").digest("hex"),
  };
}

export function fingerprintContent(value: JsonValue): ContentFingerprint {
  const canonical = canonicalJson(value);
  return {
    bytes: Buffer.byteLength(canonical, "utf8"),
    sha256: createHash("sha256").update(canonical).digest("hex"),
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function auditPayload(event: RunEvent): AuditRunEventPayloadMap[RunEventType] {
  switch (event.type) {
    case "run.started":
    case "turn.started":
    case "tool.started":
    case "approval.requested":
    case "approval.resolved":
    case "turn.completed":
    case "run.completed":
      return cloneJson(event.payload);
    case "message.delta": {
      const fingerprint = fingerprintText(event.payload.delta);
      return {
        messageId: event.payload.messageId,
        index: event.payload.index,
        blockType: event.payload.blockType,
        deltaBytes: fingerprint.bytes,
        deltaHash: fingerprint.sha256,
      };
    }
    case "message.completed": {
      const fingerprint = fingerprintContent(event.payload.content);
      return {
        messageId: event.payload.messageId,
        role: event.payload.role,
        ...(event.payload.provider ? { provider: event.payload.provider } : {}),
        ...(event.payload.model ? { model: event.payload.model } : {}),
        ...(event.payload.usage ? { usage: cloneJson(event.payload.usage) } : {}),
        contentBytes: fingerprint.bytes,
        contentHash: fingerprint.sha256,
      };
    }
    case "tool.requested": {
      const fingerprint = fingerprintContent(event.payload.arguments);
      return {
        toolCallId: event.payload.toolCallId,
        toolName: event.payload.toolName,
        argumentsBytes: fingerprint.bytes,
        argumentsHash: fingerprint.sha256,
      };
    }
    case "tool.decision":
      return {
        toolCallId: event.payload.toolCallId,
        toolName: event.payload.toolName,
        decision: event.payload.decision,
        reasonCode: event.payload.reasonCode,
      };
    case "tool.completed": {
      const fingerprint = fingerprintContent(event.payload.result);
      return {
        toolCallId: event.payload.toolCallId,
        toolName: event.payload.toolName,
        isError: event.payload.isError,
        resultBytes: fingerprint.bytes,
        resultHash: fingerprint.sha256,
      };
    }
    case "run.failed":
      return { code: event.payload.code, retryable: event.payload.retryable };
    case "run.cancelled":
      return {
        code: event.payload.code,
        ...(event.payload.cancelledBy ? { cancelledBy: event.payload.cancelledBy } : {}),
      };
  }
}

function operationalPayload(event: RunEvent): OperationalRunEventPayloadMap[RunEventType] {
  const audited = auditPayload(event);
  switch (event.type) {
    case "message.delta": {
      const payload = audited as AuditMessageDeltaPayload;
      const { deltaHash: _hash, ...operational } = payload;
      return operational;
    }
    case "message.completed": {
      const payload = audited as AuditMessageCompletedPayload;
      const { contentHash: _hash, ...operational } = payload;
      return operational;
    }
    case "tool.requested": {
      const payload = audited as AuditToolRequestedPayload;
      const { argumentsHash: _hash, ...operational } = payload;
      return operational;
    }
    case "tool.completed": {
      const payload = audited as AuditToolCompletedPayload;
      const { resultHash: _hash, ...operational } = payload;
      return operational;
    }
    case "approval.requested": {
      const { argumentsHash: _hash, ...operational } = event.payload;
      return cloneJson(operational);
    }
    default:
      return audited as OperationalRunEventPayloadMap[RunEventType];
  }
}

const AUDIT_DERIVED_TYPES = new Set<RunEventType>([
  "message.delta",
  "message.completed",
  "tool.requested",
  "tool.completed",
  "approval.requested",
]);

function projectedSensitivity(
  event: RunEvent,
  audience: EventAudience,
): EventSensitivity {
  if (audience === "operational") return "metadata";
  if (audience === "audit") return AUDIT_DERIVED_TYPES.has(event.type) ? "derived-content" : "metadata";
  return event.sensitivity;
}

function projectedEnvelope<TAudience extends EventAudience>(
  event: RunEvent,
  audience: TAudience,
  payload: AudiencePayloadMap<TAudience>[RunEventType],
): AudienceRunEvent<TAudience> {
  const { payload: _payload, extensions, ...envelope } = event;
  return {
    ...envelope,
    audience,
    sensitivity: projectedSensitivity(event, audience),
    payload,
    ...((audience === "ui" || audience === "persistence") && extensions
      ? { extensions: cloneJson(extensions) }
      : {}),
  } as unknown as AudienceRunEvent<TAudience>;
}

/**
 * Produce a representation for one explicit audience.
 *
 * Audit and operational payloads are selected field-by-field. They never
 * inherit arbitrary payload fields or envelope extensions, so adding a new
 * content field cannot accidentally make it into logs through object spread.
 */
export function projectRunEvent<
  TType extends RunEventType,
  TAudience extends EventAudience,
>(
  input: RunEventEnvelope<TType, RunEventPayloadMap[TType]>,
  audience: TAudience,
): RunEventProjection<TAudience, TType> {
  const event = parseRunEvent(input);
  if (
    event.type === "message.delta" &&
    (audience === "audit" || audience === "persistence")
  ) {
    return null as RunEventProjection<TAudience, TType>;
  }
  if (audience === "audit") {
    return projectedEnvelope(
      event,
      audience,
      auditPayload(event) as AudiencePayloadMap<TAudience>[RunEventType],
    ) as RunEventProjection<TAudience, TType>;
  }
  if (audience === "operational") {
    return projectedEnvelope(
      event,
      audience,
      operationalPayload(event) as AudiencePayloadMap<TAudience>[RunEventType],
    ) as RunEventProjection<TAudience, TType>;
  }
  return projectedEnvelope(
    event,
    audience,
    cloneJson(event.payload) as AudiencePayloadMap<TAudience>[RunEventType],
  ) as RunEventProjection<TAudience, TType>;
}
