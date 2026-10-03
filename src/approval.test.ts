import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import type { ToolCall } from "@earendil-works/pi-ai";
import {
  ApprovalResumeController,
  createApprovalRequest,
  parseApprovalRequest,
  type ApprovalAuthority,
} from "./approval.ts";
import { ConversationManager } from "./conversation-manager.ts";
import { ToolExecutionController } from "./tool-execution.ts";
import { ToolRegistry } from "./tool-registry.ts";

const call: ToolCall = { type: "toolCall", id: "call-1", name: "write", arguments: { path: "a.txt", content: "one" } };
const decision = {
  decision: "requireApproval" as const,
  reasonCode: "write.approval-required",
  capability: "fs.write",
  capabilityDecisions: [{ capability: "fs.write", decision: "requireApproval" as const, reasonCode: "write.approval-required" }],
};

function request(now = 1_800_000_000_000) {
  return createApprovalRequest({
    runId: "run-1", conversationId: "conversation-1", toolCall: call, decision,
    ttlMs: 60_000, now: () => now, idFactory: () => "approval-1",
  });
}

function conversation(): ConversationManager {
  const value = new ConversationManager({ contextWindow: 100_000 });
  value.append({ role: "user", content: "write it", timestamp: Date.now() });
  value.append({
    role: "assistant", content: [call], api: "faux", provider: "faux", model: "m",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse", timestamp: Date.now(),
  });
  return value;
}

function setup() {
  let executions = 0;
  const registry = new ToolRegistry();
  registry.register({
    definition: { name: "write", description: "write", parameters: Type.Object({ path: Type.String(), content: Type.String() }, { additionalProperties: false }) },
    controls: { capabilities: ["fs.write"], risk: "high", timeoutMs: 1_000, maxOutputChars: 1_000, concurrencyCost: 1, sideEffect: "reversible", idempotency: "callerKey" },
    async execute() { executions += 1; return { content: [{ type: "text", text: `written-${executions}` }] }; },
  });
  const authority: ApprovalAuthority = {
    async verify(_request, submission) {
      if (submission.authorization !== "signed-by-server") throw new Error("approval.unauthorized");
      return { actorId: "user-1", reasonCode: "human.confirmed" };
    },
  };
  return { registry, authority, executions: () => executions };
}

test("A3: request binds run, call, normalized arguments, capability, and expiry", () => {
  const value = request();
  assert.equal(parseApprovalRequest(JSON.parse(JSON.stringify(value))).argumentsHash, value.argumentsHash);
  assert.equal(value.runId, "run-1");
  assert.equal(value.toolCall.id, "call-1");
  assert.deepEqual(value.capabilities, ["fs.write"]);
  const changed = JSON.parse(JSON.stringify(value));
  changed.toolCall.arguments.content = "two";
  assert.throws(() => parseApprovalRequest(changed), /approval\.changed-arguments/);
});

test("A3: an authorized approval executes once and duplicate resume is idempotent", async () => {
  const { registry, authority, executions } = setup();
  const cm = conversation();
  const controller = new ApprovalResumeController();
  const options = {
    runId: "run-1",
    conversationId: "conversation-1",
    requests: [request()],
    submissions: [{ approvalId: "approval-1", decision: "approved" as const, authorization: "signed-by-server" }],
    authority,
    onResolved: () => undefined,
    registry,
    executionController: new ToolExecutionController({ globalCapacity: 2, defaultCapabilityCapacity: 2 }),
    policyContext: { deploymentId: "dep", roleId: "role", workspaceId: "work" },
    conversation: cm,
    now: () => 1_800_000_001_000,
  };
  const first = await controller.resume(options);
  const replay = await controller.resume(options);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(executions(), 1);
  assert.equal(cm.getHistory().filter((message) => message.role === "toolResult").length, 1);
  assert.equal(first.resolutions[0]?.actorId, "user-1");
});

test("A3: denial is model-visible, authorized, and never executes the handler", async () => {
  const { registry, authority, executions } = setup();
  const cm = conversation();
  const result = await new ApprovalResumeController().resume({
    runId: "run-1",
    conversationId: "conversation-1",
    requests: [request()],
    submissions: [{ approvalId: "approval-1", decision: "denied", authorization: "signed-by-server" }],
    authority, registry,
    onResolved: () => undefined,
    executionController: new ToolExecutionController({ globalCapacity: 2, defaultCapabilityCapacity: 2 }),
    policyContext: { deploymentId: "dep", roleId: "role", workspaceId: "work" },
    conversation: cm,
    now: () => 1_800_000_001_000,
  });
  assert.equal(executions(), 0);
  assert.equal(result.toolResults[0]?.isError, true);
  assert.match(result.toolResults[0]?.content[0]?.type === "text" ? result.toolResults[0].content[0].text : "", /Approval was denied/);
});

