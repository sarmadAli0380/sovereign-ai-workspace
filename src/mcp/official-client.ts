import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { cloneJsonValue, collectJsonValueIssues, type JsonObject } from "../json.ts";
import {
  validateShellExecution,
  type ShellExecutionPolicy,
  type ShellExecutionRequest,
  type WorkspaceConfinement,
} from "../tool-execution.ts";
import type { ToolExecutionContext } from "../tool-registry.ts";
import type {
  McpCallToolResult,
  McpClientPort,
  McpConnectionHealth,
  McpListToolsPage,
  McpServerIdentity,
} from "./adapter.ts";

export interface OfficialMcpClientOptions {
  clientIdentity: McpServerIdentity;
  requestTimeoutMs: number;
}

export interface OfficialStdioMcpClientOptions extends OfficialMcpClientOptions {
  server: ShellExecutionRequest;
  shellPolicy: ShellExecutionPolicy;
  workspace: WorkspaceConfinement;
  maxBufferBytes: number;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${field} must be a positive whole number`);
  }
  return Number(value);
}

function identity(value: McpServerIdentity, field: string): McpServerIdentity {
  if (typeof value !== "object" || value === null) throw new TypeError(`${field} must be an object`);
  if (typeof value.name !== "string" || value.name.length === 0) throw new TypeError(`${field}.name must be non-empty`);
  if (typeof value.version !== "string" || value.version.length === 0) throw new TypeError(`${field}.version must be non-empty`);
  return Object.freeze({ name: value.name, version: value.version });
}

class OfficialSdkClientPort implements McpClientPort {
  readonly #client: Client;
  readonly #serverIdentity: McpServerIdentity;
  readonly #requestTimeoutMs: number;
  #health: McpConnectionHealth = { status: "ready" };

  constructor(client: Client, serverIdentity: McpServerIdentity, requestTimeoutMs: number) {
    this.#client = client;
    this.#serverIdentity = identity(serverIdentity, "MCP server identity");
    this.#requestTimeoutMs = requestTimeoutMs;
    client.onerror = (error) => { this.#health = { status: "degraded", lastError: error.message }; };
    client.onclose = () => {
      this.#health = { status: "closed", ...(this.#health.lastError ? { lastError: this.#health.lastError } : {}) };
    };
  }

  serverIdentity(): McpServerIdentity { return { ...this.#serverIdentity }; }
  health(): McpConnectionHealth { return { ...this.#health }; }

  async listTools(cursor?: string): Promise<McpListToolsPage> {
    try {
      const result = await this.#client.listTools(cursor ? { cursor } : undefined, {
        timeout: this.#requestTimeoutMs,
        maxTotalTimeout: this.#requestTimeoutMs,
      });
      const tools = result.tools.map((tool) => {
        const issues: string[] = [];
        collectJsonValueIssues(tool.inputSchema, `MCP tool ${tool.name} inputSchema`, issues);
        if (issues.length > 0) throw new TypeError(issues[0]);
        return {
          name: tool.name,
          ...(tool.description !== undefined ? { description: tool.description } : {}),
          inputSchema: cloneJsonValue(tool.inputSchema as JsonObject),
          ...(tool.outputSchema ? { outputSchema: cloneJsonValue(tool.outputSchema as JsonObject) } : {}),
        };
      });
      this.#health = { status: "ready" };
      return { tools, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
    } catch (error) {
      this.#degrade(error);
      throw error;
    }
  }

  async callTool(name: string, args: JsonObject, context: ToolExecutionContext = {}): Promise<McpCallToolResult> {
    const remaining = context.deadline === undefined ? this.#requestTimeoutMs : context.deadline - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("mcp.deadline-exceeded");
    const timeout = Math.max(1, Math.floor(Math.min(this.#requestTimeoutMs, remaining)));
    try {
      const result = await this.#client.callTool(
        { name, arguments: cloneJsonValue(args) },
        undefined,
        { timeout, maxTotalTimeout: timeout, ...(context.signal ? { signal: context.signal } : {}) },
      );
      if (!("content" in result) || !Array.isArray(result.content)) throw new Error("mcp.task-result-unsupported");
      if (result.isError !== undefined && typeof result.isError !== "boolean") throw new TypeError("mcp.call-result-malformed");
      this.#health = { status: "ready" };
      return { content: structuredClone(result.content), isError: result.isError ?? false };
    } catch (error) {
      this.#degrade(error);
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.#client.close();
    this.#health = { status: "closed", ...(this.#health.lastError ? { lastError: this.#health.lastError } : {}) };
  }

  #degrade(error: unknown): void {
    this.#health = { status: "degraded", lastError: error instanceof Error ? error.message : String(error) };
  }
}

export async function connectOfficialMcpClient(
  transport: Transport,
  options: OfficialMcpClientOptions,
): Promise<McpClientPort> {
  if (typeof transport !== "object" || transport === null) throw new TypeError("MCP transport is required");
  const clientIdentity = identity(options.clientIdentity, "MCP client identity");
  const requestTimeoutMs = positiveInteger(options.requestTimeoutMs, "MCP requestTimeoutMs");
  const client = new Client(clientIdentity, { capabilities: {}, enforceStrictCapabilities: true });
  try {
    await client.connect(transport, { timeout: requestTimeoutMs, maxTotalTimeout: requestTimeoutMs });
    const serverIdentity = client.getServerVersion();
    if (!serverIdentity) throw new Error("mcp.server-identity-missing");
    return new OfficialSdkClientPort(client, identity(serverIdentity, "MCP server identity"), requestTimeoutMs);
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

export async function connectOfficialStdioMcpClient(
  options: OfficialStdioMcpClientOptions,
): Promise<McpClientPort> {
  const server = await validateShellExecution(options.server, options.shellPolicy, options.workspace);
  const transport = new StdioClientTransport({
    command: server.executable,
    args: [...server.args],
    cwd: server.cwd,
    env: { ...server.environment },
    stderr: "ignore",
    maxBufferSize: positiveInteger(options.maxBufferBytes, "MCP stdio maxBufferBytes"),
  });
  return connectOfficialMcpClient(transport, options);
}
