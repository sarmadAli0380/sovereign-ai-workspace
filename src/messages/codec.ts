import type {
  AssistantMessage,
  AssistantMessageDiagnostic,
  Message,
  ToolResultMessage,
  UserMessage,
  Usage,
} from "@earendil-works/pi-ai";
import {
  cloneJsonValue,
  collectJsonValueIssues,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "../json.ts";
import {
  PRODUCT_MESSAGE_SCHEMA_VERSION,
  type ProductAssistantStopReason,
  type ProductAssistantPersistenceOutcome,
  type ProductCostUsd,
  type ProductDiagnostic,
  type ProductMessageBlock,
  type ProductMessageEnvelope,
  type ProductMessageExtensions,
  type ProductMessageUsage,
  type ProductProviderExtensionBlock,
  type ProductProviderMetadata,
  type ProductRunTermination,
} from "./envelope.ts";

const MESSAGE_ROLES = new Set(["user", "assistant", "toolResult"]);
const ASSISTANT_STOP_REASONS = new Set(["stop", "length", "toolUse"]);
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export class ProductMessageValidationError extends TypeError {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid ProductMessageEnvelope:\n- ${issues.join("\n- ")}`);
    this.name = "ProductMessageValidationError";
    this.issues = [...issues];
  }
}

export class ProductMessageMappingError extends TypeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProductMessageMappingError";
  }
}

export class ProductRunTerminationValidationError extends TypeError {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid ProductRunTermination:\n- ${issues.join("\n- ")}`);
    this.name = "ProductRunTerminationValidationError";
    this.issues = [...issues];
  }
}

export interface RuntimeMessageMappingOptions {
  messageId: string;
  configKey?: string;
  /** Explicit provider extensions only; no raw payload is captured implicitly. */
  providerBlocks?: readonly ProductProviderExtensionBlock[];
}

