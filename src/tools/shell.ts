import { spawn } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import type { ToolHandler } from "../tool-registry.ts";
import {
  validateShellExecution,
  type ShellExecutionPolicy,
  WorkspaceConfinement,
} from "../tool-execution.ts";

export interface ShellToolOptions {
  workspace: WorkspaceConfinement;
  policy: ShellExecutionPolicy;
  maxOutputBytes?: number;
}

export function createShellTool(options: ShellToolOptions): ToolHandler {
  const maxOutputBytes = options.maxOutputBytes ?? 256_000;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) throw new TypeError("maxOutputBytes must be a positive whole number");
  return {
    definition: {
      name: "run_process",
      description: "Run one explicitly allowlisted executable without a command shell.",
      parameters: Type.Object({
        executable: Type.String({ minLength: 1 }),
        args: Type.Array(Type.String()),
        cwd: Type.String({ minLength: 1 }),
        environment: Type.Optional(Type.Record(Type.String(), Type.String())),
      }, { additionalProperties: false }),
    },
    controls: {
      capabilities: ["exec"], risk: "critical", timeoutMs: 30_000,
      maxOutputChars: maxOutputBytes * 2 + 2_000, concurrencyCost: 4,
      sideEffect: "irreversible", idempotency: "callerKey",
    },
    async execute(args, context) {
      const request = await validateShellExecution({
        executable: String(args["executable"]),
        args: args["args"] as string[],
        cwd: String(args["cwd"]),
        environment: args["environment"] as Record<string, string> | undefined,
      }, options.policy, options.workspace);
      return new Promise((resolve, reject) => {
        const child = spawn(request.executable, request.args, {
          cwd: request.cwd,
          env: { ...request.environment },
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let bytes = 0;
        let settled = false;
        const finishError = (error: unknown): void => {
          if (settled) return;
          settled = true;
          context?.signal?.removeEventListener("abort", abort);
          reject(error);
        };
        const abort = (): void => {
          child.kill("SIGKILL");
          finishError(context?.signal?.reason ?? new Error("execution.cancelled"));
        };
        const collect = (target: Buffer[], chunk: Buffer): void => {
          bytes += chunk.byteLength;
          if (bytes > maxOutputBytes) {
            child.kill("SIGKILL");
            finishError(new Error("shell.output-too-large"));
            return;
          }
          target.push(Buffer.from(chunk));
        };
        child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
        child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
        child.on("error", finishError);
        child.on("close", (code, signal) => {
          if (settled) return;
          settled = true;
          context?.signal?.removeEventListener("abort", abort);
          resolve({
            content: [{ type: "text", text: JSON.stringify({
              exitCode: code,
              signal,
              stdout: Buffer.concat(stdout).toString("utf8"),
              stderr: Buffer.concat(stderr).toString("utf8"),
            }) }],
            isError: code !== 0,
          });
        });
        if (context?.signal?.aborted) abort();
        else context?.signal?.addEventListener("abort", abort, { once: true });
      });
    },
  };
}
