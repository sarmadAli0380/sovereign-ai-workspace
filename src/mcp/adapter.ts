import { createHash } from "node:crypto";
import type { Tool, ToolResultMessage } from "@earendil-works/pi-ai";
import { cloneJsonValue, collectJsonValueIssues, type JsonObject, type JsonValue } from "../json.ts";
import { ToolRegistry, type ToolControlDeclaration, type ToolExecutionContext, type ToolHandler } from "../tool-registry.ts";

export interface McpServerIdentity {
  name: string;
  version: string;
}

export interface McpDiscoveredTool {
  name: string;
  description?: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
}

export interface McpListToolsPage {
  tools: readonly McpDiscoveredTool[];
  nextCursor?: string;
}

export interface McpCallToolResult {
  content: readonly unknown[];
  isError?: boolean;
}

export interface McpConnectionHealth {
  status: "connecting" | "ready" | "degraded" | "closed";
  lastError?: string;
}

/** Narrow port implemented by the official SDK client wrapper. */
export interface McpClientPort {
  serverIdentity(): McpServerIdentity;
  health(): McpConnectionHealth;
  listTools(cursor?: string): Promise<McpListToolsPage>;
  callTool(name: string, args: JsonObject, context?: ToolExecutionContext): Promise<McpCallToolResult>;
  close(): Promise<void>;
}

export interface McpToolRegistration {
  localName: string;
  /** Deployment-owned description; remote descriptions never enter the prompt. */
  description: string;
  expectedDiscoveryFingerprint: string;
  controls: ToolControlDeclaration;
}

export interface McpServerRegistrationConfig {
  serverId: string;
  expectedIdentity: McpServerIdentity;
  capabilityCeiling: readonly string[];
  tools: Readonly<Record<string, McpToolRegistration>>;
  maxDiscoveryPages?: number;
}

export interface McpRegistrationResult {
  serverId: string;
  registeredTools: readonly string[];
  ignoredRemoteTools: readonly string[];
  health(): McpConnectionHealth;
  close(): Promise<void>;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as JsonObject;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`).join(",")}}`;
}

export function mcpToolDiscoveryFingerprint(tool: McpDiscoveredTool): string {
  const issues: string[] = [];
  collectJsonValueIssues(tool.inputSchema, "MCP inputSchema", issues);
  if (issues.length > 0) throw new TypeError(issues[0]);
  if (typeof tool.name !== "string" || tool.name.length === 0) throw new TypeError("MCP tool name must be non-empty");
  if (tool.description !== undefined && typeof tool.description !== "string") throw new TypeError("MCP description must be a string");
  return createHash("sha256").update(canonicalJson({
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema ?? null,
  })).digest("hex");
}

function nonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${field} must be a non-empty string`);
}

function stableCapability(value: string): boolean {
  return /^[a-z][a-z0-9.-]*$/.test(value);
}

function normalizeResultContent(content: readonly unknown[]): ToolResultMessage["content"] {
  if (!Array.isArray(content)) throw new TypeError("MCP result content must be an array");
  return content.map((block, index) => {
    if (typeof block !== "object" || block === null || Array.isArray(block)) throw new TypeError(`MCP result content[${index}] must be an object`);
    const value = block as Record<string, unknown>;
    if (value["type"] === "text") {
      if (typeof value["text"] !== "string") throw new TypeError(`MCP result content[${index}].text must be a string`);
      return { type: "text" as const, text: value["text"] };
    }
    if (value["type"] === "image") {
      if (typeof value["data"] !== "string" || typeof value["mimeType"] !== "string" || value["mimeType"].length === 0) throw new TypeError(`MCP result content[${index}] image is malformed`);
      return { type: "image" as const, data: value["data"], mimeType: value["mimeType"] };
    }
    const issues: string[] = [];
    collectJsonValueIssues(value, `MCP result content[${index}]`, issues);
    if (issues.length > 0) throw new TypeError(issues[0]);
    // pi-ai's provider boundary carries text/images only. Preserve other MCP
    // block types as explicit untrusted JSON rather than silently dropping.
    return { type: "text" as const, text: `[MCP_UNTRUSTED_CONTENT]${canonicalJson(value as JsonObject)}` };
  });
}

function validateConfig(config: McpServerRegistrationConfig): void {
  if (typeof config !== "object" || config === null) throw new TypeError("MCP config must be an object");
  const unknown = Object.keys(config).filter((key) => !new Set(["serverId", "expectedIdentity", "capabilityCeiling", "tools", "maxDiscoveryPages"]).has(key));
  if (unknown.length > 0) throw new TypeError(`MCP config has unknown fields: ${unknown.join(", ")}`);
  if (!/^[a-z][a-z0-9.-]*$/.test(config.serverId)) throw new TypeError("MCP serverId must be a stable lowercase identifier");
  nonEmpty(config.expectedIdentity?.name, "MCP expected identity name");
  nonEmpty(config.expectedIdentity?.version, "MCP expected identity version");
  if (!Array.isArray(config.capabilityCeiling) || config.capabilityCeiling.length === 0 || config.capabilityCeiling.some((item) => typeof item !== "string" || !stableCapability(item))) throw new TypeError("MCP capability ceiling is invalid");
  if (new Set(config.capabilityCeiling).size !== config.capabilityCeiling.length) throw new TypeError("MCP capability ceiling has duplicates");
  if (typeof config.tools !== "object" || config.tools === null || Array.isArray(config.tools) || Object.keys(config.tools).length === 0) throw new TypeError("MCP tools config must be a non-empty object");
  if (config.maxDiscoveryPages !== undefined && (!Number.isInteger(config.maxDiscoveryPages) || config.maxDiscoveryPages <= 0)) throw new TypeError("MCP maxDiscoveryPages must be positive");
  for (const [remoteName, registration] of Object.entries(config.tools)) {
    nonEmpty(remoteName, "MCP configured remote name");
    if (typeof registration !== "object" || registration === null) throw new TypeError(`MCP ${remoteName} registration must be an object`);
    const registrationUnknown = Object.keys(registration).filter((key) => !new Set(["localName", "description", "expectedDiscoveryFingerprint", "controls"]).has(key));
    if (registrationUnknown.length > 0) throw new TypeError(`MCP ${remoteName} registration has unknown fields: ${registrationUnknown.join(", ")}`);
    if (!/^[a-f0-9]{64}$/.test(registration.expectedDiscoveryFingerprint)) throw new TypeError(`MCP ${remoteName} discovery fingerprint must be SHA-256 hex`);
  }
}

export async function registerMcpServer(
  client: McpClientPort,
  registry: ToolRegistry,
  config: McpServerRegistrationConfig,
): Promise<McpRegistrationResult> {
  validateConfig(config);
  const identity = client.serverIdentity();
  if (identity.name !== config.expectedIdentity.name || identity.version !== config.expectedIdentity.version) throw new Error("mcp.identity-mismatch");
  const ceiling = new Set(config.capabilityCeiling);
  const pages = config.maxDiscoveryPages ?? 100;
  const discovered = new Map<string, McpDiscoveredTool>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < pages; page += 1) {
    const response = await client.listTools(cursor);
    if (!response || !Array.isArray(response.tools)) throw new TypeError("mcp.discovery-malformed");
    for (const raw of response.tools) {
      const tool = {
        ...raw,
        inputSchema: cloneJsonValue(raw.inputSchema),
        ...(raw.outputSchema ? { outputSchema: cloneJsonValue(raw.outputSchema) } : {}),
      };
      mcpToolDiscoveryFingerprint(tool);
      if (discovered.has(tool.name)) throw new Error("mcp.duplicate-tool");
      discovered.set(tool.name, tool);
    }
    if (!response.nextCursor) { cursor = undefined; break; }
    nonEmpty(response.nextCursor, "MCP nextCursor");
    if (cursors.has(response.nextCursor)) throw new Error("mcp.cursor-cycle");
    cursors.add(response.nextCursor);
    cursor = response.nextCursor;
    if (page === pages - 1) throw new Error("mcp.discovery-page-limit");
  }

  const prepared: ToolHandler[] = [];
  const localNames = new Set<string>();
  for (const [remoteName, registration] of Object.entries(config.tools)) {
    const remote = discovered.get(remoteName);
    if (!remote) throw new Error(`mcp.configured-tool-missing:${remoteName}`);
    if (mcpToolDiscoveryFingerprint(remote) !== registration.expectedDiscoveryFingerprint) throw new Error(`mcp.tool-fingerprint-mismatch:${remoteName}`);
    nonEmpty(registration.localName, `MCP ${remoteName} localName`);
    nonEmpty(registration.description, `MCP ${remoteName} local description`);
    if (localNames.has(registration.localName)) throw new Error(`mcp.duplicate-local-name:${registration.localName}`);
    localNames.add(registration.localName);
    if (registration.controls.capabilities.some((capability) => !ceiling.has(capability))) throw new Error(`mcp.capability-ceiling-exceeded:${remoteName}`);
    const definition: Tool = {
      name: registration.localName,
      description: registration.description,
      parameters: cloneJsonValue(remote.inputSchema) as Tool["parameters"],
    };
    prepared.push({
      definition,
      controls: registration.controls,
      async execute(args, context) {
        const result = await client.callTool(remoteName, cloneJsonValue(args as JsonObject), context);
        if (typeof result !== "object" || result === null || !Array.isArray(result.content)) throw new TypeError("mcp.call-result-malformed");
        return { content: normalizeResultContent(result.content), isError: result.isError ?? false };
      },
    });
  }
  // Validate every handler declaration in an isolated registry and check all
  // target conflicts before publishing any tool into the live registry.
  const staging = new ToolRegistry();
  for (const handler of prepared) staging.register(handler);
  for (const handler of prepared) if (registry.has(handler.definition.name)) throw new Error(`mcp.local-name-conflict:${handler.definition.name}`);
  for (const handler of prepared) registry.register(handler);
  const registered = prepared.map((handler) => handler.definition.name);
  return Object.freeze({
    serverId: config.serverId,
    registeredTools: Object.freeze(registered.sort()),
    ignoredRemoteTools: Object.freeze([...discovered.keys()].filter((name) => !(name in config.tools)).sort()),
    health: () => Object.freeze({ ...client.health() }),
    close: () => client.close(),
  });
}