export interface RuntimeAssistantOutcomeOptions extends RuntimeMessageMappingOptions {
  failedCode?: string;
  cancelledCode?: string;
  retryable?: boolean;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    ISO_TIMESTAMP.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isWholeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
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

function validateTokenCount(
  value: unknown,
  path: string,
  issues: string[],
): void {
  if (!isWholeNumber(value) || value < 0) {
    issues.push(`${path}: must be a non-negative whole number`);
  }
}

function validateCost(value: unknown, path: string, issues: string[]): void {
  if (!isJsonObject(value)) {
    issues.push(`${path}: must be an object`);
    return;
  }
  const fields = ["input", "output", "cacheRead", "cacheWrite", "total"];
  checkUnknownKeys(value, fields, path, issues);
  for (const field of fields) {
    const item = value[field];
    if (typeof item !== "number" || !Number.isFinite(item) || item < 0) {
      issues.push(`${path}.${field}: must be a finite non-negative number`);
    }
  }
}

function validateUsage(value: unknown, path: string, issues: string[]): void {
  if (!isJsonObject(value)) {
    issues.push(`${path}: must be an object`);
    return;
  }
  const fields = [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "cacheWrite1hTokens",
    "reasoningTokens",
    "totalTokens",
    "costUsd",
  ];
  checkUnknownKeys(value, fields, path, issues);
  for (const field of [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "totalTokens",
  ]) {
    validateTokenCount(value[field], `${path}.${field}`, issues);
  }
  for (const field of ["cacheWrite1hTokens", "reasoningTokens"]) {
    if (value[field] !== undefined) validateTokenCount(value[field], `${path}.${field}`, issues);
  }
  if (
    isWholeNumber(value["cacheWrite1hTokens"]) &&
    isWholeNumber(value["cacheWriteTokens"]) &&
    value["cacheWrite1hTokens"] > value["cacheWriteTokens"]
  ) {
    issues.push(`${path}.cacheWrite1hTokens: cannot exceed cacheWriteTokens`);
  }
  if (
    isWholeNumber(value["reasoningTokens"]) &&
    isWholeNumber(value["outputTokens"]) &&
    value["reasoningTokens"] > value["outputTokens"]
  ) {
    issues.push(`${path}.reasoningTokens: cannot exceed outputTokens`);
  }
  validateCost(value["costUsd"], `${path}.costUsd`, issues);
}

function validateDiagnosticError(value: unknown, path: string, issues: string[]): void {
  if (!isJsonObject(value)) {
    issues.push(`${path}: must be an object`);
    return;
  }
  checkUnknownKeys(value, ["name", "message", "stack", "code"], path, issues);
  optionalString(value, "name", path, issues);
  requireString(value, "message", path, issues);
  optionalString(value, "stack", path, issues);
  if (
    value["code"] !== undefined &&
    !isNonEmptyString(value["code"]) &&
    !(typeof value["code"] === "number" && Number.isFinite(value["code"]))
  ) {
    issues.push(`${path}.code: must be a non-empty string or finite number when present`);
  }
}

function validateDiagnostic(value: unknown, path: string, issues: string[]): void {
  if (!isJsonObject(value)) {
    issues.push(`${path}: must be an object`);
    return;
  }
  checkUnknownKeys(value, ["type", "occurredAt", "error", "details"], path, issues);
  requireString(value, "type", path, issues);
  if (!isTimestamp(value["occurredAt"])) {
    issues.push(`${path}.occurredAt: must be an RFC 3339 timestamp`);
  }
  if (value["error"] !== undefined) validateDiagnosticError(value["error"], `${path}.error`, issues);
  if (value["details"] !== undefined) {
    if (!isJsonObject(value["details"])) issues.push(`${path}.details: must be an object`);
    else collectJsonValueIssues(value["details"], `${path}.details`, issues);
  }
}

function validateProvider(value: unknown, path: string, issues: string[]): void {
  if (!isJsonObject(value)) {
    issues.push(`${path}: must be an object`);
    return;
  }
  checkUnknownKeys(
    value,
    ["api", "provider", "model", "configKey", "responseModel", "responseId", "diagnostics"],
    path,
    issues,
  );
  for (const key of ["api", "provider", "model"]) requireString(value, key, path, issues);
  for (const key of ["configKey", "responseModel", "responseId"]) {
    optionalString(value, key, path, issues);
  }
  if (value["diagnostics"] !== undefined) {
    if (!Array.isArray(value["diagnostics"])) issues.push(`${path}.diagnostics: must be an array`);
    else {
      value["diagnostics"].forEach((item, index) =>
        validateDiagnostic(item, `${path}.diagnostics[${index}]`, issues),
      );
    }
  }
}

function validateBlock(value: unknown, path: string, issues: string[]): void {
  if (!isJsonObject(value)) {
    issues.push(`${path}: must be an object`);
    return;
  }
  switch (value["type"]) {
    case "text":
      checkUnknownKeys(value, ["type", "text", "signature"], path, issues);
      if (typeof value["text"] !== "string") issues.push(`${path}.text: must be a string`);
      optionalString(value, "signature", path, issues);
      break;
    case "thinking":
      checkUnknownKeys(value, ["type", "text", "signature", "redacted"], path, issues);
      if (typeof value["text"] !== "string") issues.push(`${path}.text: must be a string`);
      optionalString(value, "signature", path, issues);
      if (value["redacted"] !== undefined && typeof value["redacted"] !== "boolean") {
        issues.push(`${path}.redacted: must be a boolean when present`);
      }
      break;
    case "image":
      checkUnknownKeys(value, ["type", "data", "mimeType"], path, issues);
      requireString(value, "data", path, issues);
      requireString(value, "mimeType", path, issues);
      break;
    case "toolCall":
      checkUnknownKeys(
        value,
        ["type", "toolCallId", "toolName", "arguments", "thoughtSignature"],
        path,
        issues,
      );
      requireString(value, "toolCallId", path, issues);
      requireString(value, "toolName", path, issues);
      if (!isJsonObject(value["arguments"])) issues.push(`${path}.arguments: must be an object`);
      else collectJsonValueIssues(value["arguments"], `${path}.arguments`, issues);
      optionalString(value, "thoughtSignature", path, issues);
      break;
    default:
      issues.push(`${path}.type: unknown message block ${JSON.stringify(value["type"])}`);
  }
}

function validateAssistant(value: unknown, path: string, issues: string[]): void {
  if (!isJsonObject(value)) {
    issues.push(`${path}: must be an object`);
    return;
  }
  checkUnknownKeys(value, ["stopReason", "diagnosticMessage"], path, issues);
  if (!ASSISTANT_STOP_REASONS.has(String(value["stopReason"]))) {
    issues.push(`${path}.stopReason: must be stop, length, or toolUse`);
  }
  optionalString(value, "diagnosticMessage", path, issues);
}

function validateToolResult(value: unknown, path: string, issues: string[]): void {
  if (!isJsonObject(value)) {
    issues.push(`${path}: must be an object`);
    return;
  }
  checkUnknownKeys(
    value,
    ["toolCallId", "toolName", "isError", "details", "addedToolNames"],
    path,
    issues,
  );
  requireString(value, "toolCallId", path, issues);
  requireString(value, "toolName", path, issues);
  if (typeof value["isError"] !== "boolean") issues.push(`${path}.isError: must be a boolean`);
  if (value["details"] !== undefined) {
    collectJsonValueIssues(value["details"], `${path}.details`, issues);
  }
  if (value["addedToolNames"] !== undefined) {
    if (!Array.isArray(value["addedToolNames"])) {
      issues.push(`${path}.addedToolNames: must be an array`);
    } else {
      value["addedToolNames"].forEach((item, index) => {
        if (!isNonEmptyString(item)) {
          issues.push(`${path}.addedToolNames[${index}]: must be a non-empty string`);
        }
      });
    }
  }
}

function validateExtensions(value: unknown, path: string, issues: string[]): void {
  if (!isJsonObject(value)) {
    issues.push(`${path}: must be an object`);
    return;
  }
  checkUnknownKeys(value, ["providerBlocks"], path, issues);
  if (!Array.isArray(value["providerBlocks"])) {
    issues.push(`${path}.providerBlocks: must be an array`);
    return;
  }
  value["providerBlocks"].forEach((item, index) => {
    const itemPath = `${path}.providerBlocks[${index}]`;
    if (!isJsonObject(item)) {
      issues.push(`${itemPath}: must be an object`);
      return;
    }
    checkUnknownKeys(item, ["provider", "kind", "data"], itemPath, issues);
    requireString(item, "provider", itemPath, issues);
    requireString(item, "kind", itemPath, issues);
    if (!isJsonObject(item["data"])) issues.push(`${itemPath}.data: must be an object`);
    else collectJsonValueIssues(item["data"], `${itemPath}.data`, issues);
  });
}

export function collectProductMessageIssues(value: unknown): string[] {
  const issues: string[] = [];
  if (!isJsonObject(value)) return ["message: must be an object"];
  checkUnknownKeys(
    value,
    [
      "schemaVersion",
      "messageId",
      "role",
      "createdAt",
      "content",
      "provider",
      "assistant",
      "toolResult",
      "usage",
      "extensions",
    ],
    "message",
    issues,
  );
  if (value["schemaVersion"] !== PRODUCT_MESSAGE_SCHEMA_VERSION) {
    issues.push(
      `message.schemaVersion: unsupported version ${String(value["schemaVersion"])}; ` +
        `supported version is ${PRODUCT_MESSAGE_SCHEMA_VERSION}`,
    );
  }
  requireString(value, "messageId", "message", issues);
  if (!MESSAGE_ROLES.has(String(value["role"]))) issues.push("message.role: is missing or unknown");
  if (!isTimestamp(value["createdAt"])) {
    issues.push("message.createdAt: must be an RFC 3339 timestamp");
  }
  if (!Array.isArray(value["content"])) issues.push("message.content: must be an array");
  else value["content"].forEach((item, index) => validateBlock(item, `message.content[${index}]`, issues));
  if (value["provider"] !== undefined) validateProvider(value["provider"], "message.provider", issues);
  if (value["assistant"] !== undefined) validateAssistant(value["assistant"], "message.assistant", issues);
  if (value["toolResult"] !== undefined) validateToolResult(value["toolResult"], "message.toolResult", issues);
  if (value["usage"] !== undefined) validateUsage(value["usage"], "message.usage", issues);
  if (value["extensions"] !== undefined) validateExtensions(value["extensions"], "message.extensions", issues);

  if (value["role"] === "user") {
    for (const field of ["provider", "assistant", "toolResult", "usage"]) {
      if (value[field] !== undefined) issues.push(`message.${field}: is not allowed for role user`);
    }
  } else if (value["role"] === "assistant") {
    for (const field of ["provider", "assistant", "usage"]) {
      if (value[field] === undefined) issues.push(`message.${field}: is required for role assistant`);
    }
    if (value["toolResult"] !== undefined) {
      issues.push("message.toolResult: is not allowed for role assistant");
    }
  } else if (value["role"] === "toolResult") {
    if (value["toolResult"] === undefined) {
      issues.push("message.toolResult: is required for role toolResult");
    }
    for (const field of ["provider", "assistant"]) {
      if (value[field] !== undefined) issues.push(`message.${field}: is not allowed for role toolResult`);
    }
  }

  if (Array.isArray(value["content"]) && MESSAGE_ROLES.has(String(value["role"]))) {
    const allowed =
      value["role"] === "assistant"
        ? new Set(["text", "thinking", "toolCall"])
        : new Set(["text", "image"]);
    value["content"].forEach((block, index) => {
      if (isJsonObject(block) && typeof block["type"] === "string" && !allowed.has(block["type"])) {
        issues.push(`message.content[${index}].type: ${block["type"]} is not allowed for role ${value["role"]}`);
      }
    });
  }
  return issues;
}

export function parseProductMessageEnvelope(value: unknown): ProductMessageEnvelope {
  const issues = collectProductMessageIssues(value);
  if (issues.length > 0) throw new ProductMessageValidationError(issues);
  return cloneJsonValue(value as ProductMessageEnvelope & JsonValue);
}

export function encodeProductMessageEnvelope(message: ProductMessageEnvelope): string {
  return JSON.stringify(parseProductMessageEnvelope(message));
}

export function decodeProductMessageEnvelope(serialized: string): ProductMessageEnvelope {
  return parseProductMessageEnvelope(JSON.parse(serialized));
}

function timestampToIso(timestamp: number, path: string): string {
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new ProductMessageMappingError(`${path} must be a finite non-negative timestamp`);
  }
  try {
    return new Date(timestamp).toISOString();
  } catch (cause) {
    throw new ProductMessageMappingError(`${path} is outside the supported date range`, { cause });
  }
}

