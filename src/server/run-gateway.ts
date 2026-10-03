import { createHash, randomUUID } from "node:crypto";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { ConfigEntry } from "../config.ts";
import { ConversationManager } from "../conversation-manager.ts";
import {
  parseRunEvent,
  RUN_EVENT_SCHEMA_VERSION,
  RUN_EVENT_SENSITIVITY,
  type RunEvent,
} from "../events.ts";
import { runtimeMessageToProductEnvelope } from "../messages/codec.ts";
import type { CapabilityPolicy } from "../policy.ts";
import { run, type RunResult } from "../run.ts";
import type { CompleteOptions } from "../complete.ts";
import type { ToolExecutionController } from "../tool-execution.ts";
import type { ToolRegistry } from "../tool-registry.ts";
import type { DurableJournalSink } from "../storage/durable-journal.ts";
import { isDatabaseUnavailableError } from "../storage/durable-journal.ts";
import type { MessageRepository } from "../storage/repositories/messages.ts";
import type {
  AcceptedRunCommand,
  RunCommandAcceptance,
  RunCommandGateway,
} from "./http-server.ts";
import type {
  AcceptedRunOwnership,
  PostgresRunCommandStore,
} from "./command-store.ts";
import { RunCommandConflictError } from "./command-store.ts";
import {
  RunControlError,
  type RunControlGateway,
  type RunControlLease,
} from "./run-controls.ts";

export interface RunAdmissionLease {
  readonly admitted: boolean;
  readonly code?: string;
  release(): void;
}

export interface ResolvedRunRoute {
  readonly models: Models;
  readonly model: Model<Api>;
  readonly entry: ConfigEntry;
  readonly configKey: string;
  readonly contextWindow: number;
  readonly completeOptions?: CompleteOptions;
  readonly accounting?: {
    readonly outputTokenLimitEnforced: boolean;
    readonly usageReported: boolean;
    readonly costReported: boolean;
    /** Conservative upper bound reserved before this run starts. */
    readonly maxRunCostUsd: number;
  };
  admit(): Promise<RunAdmissionLease>;
}

export interface RunRouteResolver {
  resolve(configKey: string): Promise<ResolvedRunRoute>;
}

export interface RunProjectionDrain {
  drain(): Promise<number>;
}

