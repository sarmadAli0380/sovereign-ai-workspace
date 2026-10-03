import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ToolHandler } from "../tool-registry.ts";
import { WorkspaceConfinement } from "../tool-execution.ts";

export interface SearchToolOptions {
  workspace: WorkspaceConfinement;
  maxFiles?: number;
  maxFileBytes?: number;
  maxMatches?: number;
}

export function createSearchTool(options: SearchToolOptions): ToolHandler {
  const maxFiles = options.maxFiles ?? 2_000;
  const maxFileBytes = options.maxFileBytes ?? 256_000;
  const maxMatches = options.maxMatches ?? 200;
  for (const [name, value] of Object.entries({ maxFiles, maxFileBytes, maxMatches })) {
    if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive whole number`);
  }
  return {
    definition: {
      name: "search_text",
      description: "Search UTF-8 workspace files for a literal text value.",
      parameters: Type.Object({ query: Type.String({ minLength: 1 }), path: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
    },
    controls: {
      capabilities: ["fs.read"], risk: "low", timeoutMs: 10_000,
      maxOutputChars: maxMatches * 600, concurrencyCost: 2, sideEffect: "none", idempotency: "natural",
    },
    async execute(args, context) {
      const root = await options.workspace.existing(String(args["path"] ?? "."));
      const query = String(args["query"]);
      const files: string[] = [];
      const walk = async (path: string): Promise<void> => {
        if (context?.signal?.aborted) throw context.signal.reason;
        const info = await lstat(path);
        if (info.isSymbolicLink()) return;
        if (info.isFile()) { files.push(path); return; }
        if (!info.isDirectory()) return;
        for (const entry of (await readdir(path)).sort()) {
          if (files.length >= maxFiles) throw new Error("search.file-limit");
          await walk(join(path, entry));
        }
      };
      await walk(root);
      const matches: { path: string; line: number; text: string }[] = [];
      for (const file of files) {
        if (context?.signal?.aborted) throw context.signal.reason;
        const info = await lstat(file);
        if (info.size > maxFileBytes) continue;
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(file, { signal: context?.signal })); }
        catch { continue; }
        for (const [index, line] of text.split(/\r?\n/).entries()) {
          if (!line.includes(query)) continue;
          matches.push({ path: relative(options.workspace.root, file), line: index + 1, text: line.slice(0, 500) });
          if (matches.length >= maxMatches) return { content: [{ type: "text", text: JSON.stringify(matches) }] };
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(matches) }] };
    },
  };
}