function mapUsage(usage: Usage): ProductMessageUsage {
  const costUsd: ProductCostUsd = {
    input: usage.cost.input,
    output: usage.cost.output,
    cacheRead: usage.cost.cacheRead,
    cacheWrite: usage.cost.cacheWrite,
    total: usage.cost.total,
  };
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    ...(usage.cacheWrite1h !== undefined ? { cacheWrite1hTokens: usage.cacheWrite1h } : {}),
    ...(usage.reasoning !== undefined ? { reasoningTokens: usage.reasoning } : {}),
    totalTokens: usage.totalTokens,
    costUsd,
  };
}

function runtimeUsage(usage: ProductMessageUsage): Usage {
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens,
    cacheWrite: usage.cacheWriteTokens,
    ...(usage.cacheWrite1hTokens !== undefined ? { cacheWrite1h: usage.cacheWrite1hTokens } : {}),
    ...(usage.reasoningTokens !== undefined ? { reasoning: usage.reasoningTokens } : {}),
    totalTokens: usage.totalTokens,
    cost: {
      input: usage.costUsd.input,
      output: usage.costUsd.output,
      cacheRead: usage.costUsd.cacheRead,
      cacheWrite: usage.costUsd.cacheWrite,
      total: usage.costUsd.total,
    },
  };
}

