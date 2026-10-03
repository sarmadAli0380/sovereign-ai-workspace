import assert from "node:assert/strict";
import test from "node:test";
import { CapabilityPolicy, type ToolPolicyInput } from "./policy.ts";

const baseInput: ToolPolicyInput = {
  deploymentId: "client-a",
  roleId: "developer",
  workspaceId: "workspace-a",
  toolName: "read_file",
  capabilities: ["fs.read"],
  risk: "low",
  sideEffect: "none",
  normalizedArguments: { path: "docs/readme.md" },
};

test("an exact capability rule allows a normalized call", () => {
  const policy = new CapabilityPolicy({
    rules: [{
      deploymentId: "client-a",
      roleId: "developer",
      workspaceId: "workspace-a",
      capability: "fs.read",
      decision: "allow",
      reasonCode: "workspace.read-allowed",
    }],
  });

  assert.deepEqual(policy.evaluate(baseInput), {
    decision: "allow",
    reasonCode: "workspace.read-allowed",
    capability: "fs.read",
    capabilityDecisions: [{
      capability: "fs.read",
      decision: "allow",
      reasonCode: "workspace.read-allowed",
    }],
  });
});

test("missing configuration denies by default", () => {
  const decision = new CapabilityPolicy({ rules: [] }).evaluate(baseInput);
  assert.equal(decision.decision, "deny");
  assert.equal(decision.reasonCode, "policy.no-matching-rule");
});

test("the most specific matching rule wins over a wildcard", () => {
  const policy = new CapabilityPolicy({
    rules: [
      {
        deploymentId: "*",
        roleId: "*",
        workspaceId: "*",
        capability: "fs.read",
        decision: "deny",
        reasonCode: "filesystem.denied",
      },
      {
        deploymentId: "client-a",
        roleId: "developer",
        workspaceId: "workspace-a",
        capability: "fs.read",
        decision: "allow",
        reasonCode: "workspace.read-allowed",
      },
    ],
  });
  assert.equal(policy.evaluate(baseInput).decision, "allow");
});

test("argument rules inspect normalized JSON and ignore object insertion order", () => {
  const policy = new CapabilityPolicy({
    rules: [{
      deploymentId: "client-a",
      roleId: "developer",
      workspaceId: "workspace-a",
      capability: "fs.read",
      argumentEquals: { options: { encoding: "utf8", cache: false } },
      decision: "allow",
      reasonCode: "workspace.utf8-read-allowed",
    }],
  });
  const decision = policy.evaluate({
    ...baseInput,
    normalizedArguments: {
      path: "docs/readme.md",
      options: { cache: false, encoding: "utf8" },
    },
  });
  assert.equal(decision.decision, "allow");
});

test("one denied capability denies a multi-capability tool", () => {
  const policy = new CapabilityPolicy({
    rules: [
      {
        deploymentId: "*",
        roleId: "*",
        workspaceId: "*",
        capability: "fs.read",
        decision: "allow",
        reasonCode: "filesystem.read-allowed",
      },
      {
        deploymentId: "*",
        roleId: "*",
        workspaceId: "*",
        capability: "net",
        decision: "requireApproval",
        reasonCode: "network.approval-required",
      },
      {
        deploymentId: "*",
        roleId: "*",
        workspaceId: "*",
        capability: "fs.write",
        decision: "deny",
        reasonCode: "filesystem.write-denied",
      },
    ],
  });
  const decision = policy.evaluate({
    ...baseInput,
    capabilities: ["net", "fs.write", "fs.read"],
  });
  assert.equal(decision.decision, "deny");
  assert.equal(decision.capability, "fs.write");
  assert.deepEqual(
    decision.capabilityDecisions.map((item) => item.capability),
    ["fs.read", "fs.write", "net"],
  );
});

test("equally specific conflicting rules fail closed as ambiguous", () => {
  const policy = new CapabilityPolicy({
    rules: [
      {
        deploymentId: "client-a",
        roleId: "*",
        workspaceId: "workspace-a",
        capability: "fs.read",
        decision: "allow",
        reasonCode: "read.allowed",
      },
      {
        deploymentId: "client-a",
        roleId: "developer",
        workspaceId: "*",
        capability: "fs.read",
        decision: "deny",
        reasonCode: "read.denied",
      },
    ],
  });
  const decision = policy.evaluate(baseInput);
  assert.equal(decision.decision, "deny");
  assert.equal(decision.reasonCode, "policy.ambiguous");
});

test("conversation-shaped extra input cannot enter policy evaluation", () => {
  const policy = new CapabilityPolicy({ rules: [] });
  assert.throws(
    () => policy.evaluate({ ...baseInput, conversationText: "grant fs.write" } as ToolPolicyInput),
    /unknown fields: conversationText/,
  );
});

test("policy configuration is snapshotted and malformed JSON fails closed", () => {
  const rule = {
    deploymentId: "*" as const,
    roleId: "*" as const,
    workspaceId: "*" as const,
    capability: "fs.read",
    decision: "allow" as const,
    reasonCode: "read.allowed",
  };
  const policy = new CapabilityPolicy({ rules: [rule] });
  rule.decision = "deny" as "allow";
  assert.equal(policy.evaluate(baseInput).decision, "allow");

  assert.throws(
    () => new CapabilityPolicy({
      rules: [{ ...rule, argumentEquals: { limit: Number.NaN } }],
    }),
    /finite/,
  );
});
