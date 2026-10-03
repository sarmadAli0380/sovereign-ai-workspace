import { projectRunEvent, type AudienceRunEvent } from "./event-projections.ts";
import { parseRunEvent, type RunEvent } from "./events.ts";

export const RESIDENCY_INVENTORY_SCHEMA_VERSION = 1 as const;

export const RESIDENCY_STORE_IDS = [
  "database",
  "object-storage",
  "embeddings",
  "indexes",
  "logs",
  "caches",
  "temp-files",
  "backups",
  "telemetry",
] as const;

export type ResidencyStoreId = (typeof RESIDENCY_STORE_IDS)[number];
export type ResidencyStoreState =
  | "implemented"
  | "not-implemented"
  | "deployment-provided"
  | "optional-disabled-by-default";
export type ResidencyContentMode = "content-bearing" | "derived-content" | "metadata-only";

export interface ResidencyStore {
  id: ResidencyStoreId;
  state: ResidencyStoreState;
  location: string;
  contentMode: ResidencyContentMode;
  dataClasses: readonly string[];
  egress: string;
  encryption: string;
  retention: string;
  erasure: string;
}

export interface ResidencyInventory {
  schemaVersion: typeof RESIDENCY_INVENTORY_SCHEMA_VERSION;
  deploymentBoundary: string;
  defaultExternalTelemetry: false;
  recovery: {
    rpoMinutes: number;
    rtoMinutes: number;
    restoreDrillCadenceDays: number;
    backupRetentionDays: number;
    restoreMode: "isolated-then-reconciled";
  };
  physicalErasure: {
    database: string;
    backups: string;
    cryptographicBoundary: string;
  };
  stores: readonly ResidencyStore[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown, path: string, issues: string[]): value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(`${path}: must be a non-empty string`);
    return false;
  }
  return true;
}

function positiveInteger(value: unknown, path: string, issues: string[]): value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    issues.push(`${path}: must be a positive safe integer`);
    return false;
  }
  return true;
}

function unknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: string[],
): void {
  const expected = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) issues.push(`${path}.${key}: unknown field`);
  }
}

function collectStoreIssues(value: unknown, index: number, issues: string[]): void {
  const path = `inventory.stores[${index}]`;
  if (!isObject(value)) {
    issues.push(`${path}: must be an object`);
    return;
  }
  const expected = new Set([
    "id", "state", "location", "contentMode", "dataClasses",
    "egress", "encryption", "retention", "erasure",
  ]);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) issues.push(`${path}.${key}: unknown field`);
  }
  if (!RESIDENCY_STORE_IDS.includes(value["id"] as ResidencyStoreId)) {
    issues.push(`${path}.id: unknown residency store`);
  }
  if (!new Set<unknown>([
    "implemented",
    "not-implemented",
    "deployment-provided",
    "optional-disabled-by-default",
  ]).has(value["state"])) {
    issues.push(`${path}.state: unknown state`);
  }
  if (!new Set<unknown>(["content-bearing", "derived-content", "metadata-only"]).has(value["contentMode"])) {
    issues.push(`${path}.contentMode: unknown content mode`);
  }
  for (const field of ["location", "egress", "encryption", "retention", "erasure"] as const) {
    nonEmpty(value[field], `${path}.${field}`, issues);
  }
  if (!Array.isArray(value["dataClasses"]) || value["dataClasses"].length === 0) {
    issues.push(`${path}.dataClasses: must be a non-empty array`);
  } else {
    const classes = value["dataClasses"];
    classes.forEach((item, itemIndex) => nonEmpty(item, `${path}.dataClasses[${itemIndex}]`, issues));
    if (new Set(classes).size !== classes.length) {
      issues.push(`${path}.dataClasses: must not contain duplicates`);
    }
  }
}

