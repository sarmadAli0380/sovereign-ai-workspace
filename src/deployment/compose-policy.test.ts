import assert from "node:assert/strict";
import test from "node:test";
import { PINNED_IMAGES, validateSingleNodeCompose } from "./compose-policy.ts";

function manifest(): Record<string, unknown> {
  const build = (dockerfile: string) => ({ context: ".", dockerfile });
  return {
    services: {
      server: {
        build: build("Dockerfile"),
        networks: ["data_plane"],
        ports: [{ target: 8080, published: "8080", host_ip: "127.0.0.1" }],
        secrets: [
          { source: "database_password" },
          { source: "spool_key" },
          { source: "session_registry" },
        ],
        volumes: [{ source: "attachments" }, { source: "event_spool" }],
        read_only: true,
        cap_drop: ["ALL"],
        healthcheck: { test: ["CMD", "node"] },
        depends_on: {
          database: { condition: "service_healthy" },
          inference: { condition: "service_healthy" },
          migrate: { condition: "service_completed_successfully" },
          "volume-init": { condition: "service_completed_successfully" },
        },
      },
      database: {
        image: PINNED_IMAGES.database,
        networks: ["data_plane"],
        secrets: [{ source: "database_password" }],
        environment: { POSTGRES_PASSWORD_FILE: "/run/secrets/database_password" },
        healthcheck: { test: ["CMD-SHELL", "pg_isready"] },
      },
      inference: {
        image: PINNED_IMAGES.inference,
        networks: ["data_plane"],
        healthcheck: { test: ["CMD", "ollama", "list"] },
      },
      migrate: {
        build: build("deployment/Dockerfile.migrate"), networks: ["data_plane"],
        secrets: [{ source: "database_password" }],
        depends_on: { database: { condition: "service_healthy" } },
      },
      "model-bootstrap": {
        build: build("deployment/Dockerfile.ollama-bootstrap"), networks: ["bootstrap_egress"], profiles: ["bootstrap"],
      },
      "runtime-check": {
        build: build("Dockerfile"), networks: ["data_plane"],
        secrets: [{ source: "database_password" }, { source: "spool_key" }],
        depends_on: {
          migrate: { condition: "service_completed_successfully" },
          "volume-init": { condition: "service_completed_successfully" },
          inference: { condition: "service_healthy" },
        },
      },
      "volume-init": { build: build("Dockerfile"), network_mode: "none" },
      backup: {
        image: PINNED_IMAGES.database, networks: ["data_plane"], profiles: ["ops"],
        secrets: [{ source: "database_password" }],
      },
    },
    networks: { data_plane: { internal: true }, bootstrap_egress: {} },
    volumes: { database_data: {}, ollama_models: {}, attachments: {}, event_spool: {} },
    secrets: {
      database_password: { file: "x" }, spool_key: { file: "y" }, session_registry: { file: "z" },
    },
  };
}

test("P3.1 Compose policy accepts the frozen single-node trust topology", () => {
  assert.deepEqual(validateSingleNodeCompose(manifest()), []);
});

test("P3.1 Compose policy negative control catches egress, host ports, mutable images, and secret env", () => {
  const candidate = manifest();
  const services = candidate.services as Record<string, Record<string, unknown>>;
  services.database!.image = "pgvector/pgvector:latest";
  services.database!.ports = ["5432:5432"];
  services.inference!.networks = ["bootstrap_egress"];
  services["runtime-check"]!.environment = { DEPLOYMENT_DATABASE_PASSWORD: "leaked" };
  const issues = validateSingleNodeCompose(candidate);
  assert.ok(issues.some((issue) => issue.includes("publish host ports")));
  assert.ok(issues.some((issue) => issue.includes("not pinned")));
  assert.ok(issues.some((issue) => issue.includes("must attach only")));
  assert.ok(issues.some((issue) => issue.includes("secret-like")));
});

test("C2 Compose policy rejects a second ingress and an over-privileged server", () => {
  const candidate = manifest();
  const services = candidate.services as Record<string, Record<string, unknown>>;
  services.inference!.ports = [{ target: 11434, published: "11434" }];
  services.server!.read_only = false;
  services.server!.secrets = [{ source: "database_password" }];
  const issues = validateSingleNodeCompose(candidate);
  assert.ok(issues.some((issue) => issue.includes("inference must not publish")));
  assert.ok(issues.some((issue) => issue.includes("read-only root")));
  assert.ok(issues.some((issue) => issue.includes("session-registry")));
});