function mapDiagnostic(diagnostic: AssistantMessageDiagnostic): ProductDiagnostic {
  return {
    type: diagnostic.type,
    occurredAt: timestampToIso(diagnostic.timestamp, "diagnostic.timestamp"),
    ...(diagnostic.error
      ? {
          error: {
            ...(diagnostic.error.name !== undefined ? { name: diagnostic.error.name } : {}),
            message: diagnostic.error.message,
            ...(diagnostic.error.stack !== undefined ? { stack: diagnostic.error.stack } : {}),
            ...(diagnostic.error.code !== undefined ? { code: diagnostic.error.code } : {}),
          },
        }
      : {}),
    ...(diagnostic.details !== undefined ? { details: diagnostic.details as JsonObject } : {}),
  };
}

function providerMetadata(
  message: AssistantMessage,
  configKey?: string,
): ProductProviderMetadata {
  return {
    api: message.api,
    provider: message.provider,
    model: message.model,
    ...(configKey !== undefined ? { configKey } : {}),
    ...(message.responseModel !== undefined ? { responseModel: message.responseModel } : {}),
    ...(message.responseId !== undefined ? { responseId: message.responseId } : {}),
    ...(message.diagnostics !== undefined ? { diagnostics: message.diagnostics.map(mapDiagnostic) } : {}),
  };
}

function mapExtensions(
  providerBlocks?: readonly ProductProviderExtensionBlock[],
): ProductMessageExtensions | undefined {
  return providerBlocks && providerBlocks.length > 0
    ? { providerBlocks: [...providerBlocks] }
    : undefined;
}

