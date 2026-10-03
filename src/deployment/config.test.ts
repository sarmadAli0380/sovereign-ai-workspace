import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseSingleNodeDeploymentConfig, readDeploymentSecrets } from "./config.ts";

test("P3.1 deployment config freezes internal endpoints, pinned model identity, and file secrets", () => {
  const config = parseSingleNodeDeploymentConfig({});
  assert.equal(config.database.host, "database");
  assert.equal(config.database.port, 5432);
  assert.equal(config.inference.baseUrl, "http://inference:11434");
  assert.equal(config.inference.expectedVersion, "0.32.5");
  assert.equal(config.inference.contextWindow, 8192);
  assert.equal(config.inference.loadTimeoutMs, 600_000);
  assert.match(config.inference.modelDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(config.storage.spoolMaxBytes, 512 * 1024 * 1024);
});

test("P3.1 deployment config rejects direct secrets, external inference, and numeric fail-open values", () => {
  assert.throws(
    () => parseSingleNodeDeploymentConfig({ DEPLOYMENT_DATABASE_PASSWORD: "do-not-use-env" }),
    /forbidden/,
  );
  assert.throws(
    () => parseSingleNodeDeploymentConfig({ DEPLOYMENT_OLLAMA_URL: "https://ollama.example.com" }),
    /internal/,
  );
  assert.throws(
    () => parseSingleNodeDeploymentConfig({ DEPLOYMENT_MODEL_CONTEXT_WINDOW: "NaN" }),
    /positive whole number/,
  );
  assert.throws(
    () => parseSingleNodeDeploymentConfig({ DEPLOYMENT_SPOOL_MAX_BYTES: "0" }),
    /positive safe integer/,
  );
  assert.throws(
    () => parseSingleNodeDeploymentConfig({ DEPLOYMENT_MODEL_LOAD_TIMEOUT_MS: "Infinity" }),
    /positive whole number/,
  );
});

test("P3.1 deployment secrets require exact regular-file encodings", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "sovereign-p3-secrets-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });
  const passwordFile = join(directory, "database_password");
  const keyFile = join(directory, "spool_key");
  await writeFile(passwordFile, `${"a".repeat(32)}\n`, { mode: 0o600 });
  await writeFile(keyFile, `${"ab".repeat(32)}\n`, { mode: 0o600 });
  const parsed = parseSingleNodeDeploymentConfig({});
  const config = {
    ...parsed,
    database: { ...parsed.database, passwordFile },
    storage: { ...parsed.storage, spoolKeyFile: keyFile },
  };
  const secrets = await readDeploymentSecrets(config);
  assert.equal(secrets.databasePassword.length, 32);
  assert.equal(secrets.spoolKey.byteLength, 32);

  await writeFile(keyFile, `${"AB".repeat(32)}\n`, { mode: 0o600 });
  await assert.rejects(readDeploymentSecrets(config), /lowercase-hex/);
});