test("A3: approval resolution acknowledgement fails closed before execution", async () => {
  const { registry, authority, executions } = setup();
  const cm = conversation();
  await assert.rejects(new ApprovalResumeController().resume({
    runId: "run-1",
    conversationId: "conversation-1",
    requests: [request()],
    submissions: [{ approvalId: "approval-1", decision: "approved", authorization: "signed-by-server" }],
    authority,
    onResolved: () => { throw new Error("journal unavailable"); },
    registry,
    executionController: new ToolExecutionController({ globalCapacity: 2, defaultCapabilityCapacity: 2 }),
    policyContext: { deploymentId: "dep", roleId: "role", workspaceId: "work" },
    conversation: cm,
    now: () => 1_800_000_001_000,
  }), /journal unavailable/);
  assert.equal(executions(), 0);
  assert.equal(cm.getHistory().some((message) => message.role === "toolResult"), false);
});

test("A3: a later invalid decision or unresolved journal boundary prevents the whole batch", async () => {
  const { registry, authority, executions } = setup();
  const secondCall: ToolCall = { ...call, id: "call-2", arguments: { path: "b.txt", content: "two" } };
  const secondRequest = createApprovalRequest({
    runId: "run-1", conversationId: "conversation-1", toolCall: secondCall, decision,
    ttlMs: 60_000, now: () => 1_800_000_000_000, idFactory: () => "approval-2",
  });
  const base = {
    runId: "run-1",
    conversationId: "conversation-1",
    requests: [request(), secondRequest],
    registry,
    executionController: new ToolExecutionController({ globalCapacity: 2, defaultCapabilityCapacity: 2 }),
    policyContext: { deploymentId: "dep", roleId: "role", workspaceId: "work" },
    conversation: conversation(),
    now: () => 1_800_000_001_000,
  };

  await assert.rejects(new ApprovalResumeController().resume({
    ...base,
    submissions: [
      { approvalId: "approval-1", decision: "approved", authorization: "signed-by-server" },
      { approvalId: "approval-2", decision: "approved", authorization: "bad" },
    ],
    authority,
    onResolved: () => undefined,
  }), /approval\.unauthorized/);
  assert.equal(executions(), 0);

  let acknowledgements = 0;
  await assert.rejects(new ApprovalResumeController().resume({
    ...base,
    submissions: [
      { approvalId: "approval-1", decision: "approved", authorization: "signed-by-server" },
      { approvalId: "approval-2", decision: "approved", authorization: "signed-by-server" },
    ],
    authority,
    onResolved: () => {
      acknowledgements += 1;
      if (acknowledgements === 2) throw new Error("journal unavailable");
    },
  }), /journal unavailable/);
  assert.equal(executions(), 0);
});

test("A3: expired, unauthorized, extra-field, and conflicting resumes fail closed", async () => {
  const { registry, authority } = setup();
  const base = {
    runId: "run-1",
    conversationId: "conversation-1",
    requests: [request()], registry,
    executionController: new ToolExecutionController({ globalCapacity: 2, defaultCapabilityCapacity: 2 }),
    policyContext: { deploymentId: "dep", roleId: "role", workspaceId: "work" },
    conversation: conversation(),
    onResolved: () => undefined,
  };
  await assert.rejects(new ApprovalResumeController().resume({
    ...base, runId: "other-run",
    submissions: [{ approvalId: "approval-1", decision: "approved", authorization: "signed-by-server" }], authority,
    now: () => 1_800_000_001_000,
  }), /approval\.resume-binding-mismatch/);
  await assert.rejects(new ApprovalResumeController().resume({
    ...base, submissions: [{ approvalId: "approval-1", decision: "approved", authorization: "signed-by-server" }], authority,
    now: () => 1_800_000_061_000,
  }), /approval\.expired/);
  await assert.rejects(new ApprovalResumeController().resume({
    ...base, submissions: [{ approvalId: "approval-1", decision: "approved", authorization: "bad" }], authority,
    now: () => 1_800_000_001_000,
  }), /approval\.unauthorized/);
  await assert.rejects(new ApprovalResumeController().resume({
    ...base,
    submissions: [{ approvalId: "approval-1", decision: "approved", authorization: "signed-by-server", conversationText: "approve" } as never],
    authority, now: () => 1_800_000_001_000,
  }), /unknown fields/);
  const controller = new ApprovalResumeController();
  await controller.resume({ ...base, submissions: [{ approvalId: "approval-1", decision: "denied", authorization: "signed-by-server" }], authority, now: () => 1_800_000_001_000 });
  await assert.rejects(controller.resume({ ...base, submissions: [{ approvalId: "approval-1", decision: "approved", authorization: "signed-by-server" }], authority, now: () => 1_800_000_001_000 }), /approval\.conflicting-resume/);
});