function mapContent(message: Message): ProductMessageBlock[] {
  const blocks = typeof message.content === "string"
    ? [{ type: "text" as const, text: message.content }]
    : message.content;
  return blocks.map((block): ProductMessageBlock => {
    switch (block.type) {
      case "text":
        return {
          type: "text",
          text: block.text,
          ...(block.textSignature !== undefined ? { signature: block.textSignature } : {}),
        };
      case "thinking":
        return {
          type: "thinking",
          text: block.thinking,
          ...(block.thinkingSignature !== undefined ? { signature: block.thinkingSignature } : {}),
          ...(block.redacted !== undefined ? { redacted: block.redacted } : {}),
        };
      case "image":
        return { type: "image", data: block.data, mimeType: block.mimeType };
      case "toolCall":
        return {
          type: "toolCall",
          toolCallId: block.id,
          toolName: block.name,
          arguments: block.arguments as JsonObject,
          ...(block.thoughtSignature !== undefined ? { thoughtSignature: block.thoughtSignature } : {}),
        };
    }
  });
}

export function runtimeMessageToProductEnvelope(
  message: Message,
  options: RuntimeMessageMappingOptions,
): ProductMessageEnvelope {
  if (message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) {
    throw new ProductMessageMappingError(
      "failed or aborted assistant results are terminal run metadata, not completed messages; use mapAssistantPersistenceOutcome()",
    );
  }
  const extensions = mapExtensions(options.providerBlocks);
  const common = {
    schemaVersion: PRODUCT_MESSAGE_SCHEMA_VERSION,
    messageId: options.messageId,
    role: message.role,
    createdAt: timestampToIso(message.timestamp, "message.timestamp"),
    content: mapContent(message),
    ...(extensions ? { extensions } : {}),
  };
  const mapped: ProductMessageEnvelope =
    message.role === "user"
      ? common
      : message.role === "assistant"
        ? {
            ...common,
            role: "assistant",
            provider: providerMetadata(message, options.configKey),
            assistant: {
              stopReason: message.stopReason as ProductAssistantStopReason,
              ...(message.errorMessage !== undefined
                ? { diagnosticMessage: message.errorMessage }
                : {}),
            },
            usage: mapUsage(message.usage),
          }
        : {
            ...common,
            role: "toolResult",
            toolResult: {
              toolCallId: message.toolCallId,
              toolName: message.toolName,
              isError: message.isError,
              ...(message.details !== undefined ? { details: message.details as JsonValue } : {}),
              ...(message.addedToolNames !== undefined
                ? { addedToolNames: [...message.addedToolNames] }
                : {}),
            },
            ...(message.usage ? { usage: mapUsage(message.usage) } : {}),
          };
  return parseProductMessageEnvelope(mapped);
}

export function productEnvelopeToRuntimeMessage(envelope: ProductMessageEnvelope): Message {
  const message = parseProductMessageEnvelope(envelope);
  const timestamp = Date.parse(message.createdAt);
  if (!Number.isFinite(timestamp)) {
    throw new ProductMessageMappingError("message.createdAt could not be parsed as a timestamp");
  }
  const content = message.content.map((block) => {
    switch (block.type) {
      case "text":
        return {
          type: "text" as const,
          text: block.text,
          ...(block.signature !== undefined ? { textSignature: block.signature } : {}),
        };
      case "thinking":
        return {
          type: "thinking" as const,
          thinking: block.text,
          ...(block.signature !== undefined ? { thinkingSignature: block.signature } : {}),
          ...(block.redacted !== undefined ? { redacted: block.redacted } : {}),
        };
      case "image":
        return { type: "image" as const, data: block.data, mimeType: block.mimeType };
      case "toolCall":
        return {
          type: "toolCall" as const,
          id: block.toolCallId,
          name: block.toolName,
          arguments: block.arguments,
          ...(block.thoughtSignature !== undefined
            ? { thoughtSignature: block.thoughtSignature }
            : {}),
        };
    }
  });

  if (message.role === "user") {
    return {
      role: "user",
      content: content.filter(
        (block) => block.type === "text" || block.type === "image",
      ) as Exclude<UserMessage["content"], string>,
      timestamp,
    };
  }
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: content.filter((block) => block.type !== "image") as AssistantMessage["content"],
      api: message.provider!.api,
      provider: message.provider!.provider,
      model: message.provider!.model,
      ...(message.provider!.responseModel !== undefined
        ? { responseModel: message.provider!.responseModel }
        : {}),
      ...(message.provider!.responseId !== undefined
        ? { responseId: message.provider!.responseId }
        : {}),
      ...(message.provider!.diagnostics !== undefined
        ? {
            diagnostics: message.provider!.diagnostics.map((diagnostic) => ({
              type: diagnostic.type,
              timestamp: Date.parse(diagnostic.occurredAt),
              ...(diagnostic.error !== undefined ? { error: diagnostic.error } : {}),
              ...(diagnostic.details !== undefined ? { details: diagnostic.details } : {}),
            })),
          }
        : {}),
      usage: runtimeUsage(message.usage!),
      stopReason: message.assistant!.stopReason,
      ...(message.assistant!.diagnosticMessage !== undefined
        ? { errorMessage: message.assistant!.diagnosticMessage }
        : {}),
      timestamp,
    };
  }
  return {
    role: "toolResult",
    toolCallId: message.toolResult!.toolCallId,
    toolName: message.toolResult!.toolName,
    content: content.filter(
      (block) => block.type === "text" || block.type === "image",
    ) as ToolResultMessage["content"],
    isError: message.toolResult!.isError,
    ...(message.toolResult!.details !== undefined ? { details: message.toolResult!.details } : {}),
    ...(message.toolResult!.addedToolNames !== undefined
      ? { addedToolNames: [...message.toolResult!.addedToolNames] }
      : {}),
    ...(message.usage !== undefined ? { usage: runtimeUsage(message.usage) } : {}),
    timestamp,
  };
}