export interface DurableRunCommandGatewayOptions {
  readonly commands: Pick<PostgresRunCommandStore, "accept" | "find">;
  readonly messages: MessageRepository;
  readonly routes: RunRouteResolver;
  readonly controls?: RunControlGateway;
  readonly durable: Pick<DurableJournalSink, "append">;
  readonly projection?: RunProjectionDrain;
  readonly deploymentId: string;
  readonly runTimeoutMs: number;
  readonly registry?: ToolRegistry;
  readonly toolPolicy?: CapabilityPolicy;
  readonly toolExecutionController?: ToolExecutionController;
  readonly systemPrompt?: string;
  readonly approvalTtlMs?: number;
  readonly idFactory?: () => string;
  readonly now?: () => number;
  readonly runAgent?: typeof run;
  readonly onBackgroundFailure?: (error: unknown, runId: string) => void;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

export function runCommandRequestHash(command: Pick<
  AcceptedRunCommand,
  "conversationId" | "userId" | "configKey" | "message" | "maxTurns"
>): string {
  return createHash("sha256").update(canonical({
    conversationId: command.conversationId,
    userId: command.userId,
    configKey: command.configKey,
    message: command.message,
    maxTurns: command.maxTurns,
  }), "utf8").digest("hex");
}

function positiveBound(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

/**
 * C2 composition boundary. HTTP returns only after command/message/run
 * ownership commits. Inference continues in the background and every event
 * crosses the journal/spool acknowledgement and projector before live SSE.
 */
export class DurableRunCommandGateway implements RunCommandGateway {
  readonly #options: DurableRunCommandGatewayOptions;
  readonly #idFactory: () => string;
  readonly #now: () => number;
  readonly #runAgent: typeof run;
  #projectionTail: Promise<void> = Promise.resolve();

  constructor(options: DurableRunCommandGatewayOptions) {
    positiveBound(options.runTimeoutMs, "runTimeoutMs");
    if (!options.deploymentId.trim()) throw new TypeError("deploymentId must be non-empty");
    this.#options = options;
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#now = options.now ?? Date.now;
    this.#runAgent = options.runAgent ?? run;
  }

  async start(command: AcceptedRunCommand): Promise<RunCommandAcceptance> {
    const requestSha256 = runCommandRequestHash(command);
    const existing = await this.#options.commands.find(command.userId, command.idempotencyKey);
    if (existing) {
      if (existing.requestSha256 !== requestSha256) {
        throw new RunCommandConflictError();
      }
      return { runId: existing.runId, conversationId: existing.conversationId, created: false };
    }
    const route = await this.#options.routes.resolve(command.configKey);
    if (route.configKey !== command.configKey) throw new Error("resolved route changed config identity");
    let controlLease: RunControlLease | undefined;
    if (this.#options.controls) {
      if (
        !route.accounting?.outputTokenLimitEnforced ||
        !route.accounting.usageReported ||
        !route.accounting.costReported ||
        !Number.isFinite(route.accounting.maxRunCostUsd) ||
        route.accounting.maxRunCostUsd < 0
      ) {
        throw new RunControlError("control.provider-unaccountable");
      }
      const reservedTokens = route.contextWindow * command.maxTurns;
      if (!Number.isSafeInteger(reservedTokens) || reservedTokens <= 0) {
        throw new RunControlError("control.provider-unaccountable");
      }
      controlLease = await this.#options.controls.acquire({
        runId: command.runId,
        userId: command.userId,
        idempotencyKey: command.idempotencyKey,
        requestSha256,
        configKey: route.configKey,
        provider: route.entry.provider,
        model: route.entry.modelId,
        reservedTokens,
        reservedCostUsd: route.accounting.maxRunCostUsd,
      });
      if (!controlLease.created && controlLease.runId !== command.runId) {
        const accepted = await this.#options.commands.find(command.userId, command.idempotencyKey);
        if (!accepted) throw new Error("control reservation exists without durable command ownership");
        if (accepted.requestSha256 !== requestSha256) throw new RunCommandConflictError();
        return { runId: accepted.runId, conversationId: accepted.conversationId, created: false };
      }
    }
    const acceptedAtMs = this.#now();
    if (!Number.isFinite(acceptedAtMs)) throw new TypeError("now() must return a finite timestamp");
    const acceptedAt = new Date(acceptedAtMs).toISOString();
    const messageId = this.#idFactory();
    const message = runtimeMessageToProductEnvelope(
      { role: "user", content: command.message, timestamp: acceptedAtMs },
      { messageId },
    );
    let ownership: AcceptedRunOwnership;
    try {
      ownership = await this.#options.commands.accept({
        commandId: this.#idFactory(),
        runId: command.runId,
        conversationId: command.conversationId,
        userId: command.userId,
        sessionId: command.sessionId,
        isAdmin: command.isAdmin,
        idempotencyKey: command.idempotencyKey,
        requestSha256,
        message,
        configKey: route.configKey,
        maxTurns: command.maxTurns,
        causationId: command.causationId,
        provider: route.entry.provider,
        model: route.entry.modelId,
        acceptedAt,
      });
    } catch (error) {
      if (controlLease?.created) await controlLease.release();
      throw error;
    }

    if (ownership.created) {
      void this.#execute(command, ownership, route, controlLease).catch((error) => {
        this.#options.onBackgroundFailure?.(error, ownership.runId);
      });
    } else if (controlLease?.created) {
      await controlLease.release();
    }
    return {
      runId: ownership.runId,
      conversationId: ownership.conversationId,
      created: ownership.created,
    };
  }

  async #project(): Promise<void> {
    if (!this.#options.projection) return;
    const operation = this.#projectionTail.then(async () => {
      try {
        await this.#options.projection!.drain();
      } catch (error) {
        // The spool is the durable acknowledgement during a database outage.
        // A later successful append/drain catches the read model up.
        if (!isDatabaseUnavailableError(error)) throw error;
      }
    });
    this.#projectionTail = operation.catch(() => undefined);
    return operation;
  }

  async #publish(command: AcceptedRunCommand, event: RunEvent): Promise<void> {
    await this.#options.durable.append(event);
    if (event.type !== "message.delta") await this.#project();
    command.onDurableEvent(event);
  }

  async #publishRejected(
    command: AcceptedRunCommand,
    ownership: AcceptedRunOwnership,
    route: ResolvedRunRoute,
    code: string,
  ): Promise<void> {
    const at = (): string => {
      const value = this.#now();
      if (!Number.isFinite(value)) throw new TypeError("now() must return a finite timestamp");
      return new Date(value).toISOString();
    };
    const common = {
      schemaVersion: RUN_EVENT_SCHEMA_VERSION,
      runId: ownership.runId,
      conversationId: ownership.conversationId,
      turn: 0,
      causationId: ownership.causationId,
      audience: "persistence" as const,
      sensitivity: "metadata" as const,
    };
    await this.#publish(command, parseRunEvent({
      ...common,
      eventId: this.#idFactory(),
      sequence: 0,
      occurredAt: at(),
      type: "run.started",
      sensitivity: RUN_EVENT_SENSITIVITY["run.started"],
      payload: { configKey: route.configKey, provider: route.entry.provider, model: route.entry.modelId },
    }));
    await this.#publish(command, parseRunEvent({
      ...common,
      eventId: this.#idFactory(),
      sequence: 1,
      occurredAt: at(),
      type: "run.failed",
      sensitivity: RUN_EVENT_SENSITIVITY["run.failed"],
      payload: { code, retryable: false },
    }));
  }

  async #execute(
    command: AcceptedRunCommand,
    ownership: AcceptedRunOwnership,
    route: ResolvedRunRoute,
    controlLease?: RunControlLease,
  ): Promise<RunResult | undefined> {
    let lease: RunAdmissionLease | undefined;
    let conversation: ConversationManager;
    let measuredTokens = 0;
    let measuredCostUsd = 0;
    let sawMeasuredUsage = false;
    try {
      conversation = await ConversationManager.loadCurrent({
        conversationId: ownership.conversationId,
        repository: this.#options.messages,
        contextWindow: route.contextWindow,
        ...(this.#options.systemPrompt !== undefined ? { systemPrompt: this.#options.systemPrompt } : {}),
        ...(this.#options.registry ? { tools: this.#options.registry.getToolDefinitions() } : {}),
      });
      lease = await route.admit();
    } catch (error) {
      await this.#publishRejected(command, ownership, route, "gateway.failed");
      await controlLease?.release();
      throw error;
    }
    if (!lease.admitted) {
      const code = lease.code ?? "model.admission-rejected";
      lease.release();
      lease = undefined;
      await this.#publishRejected(command, ownership, route, code);
      await controlLease?.release();
      return undefined;
    }

    try {
      const deadline = this.#now() + this.#options.runTimeoutMs;
      const result = await this.#runAgent({
        models: route.models,
        model: route.model,
        entry: route.entry,
        configKey: route.configKey,
        conversation,
        ...(this.#options.registry ? { registry: this.#options.registry } : {}),
        ...(this.#options.toolPolicy ? { toolPolicy: this.#options.toolPolicy } : {}),
        toolPolicyContext: {
          deploymentId: this.#options.deploymentId,
          roleId: command.roleId,
          workspaceId: ownership.conversationId,
        },
        ...(this.#options.toolExecutionController
          ? { toolExecutionController: this.#options.toolExecutionController }
          : {}),
        knownConfigKeys: [route.configKey],
        ...(route.completeOptions ? { options: route.completeOptions } : {}),
      }, {
        runId: ownership.runId,
        conversationId: ownership.conversationId,
        causationId: ownership.causationId,
        inputMessageId: ownership.messageId,
        maxTurns: ownership.maxTurns,
        deadline,
        onEvent: async (event) => {
          if (event.type === "message.completed") {
            const usage = event.payload.message.usage;
            if (usage) {
              measuredTokens += usage.totalTokens;
              measuredCostUsd += usage.costUsd.total;
              sawMeasuredUsage = true;
            }
          }
          await this.#publish(command, event);
        },
        ...(this.#options.approvalTtlMs !== undefined
          ? { approvalTtlMs: this.#options.approvalTtlMs }
          : {}),
      });
      await controlLease?.settle({
        tokens: result.usage.totalTokens,
        costUsd: measuredCostUsd,
        measured: sawMeasuredUsage || result.usage.totalTokens === 0,
      });
      return result;
    } catch (error) {
      await controlLease?.settle({
        tokens: measuredTokens,
        costUsd: measuredCostUsd,
        measured: sawMeasuredUsage,
      });
      throw error;
    } finally {
      lease?.release();
    }
  }
}
