type JsonObject = Record<string, unknown>;

export const PINNED_IMAGES = Object.freeze({
  database:
    "pgvector/pgvector:0.8.6-pg18-bookworm@sha256:2ba9ca5f2e7daa0f0e7723cba1ee9167bab54efd3640516a44ac1a928dd67e7a",
  inference:
    "ollama/ollama:0.32.5@sha256:4dea9fb511947e24a84237bb636b0203abcb2ff0d3fbc7b4ff865deb91362131",
  dbmate:
    "ghcr.io/amacneil/dbmate:2.35.0@sha256:e55099476e99559509846f44505d92c92d4861e699de9546a852320a7f667e0d",
  node:
    "node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03",
});

const EXPECTED_SERVICES = [
  "server",
  "database",
  "inference",
  "migrate",
  "model-bootstrap",
  "runtime-check",
  "volume-init",
  "backup",
] as const;
const EXPECTED_VOLUMES = ["database_data", "ollama_models", "attachments", "event_spool"] as const;

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (object(entry) && typeof entry["source"] === "string") return [entry["source"]];
    return [];
  });
}

function serviceNetworks(service: JsonObject): string[] {
  const networks = service["networks"];
  if (Array.isArray(networks)) return networks.filter((item): item is string => typeof item === "string");
  return object(networks) ? Object.keys(networks) : [];
}

function serviceProfiles(service: JsonObject): string[] {
  return Array.isArray(service["profiles"])
    ? service["profiles"].filter((item): item is string => typeof item === "string")
    : [];
}

function hasHealthcheck(service: JsonObject): boolean {
  const healthcheck = service["healthcheck"];
  return object(healthcheck) && Array.isArray(healthcheck["test"]) && healthcheck["test"].length > 1;
}

function dependencyCondition(service: JsonObject, dependency: string): string | undefined {
  const dependsOn = service["depends_on"];
  if (!object(dependsOn)) return undefined;
  const item = dependsOn[dependency];
  return object(item) && typeof item["condition"] === "string" ? item["condition"] : undefined;
}

function environmentEntries(service: JsonObject): Array<[string, unknown]> {
  const environment = service["environment"];
  return object(environment) ? Object.entries(environment) : [];
}

function publishedPorts(service: JsonObject): JsonObject[] {
  return Array.isArray(service["ports"])
    ? service["ports"].filter((entry): entry is JsonObject => object(entry))
    : [];
}