export function collectResidencyInventoryIssues(value: unknown): string[] {
  const issues: string[] = [];
  if (!isObject(value)) return ["inventory: must be an object"];
  const expected = new Set([
    "schemaVersion",
    "deploymentBoundary",
    "defaultExternalTelemetry",
    "recovery",
    "physicalErasure",
    "stores",
  ]);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) issues.push(`inventory.${key}: unknown field`);
  }
  if (value["schemaVersion"] !== RESIDENCY_INVENTORY_SCHEMA_VERSION) {
    issues.push(`inventory.schemaVersion: must be ${RESIDENCY_INVENTORY_SCHEMA_VERSION}`);
  }
  nonEmpty(value["deploymentBoundary"], "inventory.deploymentBoundary", issues);
  if (value["defaultExternalTelemetry"] !== false) {
    issues.push("inventory.defaultExternalTelemetry: must be false");
  }

  const recovery = value["recovery"];
  if (!isObject(recovery)) {
    issues.push("inventory.recovery: must be an object");
  } else {
    unknownKeys(
      recovery,
      ["rpoMinutes", "rtoMinutes", "restoreDrillCadenceDays", "backupRetentionDays", "restoreMode"],
      "inventory.recovery",
      issues,
    );
    positiveInteger(recovery["rpoMinutes"], "inventory.recovery.rpoMinutes", issues);
    positiveInteger(recovery["rtoMinutes"], "inventory.recovery.rtoMinutes", issues);
    positiveInteger(recovery["restoreDrillCadenceDays"], "inventory.recovery.restoreDrillCadenceDays", issues);
    positiveInteger(recovery["backupRetentionDays"], "inventory.recovery.backupRetentionDays", issues);
    if (recovery["restoreMode"] !== "isolated-then-reconciled") {
      issues.push("inventory.recovery.restoreMode: must be isolated-then-reconciled");
    }
    if (recovery["rpoMinutes"] !== 15) issues.push("inventory.recovery.rpoMinutes: B0 fixed this at 15");
    if (recovery["rtoMinutes"] !== 240) issues.push("inventory.recovery.rtoMinutes: B0 fixed this at 240");
  }

  const physical = value["physicalErasure"];
  if (!isObject(physical)) {
    issues.push("inventory.physicalErasure: must be an object");
  } else {
    unknownKeys(
      physical,
      ["database", "backups", "cryptographicBoundary"],
      "inventory.physicalErasure",
      issues,
    );
    nonEmpty(physical["database"], "inventory.physicalErasure.database", issues);
    nonEmpty(physical["backups"], "inventory.physicalErasure.backups", issues);
    nonEmpty(physical["cryptographicBoundary"], "inventory.physicalErasure.cryptographicBoundary", issues);
  }

  const stores = value["stores"];
  if (!Array.isArray(stores)) {
    issues.push("inventory.stores: must be an array");
  } else {
    stores.forEach((store, index) => collectStoreIssues(store, index, issues));
    const ids = stores.flatMap((store) => isObject(store) && typeof store["id"] === "string" ? [store["id"]] : []);
    for (const required of RESIDENCY_STORE_IDS) {
      const count = ids.filter((id) => id === required).length;
      if (count !== 1) issues.push(`inventory.stores: ${required} must appear exactly once`);
    }
    for (const store of stores) {
      if (!isObject(store)) continue;
      if ((store["id"] === "logs" || store["id"] === "telemetry") && store["contentMode"] !== "metadata-only") {
        issues.push(`inventory.stores.${String(store["id"])}: must be metadata-only`);
      }
    }
  }
  return issues;
}

export class ResidencyInventoryValidationError extends TypeError {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`invalid residency inventory: ${issues.join("; ")}`);
    this.name = "ResidencyInventoryValidationError";
    this.issues = [...issues];
  }
}

export function parseResidencyInventory(value: unknown): ResidencyInventory {
  const issues = collectResidencyInventoryIssues(value);
  if (issues.length > 0) throw new ResidencyInventoryValidationError(issues);
  return structuredClone(value) as ResidencyInventory;
}

/** Serialize only the allowlisted operational event projection. */
export function operationalLogLine(value: RunEvent): string {
  const event = parseRunEvent(value);
  const projected = projectRunEvent(event, "operational") as AudienceRunEvent<"operational">;
  if (projected.sensitivity !== "metadata") {
    throw new TypeError("operational log projection must be metadata-only");
  }
  return JSON.stringify(projected);
}

export class EgressDeniedError extends Error {
  readonly code = "egress.denied";

  constructor(message: string) {
    super(message);
    this.name = "EgressDeniedError";
  }
}

function normalizeAllowedOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (cause) {
    throw new TypeError("allowed egress origin must be an absolute URL", { cause });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("allowed egress origin must use http or https");
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new TypeError("allowed egress origin must contain only scheme, host, and optional port");
  }
  return parsed.origin;
}

/**
 * Exact-origin guard for deployments that must operate without public egress.
 * Network adapters receive `fetch`; they do not get ambient authority to call
 * another origin or follow an unchecked redirect.
 */
export class AirGappedEgressGuard {
  readonly #allowedOrigins: ReadonlySet<string>;

  constructor(allowedOrigins: readonly string[]) {
    if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
      throw new TypeError("at least one explicit air-gapped origin is required");
    }
    const normalized = allowedOrigins.map(normalizeAllowedOrigin);
    if (new Set(normalized).size !== normalized.length) {
      throw new TypeError("allowed egress origins must not contain duplicates");
    }
    this.#allowedOrigins = new Set(normalized);
  }

  assertAllowed(value: string | URL): URL {
    let url: URL;
    try {
      url = value instanceof URL ? new URL(value.href) : new URL(value);
    } catch {
      throw new EgressDeniedError("egress URL must be absolute");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new EgressDeniedError("egress scheme is not allowed");
    }
    if (url.username || url.password) throw new EgressDeniedError("egress URL credentials are not allowed");
    if (!this.#allowedOrigins.has(url.origin)) {
      throw new EgressDeniedError(`egress origin is outside the deployment allowlist: ${url.origin}`);
    }
    return url;
  }

  guardedFetch(delegate: typeof fetch = globalThis.fetch): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const raw = input instanceof Request ? input.url : input;
      const url = this.assertAllowed(raw);
      const response = await delegate(input instanceof Request ? input : url, { ...init, redirect: "manual" });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location) this.assertAllowed(new URL(location, url));
        throw new EgressDeniedError("redirects are disabled at the air-gapped egress boundary");
      }
      return response;
    }) as typeof fetch;
  }
}
