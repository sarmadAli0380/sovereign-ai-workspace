/**
 * A0-M.1 — product-owned model capability records.
 *
 * Configured claims and live observations are deliberately different
 * objects. A provider advertisement or deployment config is useful input,
 * but it is not evidence that a capability is currently served. Route
 * assessment therefore fails closed when the live observation is missing,
 * stale, unhealthy, not ready, or does not satisfy a requirement.
 */

import { cloneData } from "../clone-data.ts";
import { collectJsonValueIssues } from "../json.ts";

export const MODEL_CAPABILITY_SCHEMA_VERSION = 1 as const;

export type CapabilitySupport = "supported" | "unsupported" | "unknown";
export type ModelFeature =
  | "tools"
  | "images"
  | "thinking"
  | "structuredOutput"
  | "streaming";
export type ReportingCapability = "usage" | "cache";

export interface DeclaredCapabilityProvenance {
  kind: "configuration" | "provider-metadata";
  source: string;
  recordedAt: string;
}

export interface ObservedCapabilityProvenance {
  kind: "live-probe";
  source: string;
  verifiedAt: string;
}

export interface ModelIdentity {
  provider: string;
  model: string;
  digest?: string;
  quantization?: string;
}

export interface FeatureCapabilities {
  tools: CapabilitySupport;
  images: CapabilitySupport;
  thinking: CapabilitySupport;
  structuredOutput: CapabilitySupport;
  streaming: CapabilitySupport;
}

export interface ReportingCapabilities {
  usage: CapabilitySupport;
  cache: CapabilitySupport;
}

export interface DeclaredModelCapabilities {
  identity: ModelIdentity;
  api: string;
  transport: string;
  contextWindow: number;
  outputLimit: {
    tokens: number;
    honored: CapabilitySupport;
  };
  features: FeatureCapabilities;
  reporting: ReportingCapabilities;
  provenance: DeclaredCapabilityProvenance;
}

export interface ObservedModelCapabilities {
  identity: ModelIdentity;
  api: string;
  transport: string;
  servedContextWindow: number;
  outputLimitHonored: CapabilitySupport;
  features: FeatureCapabilities;
  reporting: ReportingCapabilities;
  health: "healthy" | "degraded" | "unavailable" | "unknown";
  readiness: "ready" | "not-ready" | "unknown";
  provenance: ObservedCapabilityProvenance;
}

export interface ModelCapabilityRecordV1 {
  schemaVersion: typeof MODEL_CAPABILITY_SCHEMA_VERSION;
  recordId: string;
  configKey: string;
  declared: DeclaredModelCapabilities;
  observed?: ObservedModelCapabilities;
}

export type ModelCapabilityRecord = ModelCapabilityRecordV1;

export class ModelCapabilityRecordError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid model capability record:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "ModelCapabilityRecordError";
    this.issues = [...issues];
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: string[],
): void {
  const known = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) issues.push(`${path}.${key}: unknown field`);
  }
}

function nonEmptyString(value: unknown, path: string, issues: string[]): value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(`${path}: must be a non-empty string`);
    return false;
  }
  return true;
}

function positiveWhole(value: unknown, path: string, issues: string[]): value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    issues.push(`${path}: must be a finite positive whole number`);
    return false;
  }
  return true;
}

function timestamp(value: unknown, path: string, issues: string[]): value is string {
  if (!nonEmptyString(value, path, issues)) return false;
  const parsed = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(parsed)) {
    issues.push(`${path}: must be an absolute ISO-8601 UTC timestamp`);
    return false;
  }
  return true;
}

const SUPPORT = new Set<CapabilitySupport>(["supported", "unsupported", "unknown"]);

function support(value: unknown, path: string, issues: string[]): void {
  if (typeof value !== "string" || !SUPPORT.has(value as CapabilitySupport)) {
    issues.push(`${path}: must be supported, unsupported, or unknown`);
  }
}

function validateIdentity(value: unknown, path: string, issues: string[]): void {
  if (!isObject(value)) {
    issues.push(`${path}: must be an object`);
    return;
  }
  rejectUnknown(value, ["provider", "model", "digest", "quantization"], path, issues);
  nonEmptyString(value["provider"], `${path}.provider`, issues);
  nonEmptyString(value["model"], `${path}.model`, issues);
  for (const field of ["digest", "quantization"] as const) {
    if (value[field] !== undefined) nonEmptyString(value[field], `${path}.${field}`, issues);
  }
}

function validateFeatureMap(value: unknown, path: string, issues: string[]): void {
  const fields: ModelFeature[] = ["tools", "images", "thinking", "structuredOutput", "streaming"];
  if (!isObject(value)) {
    issues.push(`${path}: must be an object`);
    return;
  }
  rejectUnknown(value, fields, path, issues);
  for (const field of fields) support(value[field], `${path}.${field}`, issues);
}

