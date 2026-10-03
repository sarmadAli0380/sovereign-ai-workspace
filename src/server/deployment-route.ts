import type { Models } from "@earendil-works/pi-ai";
import type { HarnessConfig } from "../config.ts";
import { loadModel } from "../load-model.ts";
import { LocalModelController } from "../model-control/admission.ts";
import { MODEL_CAPABILITY_SCHEMA_VERSION, type ModelCapabilityRecord } from "../model-control/capabilities.ts";
import { OllamaRuntimeAdapter } from "../model-control/ollama.ts";
import type { SingleNodeDeploymentConfig } from "../deployment/config.ts";
import type { ResolvedRunRoute, RunRouteResolver } from "./run-gateway.ts";

export interface DeploymentOllamaRouteOptions {
  readonly config: HarnessConfig;
  readonly models: Models;
  readonly deployment: SingleNodeDeploymentConfig;
  readonly freeMemoryBytes: number;
  readonly deploymentHeadroomBytes: number;
  readonly now?: () => Date;
  readonly adapter?: OllamaRuntimeAdapter;
}

const unknownFeatures = Object.freeze({
  tools: "unknown",
  images: "unknown",
  thinking: "unknown",
  structuredOutput: "unknown",
  streaming: "unknown",
} as const);

/** The supported first deployment admits only its pinned local Ollama route. */
export class DeploymentOllamaRouteResolver implements RunRouteResolver {
  readonly #options: DeploymentOllamaRouteOptions;
  readonly #adapter: OllamaRuntimeAdapter;
  readonly #controller: LocalModelController;
  readonly #now: () => Date;

  constructor(options: DeploymentOllamaRouteOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#adapter = options.adapter ?? new OllamaRuntimeAdapter({
      baseUrl: options.deployment.inference.baseUrl,
      freeMemory: () => options.freeMemoryBytes,
      memorySource: "DEPLOYMENT_ADMISSION_FREE_BYTES (operator measurement)",
    });
    this.#controller = new LocalModelController(this.#adapter, {
      maxResidentModels: 1,
      maxConcurrentSequences: 1,
      deploymentHeadroomBytes: options.deploymentHeadroomBytes,
      maxCapabilityObservationAgeMs: 60_000,
      loadTimeoutMs: options.deployment.inference.loadTimeoutMs,
      capacityAction: "reject",
    }, this.#now);
  }

  async resolve(configKey: string): Promise<ResolvedRunRoute> {
    const resolved = loadModel(configKey, this.#options.config, this.#options.models);
    const expected = this.#options.deployment.inference;
    if (
      resolved.entry.provider !== "ollama" ||
      resolved.entry.modelId !== expected.modelId ||
      resolved.contextWindow !== expected.contextWindow
    ) {
      throw new Error("the requested config key is not the pinned single-node local route");
    }
    return {
      ...resolved,
      models: this.#options.models,
      accounting: {
        outputTokenLimitEnforced: resolved.entry.maxTokensHonored === true,
        // pi-ai's AssistantMessage contract requires token usage and a USD
        // cost breakdown. The product codec validates both before C4 settles.
        usageReported: true,
        costReported: true,
        // The supported route is local Ollama and has no provider spend.
        maxRunCostUsd: 0,
      },
      admit: async () => {
        const expectedDigest = expected.modelDigest.slice("sha256:".length);
        const [description, snapshot] = await Promise.all([
          this.#adapter.describe(expected.modelId, AbortSignal.timeout(15_000)),
          this.#adapter.inspect(AbortSignal.timeout(15_000)),
        ]);
        if (description.digest !== expectedDigest) {
          return { admitted: false, code: "model.identity-mismatch", release() {} };
        }
        const running = snapshot.models.find((candidate) =>
          candidate.modelId === expected.modelId && candidate.digest === expectedDigest);
        if (!running || running.servedContextWindow !== expected.contextWindow) {
          return { admitted: false, code: "model.not-ready", release() {} };
        }
        const verifiedAt = this.#now().toISOString();
        const identity = {
          provider: "ollama",
          model: expected.modelId,
          digest: expectedDigest,
          ...(description.quantization ? { quantization: description.quantization } : {}),
        };
        const record: ModelCapabilityRecord = {
          schemaVersion: MODEL_CAPABILITY_SCHEMA_VERSION,
          recordId: `${configKey}@${expected.modelDigest}`,
          configKey,
          declared: {
            identity,
            api: String(resolved.model.api),
            transport: "http",
            contextWindow: expected.contextWindow,
            outputLimit: { tokens: resolved.entry.maxTokens, honored: "unknown" },
            features: unknownFeatures,
            reporting: { usage: "unknown", cache: "unknown" },
            provenance: {
              kind: "configuration",
              source: "single-node deployment config",
              recordedAt: verifiedAt,
            },
          },
          observed: {
            identity,
            api: String(resolved.model.api),
            transport: "http",
            servedContextWindow: running.servedContextWindow,
            outputLimitHonored: "unknown",
            features: unknownFeatures,
            reporting: { usage: "unknown", cache: "unknown" },
            health: snapshot.issues.length === 0 ? "healthy" : "degraded",
            readiness: snapshot.issues.length === 0 ? "ready" : "not-ready",
            provenance: {
              kind: "live-probe",
              source: "current Ollama /api/ps and /api/show",
              verifiedAt,
            },
          },
        };
        const admitted = await this.#controller.admit({
          capabilityRecord: record,
          requirements: { minimumServedContext: expected.contextWindow },
          geometry: description.geometry,
          ...(description.weightsBytes !== undefined ? { weightsBytes: description.weightsBytes } : {}),
        });
        if (admitted.outcome !== "admitted" || !admitted.admissionId) {
          return {
            admitted: false,
            code: admitted.outcome === "queued" ? "model.capacity-unavailable" : "model.admission-rejected",
            release() {},
          };
        }
        return {
          admitted: true,
          release: () => { this.#controller.release(admitted.admissionId!); },
        };
      },
    };
  }

  async ready(): Promise<boolean> {
    try {
      const expected = this.#options.deployment.inference;
      const expectedDigest = expected.modelDigest.slice("sha256:".length);
      const status = await this.#controller.status(
        expected.modelId,
        expected.contextWindow,
        AbortSignal.timeout(5_000),
      );
      return (status.state === "ready" || status.state === "busy") && status.snapshot.models.some((candidate) =>
        candidate.modelId === expected.modelId &&
        candidate.digest === expectedDigest &&
        candidate.servedContextWindow === expected.contextWindow);
    } catch {
      return false;
    }
  }
}
