import { createHash, randomUUID } from "node:crypto";
import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ConversationManager } from "./conversation-manager.ts";
import { cloneData } from "./clone-data.ts";
import { cloneJsonValue, collectJsonValueIssues, type JsonObject, type JsonValue } from "./json.ts";
import { CapabilityPolicy, type ToolPolicyContext, type ToolPolicyDecision } from "./policy.ts";
import { ToolExecutionController } from "./tool-execution.ts";
import { dispatchToolCalls, ToolRegistry } from "./tool-registry.ts";

export const APPROVAL_SCHEMA_VERSION = 1 as const;

export interface ApprovalRequest {
  schemaVersion: typeof APPROVAL_SCHEMA_VERSION;
  approvalId: string;
  runId: string;
  conversationId: string;
  toolCall: ToolCall & { arguments: JsonObject };
  argumentsHash: string;
  capability: string;
  capabilities: readonly string[];
  reasonCode: string;
  requestedAt: string;
  expiresAt: string;
}

export interface SubmittedApprovalDecision {
  approvalId: string;
  decision: "approved" | "denied";
  /** Opaque signed/session-bound proof interpreted only by the authority. */
  authorization: string;
}

export interface VerifiedApprovalDecision {
  actorId: string;
  reasonCode?: string;
}

export interface ApprovalAuthority {
  verify(
    request: ApprovalRequest,
    submission: SubmittedApprovalDecision,
  ): Promise<VerifiedApprovalDecision>;
}

export interface ApprovalResolution {
  approvalId: string;
  toolCallId: string;
  decision: "approved" | "denied";
  actorId: string;
  reasonCode?: string;
}

export interface ApprovalResumeOptions {
  runId: string;
  conversationId: string;
  requests: readonly ApprovalRequest[];
  submissions: readonly SubmittedApprovalDecision[];
  authority: ApprovalAuthority;
  /** Required acknowledgement boundary for canonical approval.resolved persistence. */
  onResolved: (resolution: ApprovalResolution) => void | Promise<void>;
  registry: ToolRegistry;
  executionController: ToolExecutionController;
  policyContext: ToolPolicyContext;
  conversation: ConversationManager;
  signal?: AbortSignal;
  deadline?: number;
  now?: () => number;
}

export interface ApprovalResumeResult {
  resolutions: readonly ApprovalResolution[];
  toolResults: readonly ToolResultMessage[];
  replayed: boolean;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as JsonObject;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`).join(",")}}`;
}

export function approvalArgumentsHash(argumentsValue: JsonObject): string {
  return createHash("sha256").update(canonicalJson(argumentsValue)).digest("hex");
}

function nonEmpty(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
}

function parseTime(value: unknown, name: string): number {
  nonEmpty(value, name);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new TypeError(`${name} must be canonical RFC 3339`);
  return parsed;
}