function terminalFromAssistant(
  message: AssistantMessage,
  options: RuntimeAssistantOutcomeOptions,
): ProductRunTermination {
  const extensions = mapExtensions(options.providerBlocks);
  const common = {
    occurredAt: timestampToIso(message.timestamp, "message.timestamp"),
    ...(message.errorMessage !== undefined ? { detail: message.errorMessage } : {}),
    provider: providerMetadata(message, options.configKey),
    usage: mapUsage(message.usage),
    ...(extensions ? { extensions } : {}),
  };
  const terminal: ProductRunTermination = message.stopReason === "aborted"
    ? {
        ...common,
        kind: "cancelled",
        code: options.cancelledCode ?? "provider.aborted",
      }
    : {
        ...common,
        kind: "failed",
        code: options.failedCode ?? "provider.error",
        retryable: options.retryable ?? false,
      };
  return parseProductRunTermination(terminal);
}

export function collectProductRunTerminationIssues(value: unknown): string[] {
  const issues: string[] = [];
  if (!isJsonObject(value)) return ["terminal: must be an object"];
  checkUnknownKeys(
    value,
    ["kind", "code", "occurredAt", "retryable", "detail", "provider", "usage", "extensions"],
    "terminal",
    issues,
  );
  if (value["kind"] !== "failed" && value["kind"] !== "cancelled") {
    issues.push("terminal.kind: must be failed or cancelled");
  }
  requireString(value, "code", "terminal", issues);
  if (!isTimestamp(value["occurredAt"])) {
    issues.push("terminal.occurredAt: must be an RFC 3339 timestamp");
  }
  optionalString(value, "detail", "terminal", issues);
  if (value["provider"] !== undefined) validateProvider(value["provider"], "terminal.provider", issues);
  if (value["usage"] !== undefined) validateUsage(value["usage"], "terminal.usage", issues);
  if (value["extensions"] !== undefined) {
    validateExtensions(value["extensions"], "terminal.extensions", issues);
  }
  if (value["kind"] === "failed") {
    if (typeof value["retryable"] !== "boolean") {
      issues.push("terminal.retryable: must be a boolean for a failed run");
    }
  } else if (value["kind"] === "cancelled" && value["retryable"] !== undefined) {
    issues.push("terminal.retryable: is not allowed for a cancelled run");
  }
  return issues;
}

export function parseProductRunTermination(value: unknown): ProductRunTermination {
  const issues = collectProductRunTerminationIssues(value);
  if (issues.length > 0) {
    throw new ProductRunTerminationValidationError(issues);
  }
  return cloneJsonValue(value as ProductRunTermination & JsonValue);
}

export function mapAssistantPersistenceOutcome(
  message: AssistantMessage,
  options: RuntimeAssistantOutcomeOptions,
): ProductAssistantPersistenceOutcome {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    return { kind: "terminal", terminal: terminalFromAssistant(message, options) };
  }
  return {
    kind: "message",
    message: runtimeMessageToProductEnvelope(message, options),
  };
}
