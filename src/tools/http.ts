import { Type } from "@earendil-works/pi-ai";
import type { ToolHandler } from "../tool-registry.ts";
import {
  fetchWithHttpPolicy,
  type HttpExecutionPolicy,
  type HttpPolicyDependencies,
} from "../tool-execution.ts";

export interface HttpToolOptions {
  policy: HttpExecutionPolicy;
  dependencies?: HttpPolicyDependencies;
}

export function createHttpFetchTool(options: HttpToolOptions): ToolHandler {
  return {
    definition: {
      name: "fetch_url",
      description: "Fetch one URL using the configured destination and response policy.",
      parameters: Type.Object({ url: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    },
    controls: {
      capabilities: ["net"], risk: "high", timeoutMs: 30_000,
      maxOutputChars: options.policy.maxResponseBytes * 2 + 4_000,
      concurrencyCost: 2, sideEffect: "none", idempotency: "natural",
    },
    async execute(args, context) {
      const response = await fetchWithHttpPolicy(
        String(args["url"]),
        options.policy,
        { method: "GET", signal: context?.signal },
        options.dependencies,
      );
      let body: string;
      let encoding: "utf8" | "base64";
      try {
        body = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
        encoding = "utf8";
      } catch {
        body = Buffer.from(response.body).toString("base64");
        encoding = "base64";
      }
      return {
        content: [{ type: "text", text: JSON.stringify({
          url: response.url,
          status: response.status,
          headers: response.headers,
          encoding,
          body,
        }) }],
        isError: response.status >= 400,
      };
    },
  };
}
