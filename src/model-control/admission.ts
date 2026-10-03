/** A0-M.2 — deterministic local inference admission and load coordination. */

import { randomUUID } from "node:crypto";
import { assessModelRoute, type ModelCapabilityRecord, type ModelRouteRequirements } from "./capabilities.ts";
import { estimateMemory, fitsIn, type ModelGeometry, type SizingEstimate } from "../sizing.ts";

export type LocalModelState = "cold" | "loading" | "ready" | "busy" | "degraded";
export type AdmissionOutcome = "admitted" | "queued" | "rejected";

export interface RunningLocalModel {
  modelId: string;
  digest?: string;
  quantization?: string;
  servedContextWindow: number;
  residentBytes: number;
  acceleratorBytes?: number;
  expiresAt?: string;
}

export interface LocalRuntimeSnapshot {
  runtimeId: string;
  observedAt: string;
  freeMemoryBytes: number;
  memorySource: string;
  models: readonly RunningLocalModel[];
  issues: readonly string[];
}

export interface LocalRuntimeAdapter {
  readonly runtimeId: string;
  inspect(signal?: AbortSignal): Promise<LocalRuntimeSnapshot>;
  load(request: { modelId: string; contextWindow: number; signal: AbortSignal }): Promise<void>;
}

export interface LocalAdmissionPolicy {
  maxResidentModels: number;
  maxConcurrentSequences: number;
  /** Additional deployment reserve. `fitsIn` also preserves llama.cpp's measured 1 GiB reserve. */
  deploymentHeadroomBytes: number;
  maxCapabilityObservationAgeMs: number;
  loadTimeoutMs: number;
  capacityAction: "reject" | "queue";
}

export interface LocalAdmissionRequest {
  capabilityRecord: ModelCapabilityRecord;
  requirements?: ModelRouteRequirements;
  geometry: ModelGeometry;
  weightsBytes?: number;
  bitsPerWeight?: number;
  kvCacheBits?: number;
}

export interface LocalAdmissionResult {
  outcome: AdmissionOutcome;
  state: LocalModelState;
  modelId: string;
  reasons: readonly string[];
  admissionId?: string;
  estimate?: SizingEstimate;
  snapshot: LocalRuntimeSnapshot;
}

export interface LocalModelStatus {
  state: LocalModelState;
  modelId: string;
  reasons: readonly string[];
  activeSequences: number;
  snapshot: LocalRuntimeSnapshot;
}

