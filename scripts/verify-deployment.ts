import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { PINNED_IMAGES, validateSingleNodeCompose } from "../src/deployment/compose-policy.ts";

const execute = promisify(execFile);

const { stdout } = await execute(
  "docker",
  ["compose", "--file", "compose.yaml", "--profile", "*", "config", "--format", "json"],
  {
  cwd: process.cwd(),
  env: {
    ...process.env,
    SOVEREIGN_UID: "1000",
    SOVEREIGN_GID: "1000",
    DEPLOYMENT_ADMISSION_FREE_BYTES: "6442450944",
  },
  maxBuffer: 8 * 1024 * 1024,
  },
);
const manifest = JSON.parse(stdout) as unknown;
const issues = validateSingleNodeCompose(manifest);
assert.deepEqual(issues, [], `deployment manifest rejected:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);

const [runtimeDockerfile, migrationDockerfile, bootstrapDockerfile] = await Promise.all([
  readFile("Dockerfile", "utf8"),
  readFile("deployment/Dockerfile.migrate", "utf8"),
  readFile("deployment/Dockerfile.ollama-bootstrap", "utf8"),
]);
assert.match(runtimeDockerfile, new RegExp(`^FROM ${PINNED_IMAGES.node.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"));
assert.match(migrationDockerfile, new RegExp(`^FROM ${PINNED_IMAGES.dbmate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"));
assert.match(bootstrapDockerfile, new RegExp(`^FROM ${PINNED_IMAGES.inference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"));
for (const [name, dockerfile] of Object.entries({ runtimeDockerfile, migrationDockerfile, bootstrapDockerfile })) {
  assert.doesNotMatch(dockerfile, /^FROM .*:latest(?:\s|$)/m, `${name} uses a mutable latest tag`);
  assert.match(dockerfile, /^FROM .*@sha256:[a-f0-9]{64}(?:\s|$)/m, `${name} lacks an immutable base digest`);
}

console.log(JSON.stringify({
  schemaVersion: 1,
  status: "passed",
  checks: [
    "compose-rendered",
    "internal-data-plane",
    "one-loopback-authenticated-ingress",
    "one-shot-bootstrap-egress",
    "least-privilege-secrets",
    "health-and-migration-order",
    "persistent-volumes",
    "immutable-upstream-images",
  ],
}, null, 2));
