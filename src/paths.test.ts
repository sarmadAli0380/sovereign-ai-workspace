import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG_PATH, loadConfig } from "./config.ts";
import { DEFAULT_CREDENTIALS_PATH } from "./credential-store.ts";
import { fromRepoRoot, REPO_ROOT } from "./paths.ts";

test("REPO_ROOT is the directory holding package.json", () => {
  assert.ok(isAbsolute(REPO_ROOT));
  assert.ok(existsSync(resolve(REPO_ROOT, "package.json")));
  assert.ok(existsSync(resolve(REPO_ROOT, "model.config.json")));
});

test("default paths are absolute, not cwd-relative", () => {
  assert.ok(isAbsolute(DEFAULT_CONFIG_PATH), "config path must be absolute");
  assert.ok(isAbsolute(DEFAULT_CREDENTIALS_PATH), "credentials path must be absolute");
});

test("fromRepoRoot resolves against the repo, not the cwd", () => {
  assert.equal(fromRepoRoot("model.config.json"), resolve(REPO_ROOT, "model.config.json"));
});

test("an explicit relative path still resolves against the cwd", () => {
  // Only defaults are anchored — a path someone typed should behave normally.
  assert.throws(() => loadConfig("definitely-not-here.json"), /Could not read config/);
});

test("config loads when the process runs from a different directory", () => {
  // The actual regression this guards: running a script from outside the
  // repo used to fail with a confusing "could not read config".
  const script = `
    import { loadConfig } from ${JSON.stringify(fromRepoRoot("src/config.ts"))};
    const config = loadConfig();
    console.log(Object.keys(config).length > 0 ? "OK" : "EMPTY");
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: tmpdir(), // deliberately not the repo root
    encoding: "utf8",
  });
  assert.match(output, /OK/);
});
