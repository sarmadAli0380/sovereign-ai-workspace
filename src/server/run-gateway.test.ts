import assert from "node:assert/strict";
import test from "node:test";
import type { Models } from "@earendil-works/pi-ai";
import { RUN_EVENT_SCHEMA_VERSION, type RunEvent } from "../events.ts";
import type { MessageRepository } from "../storage/repositories/messages.ts";
import type { AcceptedRunCommand } from "./http-server.ts";
import { DurableRunCommandGateway, type ResolvedRunRoute } from "./run-gateway.ts";
import { RunControlError } from "./run-controls.ts";

const acceptedAt = "2026-08-25T00:00:00.000Z";

function command(onDurableEvent: (event: RunEvent) => void = () => undefined): AcceptedRunCommand {
  return {
    runId: "run-1",
    conversationId: "conversation-1",
    userId: "user-1",
    sessionId: "session-1",
    isAdmin: false,
    roleId: "member",
    idempotencyKey: "caller-command-0001",
    configKey: "local-qwen",
    message: "hello",
    maxTurns: 2,
    causationId: "request-1",
    onDurableEvent,
  };
}

function runEvent(): RunEvent {
  return {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    eventId: "event-1",
    runId: "run-1",
    conversationId: "conversation-1",
    sequence: 0,
    turn: 0,
    occurredAt: acceptedAt,
    type: "run.started",
    causationId: "request-1",
    audience: "persistence",
    sensitivity: "metadata",
    payload: { configKey: "local-qwen", provider: "ollama", model: "qwen3:4b" },
  };
}

function route(admitted = true): ResolvedRunRoute {
  return {
    models: {} as Models,
    model: { provider: "ollama", id: "qwen3:4b", api: "openai-completions", contextWindow: 8192 } as never,
    entry: { provider: "ollama", modelId: "qwen3:4b", maxTokens: 2048, contextWindow: 8192 },
    configKey: "local-qwen",
    contextWindow: 8192,
    async admit() { return { admitted, code: "model.admission-rejected", release() {} }; },
  };
}

test("C2 gateway loads the durably appended user message and orders durable, projection, then SSE", async () => {
  const order: string[] = [];
  let storedMessage: Parameters<MessageRepository["append"]>[0]["message"] | undefined;
  let resolveRun!: () => void;
  const ran = new Promise<void>((resolve) => { resolveRun = resolve; });
  const messages = {
    async listAllCurrent() {
      assert.ok(storedMessage);
      return [{ conversationId: "conversation-1", seq: 0, message: storedMessage, storedAt: acceptedAt }];
    },
  } as unknown as MessageRepository;
  const gateway = new DurableRunCommandGateway({
    commands: { async find() { return undefined; }, async accept(input) {
      storedMessage = input.message;
      return {
        created: true,
        commandId: input.commandId,
        runId: input.runId,
        conversationId: input.conversationId,
        userId: input.userId,
        sessionId: input.sessionId,
        idempotencyKey: input.idempotencyKey,
        requestSha256: input.requestSha256,
        messageId: input.message.messageId,
        configKey: input.configKey,
        maxTurns: input.maxTurns,
        causationId: input.causationId,
        acceptedAt: input.acceptedAt,
      };
    } },
    messages,
    routes: { async resolve() { return route(); } },
    durable: { async append() { order.push("durable"); } },
    projection: { async drain() { order.push("projection"); return 1; } },
    deploymentId: "single-node",
    runTimeoutMs: 60_000,
    idFactory: (() => {
      let next = 0;
      return () => `generated-${++next}`;
    })(),
    now: () => Date.parse(acceptedAt),
    runAgent: (async (deps, options) => {
      assert.equal(deps.conversation.getHistory()[0]?.role, "user");
      assert.deepEqual(deps.toolPolicyContext, {
        deploymentId: "single-node", roleId: "member", workspaceId: "conversation-1",
      });
      await options.onEvent(runEvent());
      resolveRun();
      return {
        runId: "run-1", conversationId: "conversation-1", reason: "stop", turns: 1,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        latencyMs: 0, elapsedMs: 0, pendingToolCalls: [], pendingApprovals: [],
      };
    }) as typeof import("../run.ts").run,
  });

  const accepted = await gateway.start(command(() => order.push("broker")));
  assert.equal(accepted.created, true);
  await ran;
  assert.deepEqual(order, ["durable", "projection", "broker"]);
});

test("C2 gateway does not execute an idempotent retry twice", async () => {
  let ran = false;
  const gateway = new DurableRunCommandGateway({
    commands: { async find() { return undefined; }, async accept(input) {
      return {
        created: false,
        commandId: "existing-command",
        runId: "existing-run",
        conversationId: input.conversationId,
        userId: input.userId,
        sessionId: input.sessionId,
        idempotencyKey: input.idempotencyKey,
        requestSha256: input.requestSha256,
        messageId: "existing-message",
        configKey: input.configKey,
        maxTurns: input.maxTurns,
        causationId: "existing-request",
        acceptedAt,
      };
    } },
    messages: {} as MessageRepository,
    routes: { async resolve() { return route(); } },
    durable: { async append() {} },
    deploymentId: "single-node",
    runTimeoutMs: 60_000,
    runAgent: (async () => { ran = true; throw new Error("must not run"); }) as typeof import("../run.ts").run,
  });
  const accepted = await gateway.start(command());
  assert.equal(accepted.runId, "existing-run");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ran, false);
});

test("C4 gateway fails closed before command ownership when provider bounds are unaccountable", async () => {
  let accepted = false;
  let controlled = false;
  const gateway = new DurableRunCommandGateway({
    commands: { async find() { return undefined; }, async accept() { accepted = true; throw new Error("must not accept"); } },
    messages: {} as MessageRepository,
    routes: { async resolve() { return route(); } },
    controls: { async acquire() { controlled = true; throw new Error("must not acquire"); } },
    durable: { async append() {} },
    deploymentId: "single-node",
    runTimeoutMs: 60_000,
  });
  await assert.rejects(gateway.start(command()), (error: unknown) => {
    assert.ok(error instanceof RunControlError);
    assert.equal(error.code, "control.provider-unaccountable");
    return true;
  });
  assert.equal(controlled, false);
  assert.equal(accepted, false);
});

test("C4 gateway reserves a conservative bound before durable command acceptance", async () => {
  let reservation: Record<string, unknown> | undefined;
  let released = false;
  const controlledRoute = {
    ...route(),
    accounting: {
      outputTokenLimitEnforced: true,
      usageReported: true,
      costReported: true,
      maxRunCostUsd: 0,
    },
  };
  const gateway = new DurableRunCommandGateway({
    commands: {
      async find() { return undefined; },
      async accept() { throw new Error("accept failed"); },
    },
    messages: {} as MessageRepository,
    routes: { async resolve() { return controlledRoute; } },
    controls: { async acquire(input) {
      reservation = { ...input };
      return { runId: input.runId, created: true, async settle() {}, async release() { released = true; } };
    } },
    durable: { async append() {} },
    deploymentId: "single-node",
    runTimeoutMs: 60_000,
  });
  await assert.rejects(gateway.start(command()), /accept failed/);
  assert.equal(reservation?.["reservedTokens"], 16_384);
  assert.equal(reservation?.["reservedCostUsd"], 0);
  assert.equal(released, true);
});