export function parseApprovalRequest(value: unknown): ApprovalRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("approval request must be an object");
  const input = value as Record<string, unknown>;
  const allowed = new Set(["schemaVersion", "approvalId", "runId", "conversationId", "toolCall", "argumentsHash", "capability", "capabilities", "reasonCode", "requestedAt", "expiresAt"]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new TypeError(`approval request has unknown fields: ${unknown.join(", ")}`);
  if (input["schemaVersion"] !== APPROVAL_SCHEMA_VERSION) throw new TypeError("approval request schemaVersion is unsupported");
  for (const field of ["approvalId", "runId", "conversationId", "argumentsHash", "capability", "reasonCode"] as const) nonEmpty(input[field], field);
  if (!/^[a-f0-9]{64}$/.test(input["argumentsHash"] as string)) throw new TypeError("argumentsHash must be SHA-256 hex");
  if (!Array.isArray(input["capabilities"]) || input["capabilities"].length === 0 || input["capabilities"].some((item) => typeof item !== "string" || item.length === 0)) throw new TypeError("capabilities must be a non-empty string array");
  const capabilities = [...input["capabilities"] as string[]];
  if (new Set(capabilities).size !== capabilities.length || capabilities.some((item, index) => index > 0 && item < capabilities[index - 1]!)) throw new TypeError("capabilities must be unique and sorted");
  if (!capabilities.includes(input["capability"] as string)) throw new TypeError("capability must be in capabilities");
  const requestedAt = parseTime(input["requestedAt"], "requestedAt");
  const expiresAt = parseTime(input["expiresAt"], "expiresAt");
  if (expiresAt <= requestedAt) throw new TypeError("expiresAt must be after requestedAt");
  const toolCall = input["toolCall"] as Record<string, unknown>;
  if (typeof toolCall !== "object" || toolCall === null || Array.isArray(toolCall)) throw new TypeError("toolCall must be an object");
  const toolUnknown = Object.keys(toolCall).filter((key) => !new Set(["type", "id", "name", "arguments"]).has(key));
  if (toolUnknown.length > 0 || toolCall["type"] !== "toolCall") throw new TypeError("toolCall shape is invalid");
  nonEmpty(toolCall["id"], "toolCall.id");
  nonEmpty(toolCall["name"], "toolCall.name");
  const issues: string[] = [];
  collectJsonValueIssues(toolCall["arguments"], "toolCall.arguments", issues);
  if (issues.length > 0 || typeof toolCall["arguments"] !== "object" || toolCall["arguments"] === null || Array.isArray(toolCall["arguments"])) throw new TypeError(issues[0] ?? "toolCall.arguments must be a JSON object");
  const ownedArguments = cloneJsonValue(toolCall["arguments"] as JsonObject);
  if (approvalArgumentsHash(ownedArguments) !== input["argumentsHash"]) throw new TypeError("approval.changed-arguments");
  return Object.freeze({
    schemaVersion: APPROVAL_SCHEMA_VERSION,
    approvalId: input["approvalId"] as string,
    runId: input["runId"] as string,
    conversationId: input["conversationId"] as string,
    toolCall: Object.freeze({ type: "toolCall", id: toolCall["id"] as string, name: toolCall["name"] as string, arguments: Object.freeze(ownedArguments) }),
    argumentsHash: input["argumentsHash"] as string,
    capability: input["capability"] as string,
    capabilities: Object.freeze(capabilities),
    reasonCode: input["reasonCode"] as string,
    requestedAt: input["requestedAt"] as string,
    expiresAt: input["expiresAt"] as string,
  });
}

export function createApprovalRequest(input: {
  runId: string;
  conversationId: string;
  toolCall: ToolCall;
  decision: ToolPolicyDecision;
  ttlMs: number;
  now?: () => number;
  idFactory?: () => string;
}): ApprovalRequest {
  if (!Number.isFinite(input.ttlMs) || !Number.isInteger(input.ttlMs) || input.ttlMs <= 0) throw new TypeError("approval ttlMs must be a positive whole number");
  const args = cloneJsonValue((input.toolCall.arguments ?? {}) as JsonObject);
  const now = (input.now ?? Date.now)();
  if (!Number.isFinite(now)) throw new TypeError("approval now must be finite");
  return parseApprovalRequest({
    schemaVersion: APPROVAL_SCHEMA_VERSION,
    approvalId: (input.idFactory ?? randomUUID)(),
    runId: input.runId,
    conversationId: input.conversationId,
    toolCall: { ...input.toolCall, arguments: args },
    argumentsHash: approvalArgumentsHash(args),
    capability: input.decision.capability,
    capabilities: input.decision.capabilityDecisions.map((item) => item.capability),
    reasonCode: input.decision.reasonCode,
    requestedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + input.ttlMs).toISOString(),
  });
}

function deniedResult(request: ApprovalRequest): ToolResultMessage {
  return { role: "toolResult", toolCallId: request.toolCall.id, toolName: request.toolCall.name, content: [{ type: "text", text: "Approval was denied by an authorized actor (approval.denied)" }], isError: true, timestamp: Date.now() };
}

/** Process-local implementation; Phase B supplies a durable equivalent. */
export class ApprovalResumeController {
  readonly #batches = new Map<string, Promise<ApprovalResumeResult>>();

