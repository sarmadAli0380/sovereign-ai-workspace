import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ToolHandler } from "../tool-registry.ts";
import { WorkspaceConfinement } from "../tool-execution.ts";

export interface FilesystemToolOptions {
  workspace: WorkspaceConfinement;
  maxReadBytes?: number;
  maxDirectoryEntries?: number;
}

function positive(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) throw new TypeError(`${name} must be a positive whole number`);
  return resolved;
}

export function createFileReadTool(options: FilesystemToolOptions): ToolHandler {
  const maxBytes = positive(options.maxReadBytes, 256_000, "maxReadBytes");
  return {
    definition: {
      name: "read_file",
      description: "Read one UTF-8 text file within the configured workspace.",
      parameters: Type.Object({ path: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    },
    controls: {
      capabilities: ["fs.read"], risk: "low", timeoutMs: 5_000,
      maxOutputChars: maxBytes + 1_000, concurrencyCost: 1, sideEffect: "none", idempotency: "natural",
    },
    async execute(args, context) {
      const path = await options.workspace.existing(String(args["path"]));
      const info = await lstat(path);
      if (!info.isFile()) throw new Error("fs.not-file");
      if (info.size > maxBytes) throw new Error("fs.read-too-large");
      const bytes = await readFile(path, { signal: context?.signal });
      if (bytes.byteLength > maxBytes) throw new Error("fs.read-too-large");
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { throw new Error("fs.not-utf8"); }
      return { content: [{ type: "text", text }] };
    },
  };
}

export function createDirectoryListTool(options: FilesystemToolOptions): ToolHandler {
  const maxEntries = positive(options.maxDirectoryEntries, 1_000, "maxDirectoryEntries");
  return {
    definition: {
      name: "list_directory",
      description: "List one directory within the configured workspace.",
      parameters: Type.Object({ path: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    },
    controls: {
      capabilities: ["fs.read"], risk: "low", timeoutMs: 5_000,
      maxOutputChars: maxEntries * 300, concurrencyCost: 1, sideEffect: "none", idempotency: "natural",
    },
    async execute(args, context) {
      if (context?.signal?.aborted) throw context.signal.reason;
      const path = await options.workspace.existing(String(args["path"]));
      const entries = await readdir(path, { withFileTypes: true });
      if (entries.length > maxEntries) throw new Error("fs.directory-too-large");
      const rows = entries
        .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other" }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { content: [{ type: "text", text: JSON.stringify(rows) }] };
    },
  };
}

export interface FileWriteToolOptions extends FilesystemToolOptions {
  maxWriteBytes?: number;
}

export function createFileWriteTool(options: FileWriteToolOptions): ToolHandler {
  const maxBytes = positive(options.maxWriteBytes, 256_000, "maxWriteBytes");
  return {
    definition: {
      name: "write_file",
      description: "Atomically replace one UTF-8 file within the configured workspace.",
      parameters: Type.Object({
        path: Type.String({ minLength: 1 }),
        content: Type.String(),
        expectedSha256: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
      }, { additionalProperties: false }),
    },
    controls: {
      capabilities: ["fs.write"], risk: "high", timeoutMs: 5_000,
      maxOutputChars: 1_000, concurrencyCost: 1, sideEffect: "reversible", idempotency: "callerKey",
    },
    async execute(args, context) {
      const content = String(args["content"]);
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > maxBytes) throw new Error("fs.write-too-large");
      const target = await options.workspace.forCreate(String(args["path"]));
      const expected = args["expectedSha256"] as string | undefined;
      if (expected !== undefined) {
        let current: Buffer;
        try { current = await readFile(target, { signal: context?.signal }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          current = Buffer.alloc(0);
        }
        const actual = createHash("sha256").update(current).digest("hex");
        if (actual !== expected) throw new Error("fs.write-conflict");
      }
      if (context?.signal?.aborted) throw context.signal.reason;
      const temp = join(dirname(target), `.${randomUUID()}.staged`);
      try {
        await writeFile(temp, content, { encoding: "utf8", flag: "wx", mode: 0o600, signal: context?.signal });
        if (context?.signal?.aborted) throw context.signal.reason;
        await rename(temp, target);
      } finally {
        await unlink(temp).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
      return { content: [{ type: "text", text: JSON.stringify({ bytes, sha256: createHash("sha256").update(content).digest("hex") }) }] };
    },
  };
}
