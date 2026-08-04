/**
 * File-backed credential store.
 *
 * Not in any ADR — found necessary while wiring the OAuth verification leg.
 * pi-ai's default `InMemoryCredentialStore` is explicitly documented as
 * "Apps inject persistent stores", so without this an OAuth login would be
 * discarded when the process exits and every run would re-authenticate.
 *
 * Deliberately minimal: one JSON file, one credential per provider id, mode
 * 0600. It is NOT a secure secret store — the file holds live OAuth tokens
 * in plaintext, which is why `.harness-credentials.json` is gitignored. A
 * real deployment should back this with the OS keychain instead.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { fromRepoRoot } from "./paths.ts";

/**
 * Where credentials live, overridable via `HARNESS_CREDENTIALS_PATH`.
 *
 * The override exists because pi-coding-agent writes the *same* format —
 * pi-ai's own docs describe `OAuthCredential` as "the shape of today's
 * auth.json", keyed by provider id — so an existing pi agent's auth.json
 * can be pointed at directly instead of repeating its OAuth login. Verified
 * against local-pi's `agent-home/auth.json`, whose `openai-codex` entry
 * matches field for field.
 */
export const DEFAULT_CREDENTIALS_PATH: string =
  process.env["HARNESS_CREDENTIALS_PATH"]?.trim() ||
  // Anchored to the repo root so the scripts find the same credential file
  // regardless of the working directory. An explicit override is left
  // alone — a path someone typed should behave like any other path.
  fromRepoRoot(".harness-credentials.json");

export class FileCredentialStore implements CredentialStore {
  private readonly path: string;
  /**
   * Serializes writes across ALL providers, not per provider.
   *
   * `InMemoryCredentialStore` chains per provider id, which is correct there
   * because each write touches its own `Map` key. Here every write is a
   * whole-file read-modify-write, so two different providers refreshing
   * concurrently would interleave and one would silently clobber the other's
   * rotated token — while still reporting success. One chain, one writer.
   */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(path: string = DEFAULT_CREDENTIALS_PATH) {
    this.path = path;
  }

  private readAll(): Record<string, Credential> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, Credential>;
      }
      return {};
    } catch {
      // Missing or unreadable file means "no credentials yet", which is the
      // normal first-run state — not an error worth propagating.
      return {};
    }
  }

  private writeAll(all: Record<string, Credential>): void {
    const dir = dirname(this.path);
    if (dir && dir !== ".") mkdirSync(dir, { recursive: true });

    // Write-then-rename so a crash mid-write can't truncate existing
    // credentials into an unusable file.
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
    chmodSync(this.path, 0o600);
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return this.readAll()[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.readAll()).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.enqueue(async () => {
      const all = this.readAll();
      const updated = await fn(all[providerId]);
      if (updated === undefined) return all[providerId];

      all[providerId] = updated;
      this.writeAll(all);
      return updated;
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.enqueue(async () => {
      const all = this.readAll();
      delete all[providerId];
      this.writeAll(all);
    });
  }
}