function positiveWhole(name: string, value: number): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a finite positive whole number`);
  }
}

function validatePolicy(policy: LocalAdmissionPolicy): void {
  positiveWhole("maxResidentModels", policy.maxResidentModels);
  positiveWhole("maxConcurrentSequences", policy.maxConcurrentSequences);
  positiveWhole("maxCapabilityObservationAgeMs", policy.maxCapabilityObservationAgeMs);
  positiveWhole("loadTimeoutMs", policy.loadTimeoutMs);
  if (!Number.isFinite(policy.deploymentHeadroomBytes) || policy.deploymentHeadroomBytes < 0) {
    throw new Error("deploymentHeadroomBytes must be a finite non-negative number");
  }
  if (policy.capacityAction !== "reject" && policy.capacityAction !== "queue") {
    throw new Error("capacityAction must be reject or queue");
  }
}

function validateSnapshot(snapshot: LocalRuntimeSnapshot, runtimeId: string): string[] {
  const issues = [...snapshot.issues];
  if (snapshot.runtimeId !== runtimeId) issues.push("runtime snapshot identity changed");
  if (!Number.isFinite(Date.parse(snapshot.observedAt))) issues.push("runtime observation time is invalid");
  if (!Number.isFinite(snapshot.freeMemoryBytes) || snapshot.freeMemoryBytes < 0) {
    issues.push("runtime free memory is not a finite non-negative number");
  }
  if (!snapshot.memorySource.trim()) issues.push("runtime memory source is missing");
  const identities = new Set<string>();
  for (const model of snapshot.models) {
    const identity = `${model.modelId}\u0000${model.digest ?? ""}`;
    if (identities.has(identity)) issues.push(`runtime reports duplicate model ${model.modelId}`);
    identities.add(identity);
    if (!model.modelId.trim()) issues.push("runtime reports a blank model id");
    if (!Number.isFinite(model.servedContextWindow) || !Number.isInteger(model.servedContextWindow) || model.servedContextWindow <= 0) {
      issues.push(`runtime model ${model.modelId} has an invalid served context`);
    }
    if (!Number.isFinite(model.residentBytes) || model.residentBytes <= 0) {
      issues.push(`runtime model ${model.modelId} has invalid resident bytes`);
    }
    if (model.acceleratorBytes !== undefined && (!Number.isFinite(model.acceleratorBytes) || model.acceleratorBytes < 0)) {
      issues.push(`runtime model ${model.modelId} has invalid accelerator bytes`);
    }
  }
  return issues;
}

function capacityResult(policy: LocalAdmissionPolicy): Pick<LocalAdmissionResult, "outcome" | "state"> {
  return policy.capacityAction === "queue"
    ? { outcome: "queued", state: "busy" }
    : { outcome: "rejected", state: "busy" };
}

export class LocalModelController {
  readonly #adapter: LocalRuntimeAdapter;
  readonly #policy: LocalAdmissionPolicy;
  readonly #now: () => Date;
  readonly #activeAdmissions = new Map<string, string>();
  readonly #activeByModel = new Map<string, number>();
  readonly #loading = new Set<string>();
  #serial: Promise<void> = Promise.resolve();

  constructor(adapter: LocalRuntimeAdapter, policy: LocalAdmissionPolicy, now: () => Date = () => new Date()) {
    validatePolicy(policy);
    this.#adapter = adapter;
    this.#policy = { ...policy };
    this.#now = now;
  }

  async #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#serial;
    let release!: () => void;
    this.#serial = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  #admit(modelId: string, snapshot: LocalRuntimeSnapshot, estimate?: SizingEstimate): LocalAdmissionResult {
    const admissionId = randomUUID();
    this.#activeAdmissions.set(admissionId, modelId);
    this.#activeByModel.set(modelId, (this.#activeByModel.get(modelId) ?? 0) + 1);
    return {
      outcome: "admitted",
      state: (this.#activeByModel.get(modelId) ?? 0) >= this.#policy.maxConcurrentSequences ? "busy" : "ready",
      modelId,
      reasons: [],
      admissionId,
      ...(estimate ? { estimate } : {}),
      snapshot,
    };
  }

  async admit(request: LocalAdmissionRequest): Promise<LocalAdmissionResult> {
    return this.#serialized(async () => {
      const now = this.#now();
      const declared = request.capabilityRecord.declared;
      const modelId = declared.identity.model;
      const requestedContext = declared.contextWindow;
      const route = assessModelRoute(request.capabilityRecord, {
        now,
        maxObservationAgeMs: this.#policy.maxCapabilityObservationAgeMs,
        requirements: {
          ...request.requirements,
          minimumServedContext: Math.max(request.requirements?.minimumServedContext ?? 0, requestedContext),
        },
      });
      let snapshot = await this.#adapter.inspect();
      const snapshotIssues = validateSnapshot(snapshot, this.#adapter.runtimeId);
      if (!route.routable || snapshotIssues.length > 0) {
        return {
          outcome: "rejected",
          state: "degraded",
          modelId,
          reasons: [...route.reasons, ...snapshotIssues],
          snapshot,
        };
      }

      const matches = snapshot.models.filter((model) =>
        model.modelId === modelId &&
        (declared.identity.digest === undefined || model.digest === declared.identity.digest));
      if (matches.length > 1) {
        return { outcome: "rejected", state: "degraded", modelId, reasons: ["duplicate running model identity"], snapshot };
      }

      let running = matches[0];
      if (running) {
        const reasons: string[] = [];
        if (running.servedContextWindow !== requestedContext) {
          reasons.push(`runtime serves context ${running.servedContextWindow}, expected ${requestedContext}`);
        }
        if (running.acceleratorBytes !== undefined && running.acceleratorBytes < running.residentBytes) {
          reasons.push("running model is not fully accelerator-resident");
        }
        if (reasons.length > 0) return { outcome: "rejected", state: "degraded", modelId, reasons, snapshot };
        if ((this.#activeByModel.get(modelId) ?? 0) >= this.#policy.maxConcurrentSequences) {
          return { ...capacityResult(this.#policy), modelId, reasons: ["concurrent sequence limit reached"], snapshot };
        }
        return this.#admit(modelId, snapshot);
      }

      if (this.#loading.has(modelId)) {
        return { ...capacityResult(this.#policy), modelId, reasons: ["model load already in progress"], snapshot };
      }
      if (snapshot.models.length >= this.#policy.maxResidentModels) {
        return { ...capacityResult(this.#policy), modelId, reasons: ["resident model limit reached"], snapshot };
      }

      const estimate = estimateMemory({
        geometry: request.geometry,
        contextTokens: requestedContext,
        sequences: this.#policy.maxConcurrentSequences,
        ...(request.weightsBytes !== undefined ? { weightsBytes: request.weightsBytes } : {}),
        ...(request.bitsPerWeight !== undefined ? { bitsPerWeight: request.bitsPerWeight } : {}),
        ...(request.kvCacheBits !== undefined ? { kvCacheBits: request.kvCacheBits } : {}),
      });
      const freeAfterDeploymentReserve = Math.max(0, snapshot.freeMemoryBytes - this.#policy.deploymentHeadroomBytes);
      const fit = fitsIn(estimate, freeAfterDeploymentReserve);
      if (!fit.fits) {
        return {
          ...capacityResult(this.#policy),
          modelId,
          reasons: [`estimated load exceeds memory budget by ${Math.abs(fit.headroomBytes)} bytes`],
          estimate,
          snapshot,
        };
      }

      this.#loading.add(modelId);
      try {
        await this.#adapter.load({
          modelId,
          contextWindow: requestedContext,
          signal: AbortSignal.timeout(this.#policy.loadTimeoutMs),
        });
      } catch (error) {
        return {
          outcome: "rejected",
          state: "degraded",
          modelId,
          reasons: [`model load failed: ${error instanceof Error ? error.message : String(error)}`],
          estimate,
          snapshot,
        };
      } finally {
        this.#loading.delete(modelId);
      }

      snapshot = await this.#adapter.inspect();
      const afterIssues = validateSnapshot(snapshot, this.#adapter.runtimeId);
      running = snapshot.models.find((model) =>
        model.modelId === modelId &&
        (declared.identity.digest === undefined || model.digest === declared.identity.digest));
      if (afterIssues.length > 0 || !running || running.servedContextWindow !== requestedContext) {
        return {
          outcome: "rejected",
          state: "degraded",
          modelId,
          reasons: [
            ...afterIssues,
            ...(!running ? ["runtime did not report the requested model after loading"] : []),
            ...(running && running.servedContextWindow !== requestedContext
              ? [`runtime serves context ${running.servedContextWindow}, expected ${requestedContext}`]
              : []),
          ],
          estimate,
          snapshot,
        };
      }
      if (running.acceleratorBytes !== undefined && running.acceleratorBytes < running.residentBytes) {
        return { outcome: "rejected", state: "degraded", modelId, reasons: ["loaded model spilled from accelerator memory"], estimate, snapshot };
      }
      return this.#admit(modelId, snapshot, estimate);
    });
  }

  release(admissionId: string): boolean {
    const modelId = this.#activeAdmissions.get(admissionId);
    if (!modelId) return false;
    this.#activeAdmissions.delete(admissionId);
    const remaining = (this.#activeByModel.get(modelId) ?? 1) - 1;
    if (remaining <= 0) this.#activeByModel.delete(modelId);
    else this.#activeByModel.set(modelId, remaining);
    return true;
  }

  activeSequences(modelId: string): number {
    return this.#activeByModel.get(modelId) ?? 0;
  }

  async status(modelId: string, expectedContextWindow?: number, signal?: AbortSignal): Promise<LocalModelStatus> {
    if (!modelId.trim()) throw new Error("modelId must be a non-empty string");
    if (
      expectedContextWindow !== undefined &&
      (!Number.isFinite(expectedContextWindow) || !Number.isInteger(expectedContextWindow) || expectedContextWindow <= 0)
    ) {
      throw new Error("expectedContextWindow must be a finite positive whole number");
    }
    const snapshot = await this.#adapter.inspect(signal);
    const issues = validateSnapshot(snapshot, this.#adapter.runtimeId);
    const activeSequences = this.activeSequences(modelId);
    if (issues.length > 0) return { state: "degraded", modelId, reasons: issues, activeSequences, snapshot };
    if (this.#loading.has(modelId)) return { state: "loading", modelId, reasons: [], activeSequences, snapshot };
    const matches = snapshot.models.filter((model) => model.modelId === modelId);
    if (matches.length === 0) return { state: "cold", modelId, reasons: [], activeSequences, snapshot };
    if (matches.length > 1) return { state: "degraded", modelId, reasons: ["duplicate running model identity"], activeSequences, snapshot };
    const running = matches[0] as RunningLocalModel;
    const reasons: string[] = [];
    if (expectedContextWindow !== undefined && running.servedContextWindow !== expectedContextWindow) {
      reasons.push(`runtime serves context ${running.servedContextWindow}, expected ${expectedContextWindow}`);
    }
    if (running.acceleratorBytes !== undefined && running.acceleratorBytes < running.residentBytes) {
      reasons.push("running model is not fully accelerator-resident");
    }
    if (reasons.length > 0) return { state: "degraded", modelId, reasons, activeSequences, snapshot };
    return {
      state: activeSequences >= this.#policy.maxConcurrentSequences ? "busy" : "ready",
      modelId,
      reasons: [],
      activeSequences,
      snapshot,
    };
  }
}
