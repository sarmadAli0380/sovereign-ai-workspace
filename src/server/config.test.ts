import assert from "node:assert/strict";
import test from "node:test";
import { parseServerDeploymentConfig } from "./config.ts";

test("C2 server config requires measured admission memory and file-backed sessions", () => {
  const config = parseServerDeploymentConfig({ DEPLOYMENT_ADMISSION_FREE_BYTES: "6442450944" });
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 8080);
  assert.equal(config.sessionRegistryFile, "/run/secrets/session_registry");
  assert.equal(config.runTimeoutMs, 600_000);
  assert.equal(config.admissionHeadroomBytes, 512 * 1024 * 1024);
  assert.equal(config.maxConcurrentRunsPerUser, 1);
  assert.equal(config.maxConcurrentRunsPerModel, 1);
  assert.equal(config.maxRunsPerUserPerWindow, 60);
  assert.equal(config.maxTokensPerUserPerWindow, 1_000_000);
  assert.equal(config.maxSpendUsdPerUserPerWindow, 0);
  assert.equal(config.controlLeaseTtlMs, 660_000);
});

test("C2 server config fails closed on missing measurements, direct tokens, and unsafe paths", () => {
  assert.throws(() => parseServerDeploymentConfig({}), /DEPLOYMENT_ADMISSION_FREE_BYTES/);
  assert.throws(() => parseServerDeploymentConfig({
    DEPLOYMENT_ADMISSION_FREE_BYTES: "6442450944",
    DEPLOYMENT_BEARER_TOKEN: "must-not-be-here",
  }), /forbidden/);
  assert.throws(() => parseServerDeploymentConfig({
    DEPLOYMENT_ADMISSION_FREE_BYTES: "6442450944",
    DEPLOYMENT_SESSION_REGISTRY_FILE: "/tmp/sessions.json",
  }), /run\/secrets/);
  assert.throws(() => parseServerDeploymentConfig({
    DEPLOYMENT_ADMISSION_FREE_BYTES: "536870912",
    DEPLOYMENT_ADMISSION_HEADROOM_BYTES: "536870912",
  }), /smaller/);
  assert.throws(() => parseServerDeploymentConfig({
    DEPLOYMENT_ADMISSION_FREE_BYTES: "6442450944",
    DEPLOYMENT_MAX_SPEND_USD_PER_USER_PER_WINDOW: "NaN",
  }), /non-negative decimal/);
  assert.throws(() => parseServerDeploymentConfig({
    DEPLOYMENT_ADMISSION_FREE_BYTES: "6442450944",
    DEPLOYMENT_CONTROL_LEASE_TTL_MS: "600000",
  }), /must exceed/);
});