/** Pure fail-closed checks for the rendered P3.1 Compose topology. */
export function validateSingleNodeCompose(value: unknown): readonly string[] {
  const issues: string[] = [];
  if (!object(value)) return ["compose document is not an object"];
  const services = value["services"];
  const networks = value["networks"];
  const volumes = value["volumes"];
  const secrets = value["secrets"];
  if (!object(services)) return ["compose services are missing"];
  if (!object(networks)) issues.push("compose networks are missing");
  if (!object(volumes)) issues.push("compose volumes are missing");
  if (!object(secrets)) issues.push("compose secrets are missing");

  for (const name of EXPECTED_SERVICES) {
    if (!object(services[name])) issues.push(`service ${name} is missing`);
  }
  for (const name of EXPECTED_VOLUMES) {
    if (!object(volumes) || !object(volumes[name])) issues.push(`volume ${name} is missing`);
  }
  if (!object(networks) || !object(networks["data_plane"]) || networks["data_plane"]["internal"] !== true) {
    issues.push("data_plane network must be internal");
  }
  if (!object(networks) || !object(networks["bootstrap_egress"]) || networks["bootstrap_egress"]["internal"] === true) {
    issues.push("bootstrap_egress must be an explicit egress-capable network");
  }

  for (const [name, candidate] of Object.entries(services)) {
    if (!object(candidate)) {
      issues.push(`service ${name} is not an object`);
      continue;
    }
    if (name !== "server" && Array.isArray(candidate["ports"]) && candidate["ports"].length > 0) {
      issues.push(`service ${name} must not publish host ports`);
    }
    for (const [key, secretValue] of environmentEntries(candidate)) {
      if ((key.includes("PASSWORD") || key.includes("KEY")) && !key.endsWith("_FILE")) {
        issues.push(`service ${name} exposes secret-like environment variable ${key}`);
      }
      if (typeof secretValue === "string" && /(^|:\/\/)[^/\s:@]+:[^/\s@]+@/.test(secretValue)) {
        issues.push(`service ${name} embeds credentials in environment variable ${key}`);
      }
    }
    const attachedNetworks = serviceNetworks(candidate);
    if (name === "model-bootstrap") {
      if (attachedNetworks.length !== 1 || attachedNetworks[0] !== "bootstrap_egress") {
        issues.push("model-bootstrap must be the only egress-network workload");
      }
      if (!serviceProfiles(candidate).includes("bootstrap")) issues.push("model-bootstrap must require the bootstrap profile");
    } else if (name === "volume-init") {
      if (candidate["network_mode"] !== "none") issues.push("volume-init must have networking disabled");
    } else if (attachedNetworks.length !== 1 || attachedNetworks[0] !== "data_plane") {
      issues.push(`service ${name} must attach only to data_plane`);
    }
  }

  const database = object(services["database"]) ? services["database"] : {};
  const server = object(services["server"]) ? services["server"] : {};
  const inference = object(services["inference"]) ? services["inference"] : {};
  const migrate = object(services["migrate"]) ? services["migrate"] : {};
  const runtime = object(services["runtime-check"]) ? services["runtime-check"] : {};
  const volumeInit = object(services["volume-init"]) ? services["volume-init"] : {};
  const backup = object(services["backup"]) ? services["backup"] : {};
  const bootstrap = object(services["model-bootstrap"]) ? services["model-bootstrap"] : {};

  const ingress = publishedPorts(server);
  if (
    ingress.length !== 1 || ingress[0]?.["target"] !== 8080 ||
    String(ingress[0]?.["published"]) !== "8080" || ingress[0]?.["host_ip"] !== "127.0.0.1"
  ) {
    issues.push("server must publish exactly loopback host port 8080 to container port 8080");
  }
  if (!hasHealthcheck(server)) issues.push("server healthcheck is missing");
  if (!object(server["build"]) || server["build"]["dockerfile"] !== "Dockerfile") {
    issues.push("server must be built from the root pinned Dockerfile");
  }
  const serverSecrets = strings(server["secrets"]).sort();
  if (serverSecrets.join(",") !== "database_password,session_registry,spool_key") {
    issues.push("server must receive only database, spool, and session-registry secrets");
  }
  const serverVolumes = strings(server["volumes"]);
  if (!serverVolumes.includes("attachments") || !serverVolumes.includes("event_spool")) {
    issues.push("server must mount persistent attachments and event spool volumes");
  }
  if (server["read_only"] !== true || !strings(server["cap_drop"]).includes("ALL")) {
    issues.push("server must use a read-only root and drop all capabilities");
  }
  for (const dependency of ["database", "inference"]) {
    if (dependencyCondition(server, dependency) !== "service_healthy") {
      issues.push(`server must wait for ${dependency} health`);
    }
  }
  for (const dependency of ["migrate", "volume-init"]) {
    if (dependencyCondition(server, dependency) !== "service_completed_successfully") {
      issues.push(`server must wait for successful ${dependency}`);
    }
  }

  if (database["image"] !== PINNED_IMAGES.database) issues.push("database image is not pinned to the approved digest");
  if (inference["image"] !== PINNED_IMAGES.inference) issues.push("inference image is not pinned to the approved digest");
  if (!hasHealthcheck(database)) issues.push("database healthcheck is missing");
  if (!hasHealthcheck(inference)) issues.push("inference healthcheck is missing");
  if (!strings(database["secrets"]).includes("database_password")) issues.push("database lacks its password secret");
  if (strings(database["secrets"]).includes("spool_key")) issues.push("database must not receive the spool key");
  if (!strings(runtime["secrets"]).includes("database_password") || !strings(runtime["secrets"]).includes("spool_key")) {
    issues.push("runtime-check lacks its two required secrets");
  }
  if (strings(migrate["secrets"]).join(",") !== "database_password") {
    issues.push("migrate must receive only the database password secret");
  }
  if (strings(backup["secrets"]).join(",") !== "database_password") {
    issues.push("backup must receive only the database password secret");
  }
  if (!object(migrate["build"]) || migrate["build"]["dockerfile"] !== "deployment/Dockerfile.migrate") {
    issues.push("migrate image build is not the pinned deployment Dockerfile");
  }
  if (!object(bootstrap["build"]) || bootstrap["build"]["dockerfile"] !== "deployment/Dockerfile.ollama-bootstrap") {
    issues.push("model-bootstrap image build is not the pinned deployment Dockerfile");
  }
  for (const service of [runtime, volumeInit, server]) {
    if (!object(service["build"]) || service["build"]["dockerfile"] !== "Dockerfile") {
      issues.push("runtime workload is not built from the root pinned Dockerfile");
    }
  }
  if (dependencyCondition(migrate, "database") !== "service_healthy") {
    issues.push("migrate must wait for database health");
  }
  if (dependencyCondition(runtime, "migrate") !== "service_completed_successfully") {
    issues.push("runtime-check must wait for successful migrations");
  }
  if (dependencyCondition(runtime, "volume-init") !== "service_completed_successfully") {
    issues.push("runtime-check must wait for volume ownership initialization");
  }
  if (dependencyCondition(runtime, "inference") !== "service_healthy") {
    issues.push("runtime-check must wait for inference health");
  }
  if (!serviceProfiles(backup).includes("ops")) issues.push("backup must require the ops profile");

  return issues;
}