function validateReporting(value: unknown, path: string, issues: string[]): void {
  const fields: ReportingCapability[] = ["usage", "cache"];
  if (!isObject(value)) {
    issues.push(`${path}: must be an object`);
    return;
  }
  rejectUnknown(value, fields, path, issues);
  for (const field of fields) support(value[field], `${path}.${field}`, issues);
}

function validateDeclared(value: unknown, issues: string[]): void {
  const path = "record.declared";
  if (!isObject(value)) {
    issues.push(`${path}: must be an object`);
    return;
  }
  rejectUnknown(
    value,
    ["identity", "api", "transport", "contextWindow", "outputLimit", "features", "reporting", "provenance"],
    path,
    issues,
  );
  validateIdentity(value["identity"], `${path}.identity`, issues);
  nonEmptyString(value["api"], `${path}.api`, issues);
  nonEmptyString(value["transport"], `${path}.transport`, issues);
  positiveWhole(value["contextWindow"], `${path}.contextWindow`, issues);
  if (!isObject(value["outputLimit"])) {
    issues.push(`${path}.outputLimit: must be an object`);
  } else {
    rejectUnknown(value["outputLimit"], ["tokens", "honored"], `${path}.outputLimit`, issues);
    positiveWhole(value["outputLimit"]["tokens"], `${path}.outputLimit.tokens`, issues);
    support(value["outputLimit"]["honored"], `${path}.outputLimit.honored`, issues);
    if (
      typeof value["contextWindow"] === "number" &&
      typeof value["outputLimit"]["tokens"] === "number" &&
      value["outputLimit"]["tokens"] > value["contextWindow"]
    ) {
      issues.push(`${path}.outputLimit.tokens: cannot exceed the declared context window`);
    }
  }
  validateFeatureMap(value["features"], `${path}.features`, issues);
  validateReporting(value["reporting"], `${path}.reporting`, issues);
  const provenance = value["provenance"];
  if (!isObject(provenance)) {
    issues.push(`${path}.provenance: must be an object`);
  } else {
    rejectUnknown(provenance, ["kind", "source", "recordedAt"], `${path}.provenance`, issues);
    if (provenance["kind"] !== "configuration" && provenance["kind"] !== "provider-metadata") {
      issues.push(`${path}.provenance.kind: must be configuration or provider-metadata`);
    }
    nonEmptyString(provenance["source"], `${path}.provenance.source`, issues);
    timestamp(provenance["recordedAt"], `${path}.provenance.recordedAt`, issues);
  }
}

function validateObserved(value: unknown, issues: string[]): void {
  const path = "record.observed";
  if (!isObject(value)) {
    issues.push(`${path}: must be an object`);
    return;
  }
  rejectUnknown(
    value,
    [
      "identity", "api", "transport", "servedContextWindow", "outputLimitHonored",
      "features", "reporting", "health", "readiness", "provenance",
    ],
    path,
    issues,
  );
  validateIdentity(value["identity"], `${path}.identity`, issues);
  nonEmptyString(value["api"], `${path}.api`, issues);
  nonEmptyString(value["transport"], `${path}.transport`, issues);
  positiveWhole(value["servedContextWindow"], `${path}.servedContextWindow`, issues);
  support(value["outputLimitHonored"], `${path}.outputLimitHonored`, issues);
  validateFeatureMap(value["features"], `${path}.features`, issues);
  validateReporting(value["reporting"], `${path}.reporting`, issues);
  if (!["healthy", "degraded", "unavailable", "unknown"].includes(String(value["health"]))) {
    issues.push(`${path}.health: must be healthy, degraded, unavailable, or unknown`);
  }
  if (!["ready", "not-ready", "unknown"].includes(String(value["readiness"]))) {
    issues.push(`${path}.readiness: must be ready, not-ready, or unknown`);
  }
  const provenance = value["provenance"];
  if (!isObject(provenance)) {
    issues.push(`${path}.provenance: must be an object`);
  } else {
    rejectUnknown(provenance, ["kind", "source", "verifiedAt"], `${path}.provenance`, issues);
    if (provenance["kind"] !== "live-probe") {
      issues.push(`${path}.provenance.kind: must be live-probe`);
    }
    nonEmptyString(provenance["source"], `${path}.provenance.source`, issues);
    timestamp(provenance["verifiedAt"], `${path}.provenance.verifiedAt`, issues);
  }
}

