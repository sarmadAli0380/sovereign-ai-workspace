/**
 * Repo-root-anchored path resolution.
 *
 * The harness's default files (`model.config.json`, the credential store)
 * belong to the repo, not to whatever directory you happen to be standing
 * in. Resolving them against `process.cwd()` meant `node
 * scripts/verify-swap.ts` only worked from the repo root, and failed from
 * anywhere else with a confusing "could not read config" — or, worse,
 * silently picked up a different file that happened to share the name.
 *
 * Only *defaults* are anchored here. An explicit path a caller passes in
 * still resolves against the cwd, which is what anyone typing a relative
 * path expects.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Walks up from this module until it finds the directory holding package.json. */
function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(resolve(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    // Hit the filesystem root without finding one — fall back to where we
    // started rather than throwing, so the harness stays usable if it's
    // ever vendored somewhere without a package.json above it.
    if (parent === dir) return start;
    dir = parent;
  }
}

export const REPO_ROOT: string = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

/** Resolves a path against the repo root. */
export function fromRepoRoot(...segments: string[]): string {
  return resolve(REPO_ROOT, ...segments);
}