  async resume(options: ApprovalResumeOptions): Promise<ApprovalResumeResult> {
    nonEmpty(options.runId, "resume runId");
    nonEmpty(options.conversationId, "resume conversationId");
    const requests = options.requests.map(parseApprovalRequest);
    if (requests.length === 0) throw new TypeError("approval requests must not be empty");
    if (requests.some((request) => request.runId !== options.runId || request.conversationId !== options.conversationId)) {
      throw new Error("approval.resume-binding-mismatch");
    }
    const submissions = options.submissions.map((item) => ({ ...item }));
    const submissionById = new Map(submissions.map((item) => [item.approvalId, item]));
    if (submissionById.size !== submissions.length || submissions.length !== requests.length) throw new TypeError("approval submissions must match requests exactly once");
    for (const submission of submissions) {
      const unknown = Object.keys(submission).filter((field) => !new Set(["approvalId", "decision", "authorization"]).has(field));
      if (unknown.length > 0) throw new TypeError(`approval submission has unknown fields: ${unknown.join(", ")}`);
      nonEmpty(submission.approvalId, "submission.approvalId");
      nonEmpty(submission.authorization, "submission.authorization");
      if (submission.decision !== "approved" && submission.decision !== "denied") throw new TypeError("submission.decision is invalid");
    }
    if (new Set(requests.map((request) => request.toolCall.id)).size !== requests.length) {
      throw new TypeError("approval requests must have unique tool-call ids");
    }
    const batchKey = createHash("sha256")
      .update(canonicalJson(requests as unknown as JsonValue))
      .digest("hex");
    const decisionFingerprint = createHash("sha256").update(canonicalJson(submissions.map((item) => ({ approvalId: item.approvalId, decision: item.decision, authorization: item.authorization })) as unknown as JsonValue)).digest("hex");
    const key = `${batchKey}\u0000${decisionFingerprint}`;
    const existing = this.#batches.get(key);
    if (existing) {
      const result = await existing;
      return {
        resolutions: result.resolutions.map((item) => cloneData(item)),
        toolResults: result.toolResults.map((item) => cloneData(item)),
        replayed: true,
      };
    }
    if ([...this.#batches.keys()].some((item) => item.startsWith(`${batchKey}\u0000`))) throw new Error("approval.conflicting-resume");
    const execution = this.#execute(options, requests, submissionById);
    this.#batches.set(key, execution);
    execution.catch(() => this.#batches.delete(key));
    return execution;
  }

  async #execute(options: ApprovalResumeOptions, requests: ApprovalRequest[], submissions: Map<string, SubmittedApprovalDecision>): Promise<ApprovalResumeResult> {
    const now = (options.now ?? Date.now)();
    if (!Number.isFinite(now)) throw new TypeError("approval resume time must be finite");
    const resolutions: ApprovalResolution[] = [];

    // Authenticate the complete batch before acknowledging or executing any
    // individual decision. A later invalid proof must never leave an earlier
    // approved call running.
    for (const request of requests) {
      if (Date.parse(request.expiresAt) <= now) throw new Error("approval.expired");
      const submission = submissions.get(request.approvalId);
      if (!submission) throw new Error("approval.submission-missing");
      const verified = await options.authority.verify(cloneData(request), { ...submission });
      nonEmpty(verified.actorId, "verified actorId");
      const resolution: ApprovalResolution = { approvalId: request.approvalId, toolCallId: request.toolCall.id, decision: submission.decision, actorId: verified.actorId, ...(verified.reasonCode ? { reasonCode: verified.reasonCode } : {}) };
      resolutions.push(resolution);
    }

    // The canonical approval.resolved boundary is acknowledged for the whole
    // batch before a tool handler is allowed to start.
    for (const resolution of resolutions) await options.onResolved(cloneData(resolution));

    const approved = requests.filter((request) => submissions.get(request.approvalId)?.decision === "approved");
    const approvedResults = approved.length === 0 ? [] : await dispatchToolCalls(
      approved.map((request) => request.toolCall),
      options.registry,
      {
        policy: new CapabilityPolicy({ rules: approved.flatMap((request) => request.capabilities.map((capability) => ({
        deploymentId: options.policyContext.deploymentId,
        roleId: options.policyContext.roleId,
        workspaceId: options.policyContext.workspaceId,
        capability,
        argumentEquals: request.toolCall.arguments,
        decision: "allow" as const,
        reasonCode: "approval.authorized",
        }))) }),
        policyContext: options.policyContext,
        executionController: options.executionController,
        idempotencyKeys: Object.fromEntries(approved.map((request) => [request.toolCall.id, `approval:${request.approvalId}`])),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.deadline !== undefined ? { deadline: options.deadline } : {}),
      },
    );
    const approvedByCallId = new Map(approvedResults.map((result) => [result.toolCallId, result]));
    const results = requests.map((request) => {
      if (submissions.get(request.approvalId)?.decision === "denied") return deniedResult(request);
      const result = approvedByCallId.get(request.toolCall.id);
      if (!result) throw new Error("approval.dispatch-missing-result");
      return result;
    });
    options.conversation.appendAll(results);
    return Object.freeze({
      resolutions: Object.freeze(resolutions.map((item) => Object.freeze({ ...item }))),
      toolResults: Object.freeze(results.map((item) => cloneData(item))),
      replayed: false,
    });
  }
}