/** Validate an untrusted persisted/public capability record. */
export function parseModelCapabilityRecord(raw: unknown): ModelCapabilityRecord {
  const issues: string[] = [];
  if (!isObject(raw)) throw new ModelCapabilityRecordError(["record: must be an object"]);
  collectJsonValueIssues(raw, "record", issues);
  rejectUnknown(raw, ["schemaVersion", "recordId", "configKey", "declared", "observed"], "record", issues);
  if (raw["schemaVersion"] !== MODEL_CAPABILITY_SCHEMA_VERSION) {
    issues.push(`record.schemaVersion: expected ${MODEL_CAPABILITY_SCHEMA_VERSION}`);
  }
  nonEmptyString(raw["recordId"], "record.recordId", issues);
  nonEmptyString(raw["configKey"], "record.configKey", issues);
  validateDeclared(raw["declared"], issues);
  if (raw["observed"] !== undefined) validateObserved(raw["observed"], issues);

  if (isObject(raw["declared"]) && isObject(raw["declared"]["identity"]) && isObject(raw["observed"])) {
    const declaredIdentity = raw["declared"]["identity"];
    const observedIdentity = raw["observed"]["identity"];
    if (isObject(observedIdentity)) {
      for (const field of ["provider", "model"] as const) {
        if (declaredIdentity[field] !== observedIdentity[field]) {
          issues.push(`record.observed.identity.${field}: does not match the declared identity`);
        }
      }
      for (const field of ["digest", "quantization"] as const) {
        if (declaredIdentity[field] !== undefined && observedIdentity[field] !== declaredIdentity[field]) {
          issues.push(`record.observed.identity.${field}: does not match the declared ${field}`);
        }
      }
    }
  }

  if (issues.length > 0) throw new ModelCapabilityRecordError(issues);
  return cloneData(raw) as unknown as ModelCapabilityRecord;
}

export interface ModelRouteRequirements {
  features?: readonly ModelFeature[];
  reporting?: readonly ReportingCapability[];
  minimumServedContext?: number;
  outputLimitHonored?: boolean;
}

export interface ModelRouteAssessment {
  observation: "fresh" | "stale" | "missing";
  routable: boolean;
  reasons: readonly string[];
  verifiedAt?: string;
  ageMs?: number;
}

/**
 * Fail-closed route assessment over live evidence.
 *
 * This does not select a model. It is the deterministic gate a future
 * controller must pass before using capability data for routing.
 */
export function assessModelRoute(
  record: ModelCapabilityRecord,
  options: {
    now: Date;
    maxObservationAgeMs: number;
    requirements?: ModelRouteRequirements;
  },
): ModelRouteAssessment {
  if (!Number.isFinite(options.now.getTime())) throw new Error("now must be a valid Date");
  if (
    !Number.isFinite(options.maxObservationAgeMs) ||
    !Number.isInteger(options.maxObservationAgeMs) ||
    options.maxObservationAgeMs <= 0
  ) {
    throw new Error("maxObservationAgeMs must be a finite positive whole number");
  }

  // A TypeScript annotation is not a runtime trust boundary. Re-validate so
  // a caller cannot bypass provenance/freshness checks with a cast or a
  // mutated persisted value.
  const observed = parseModelCapabilityRecord(record).observed;
  if (!observed) {
    return { observation: "missing", routable: false, reasons: ["live observation is missing"] };
  }

  const verifiedAtMs = Date.parse(observed.provenance.verifiedAt);
  const ageMs = options.now.getTime() - verifiedAtMs;
  const reasons: string[] = [];
  const stale = ageMs < 0 || ageMs > options.maxObservationAgeMs;
  if (stale) reasons.push(ageMs < 0 ? "verification time is in the future" : "live observation is stale");
  if (observed.health !== "healthy") reasons.push(`health is ${observed.health}`);
  if (observed.readiness !== "ready") reasons.push(`readiness is ${observed.readiness}`);

  const requirements = options.requirements ?? {};
  for (const feature of requirements.features ?? []) {
    if (observed.features[feature] !== "supported") {
      reasons.push(`required feature ${feature} is ${observed.features[feature]}`);
    }
  }
  for (const reporting of requirements.reporting ?? []) {
    if (observed.reporting[reporting] !== "supported") {
      reasons.push(`required reporting ${reporting} is ${observed.reporting[reporting]}`);
    }
  }
  if (requirements.minimumServedContext !== undefined) {
    if (
      !Number.isFinite(requirements.minimumServedContext) ||
      !Number.isInteger(requirements.minimumServedContext) ||
      requirements.minimumServedContext <= 0
    ) {
      throw new Error("minimumServedContext must be a finite positive whole number");
    }
    if (observed.servedContextWindow < requirements.minimumServedContext) {
      reasons.push(
        `served context ${observed.servedContextWindow} is below required ${requirements.minimumServedContext}`,
      );
    }
  }
  if (requirements.outputLimitHonored && observed.outputLimitHonored !== "supported") {
    reasons.push(`output-limit behavior is ${observed.outputLimitHonored}`);
  }

  return {
    observation: stale ? "stale" : "fresh",
    routable: reasons.length === 0,
    reasons,
    verifiedAt: observed.provenance.verifiedAt,
    ageMs,
  };
}
