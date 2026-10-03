import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import type { ToolCall } from "@earendil-works/pi-ai";
import { CapabilityPolicy } from "./policy.ts";
import {
  fetchWithHttpPolicy,
  ToolExecutionController,
  validateShellExecution,
  WorkspaceConfinement,
} from "./tool-execution.ts";
import {
  dispatchToolCall,
  ToolRegistry,
  type ToolControlDeclaration,
} from "./tool-registry.ts";

const allow = new CapabilityPolicy({
  rules: [{
    deploymentId: "*",
    roleId: "*",
    workspaceId: "*",
    capability: "*",
    decision: "allow",
    reasonCode: "test.allowed",
  }],
});

function controls(overrides: Partial<ToolControlDeclaration> = {}): ToolControlDeclaration {
  return {
    capabilities: ["net"],
    risk: "low",
    timeoutMs: 1_000,
    maxOutputChars: 10_000,
    concurrencyCost: 1,
    sideEffect: "none",
    idempotency: "natural",
    ...overrides,
  };
}

function call(id: string): ToolCall {
  return { type: "toolCall", id, name: "controlled", arguments: {} };
}

function options(controller: ToolExecutionController, idempotencyKeys?: Record<string, string>) {
  return {
    policy: allow,
    policyContext: { deploymentId: "dep", roleId: "role", workspaceId: "work" },
    executionController: controller,
    ...(idempotencyKeys ? { idempotencyKeys } : {}),
  };
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((block) => block.type === "text" ? block.text ?? "" : "").join("");
}

test("A2.2: per-tool timeout aborts cooperatively and returns a model-visible error", async () => {
  const registry = new ToolRegistry();
  registry.register({
    definition: { name: "controlled", description: "d", parameters: Type.Object({}) },
    controls: controls({ timeoutMs: 20 }),
    async execute(_args, context) {
      await new Promise<void>((_resolve, reject) => {
        context?.signal?.addEventListener("abort", () => reject(context.signal?.reason), { once: true });
      });
      return { content: [] };
    },
  });
  const controller = new ToolExecutionController({ globalCapacity: 1, defaultCapabilityCapacity: 1 });
  const result = await dispatchToolCall(call("timeout"), registry, options(controller));
  assert.equal(result.isError, true);
  assert.match(text(result), /execution\.timeout/);
});

test("A2.2: global and per-capability cost reject excess work without an unbounded queue", async () => {
  const registry = new ToolRegistry();
  let release!: () => void;
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => { started = resolve; });
  registry.register({
    definition: { name: "controlled", description: "d", parameters: Type.Object({}) },
    controls: controls(),
    async execute() {
      started();
      await new Promise<void>((resolve) => { release = resolve; });
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
  const controller = new ToolExecutionController({ globalCapacity: 1, defaultCapabilityCapacity: 1 });
  const first = dispatchToolCall(call("first"), registry, options(controller));
  await didStart;
  const second = await dispatchToolCall(call("second"), registry, options(controller));
  assert.equal(second.isError, true);
  assert.match(text(second), /execution\.concurrency-limit/);
  release();
  assert.equal((await first).isError, false);
});

test("A2.2: a rejected start acknowledgement releases capacity before execution", async () => {
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register({
    definition: { name: "controlled", description: "d", parameters: Type.Object({}) },
    controls: controls(),
    async execute() {
      executions += 1;
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
  const controller = new ToolExecutionController({ globalCapacity: 1, defaultCapabilityCapacity: 1 });
  await assert.rejects(
    dispatchToolCall(call("rejected"), registry, {
      ...options(controller),
      onStarted: () => { throw new Error("journal unavailable"); },
    }),
    /journal unavailable/,
  );
  const next = await dispatchToolCall(call("next"), registry, options(controller));
  assert.equal(next.isError, false);
  assert.equal(executions, 1);
});

test("A2.2: oversized handler output is replaced before lifecycle/model exposure", async () => {
  const registry = new ToolRegistry();
  registry.register({
    definition: { name: "controlled", description: "d", parameters: Type.Object({}) },
    controls: controls({ maxOutputChars: 30 }),
    async execute() {
      return { content: [{ type: "text", text: "secret".repeat(100) }] };
    },
  });
  const controller = new ToolExecutionController({ globalCapacity: 1, defaultCapabilityCapacity: 1 });
  let observed = "";
  const result = await dispatchToolCall(call("large"), registry, {
    ...options(controller),
    onCompleted: (_call, completed) => { observed = text(completed); },
  });
  assert.equal(result.isError, true);
  assert.equal(observed, "execution.output-limit-exceeded");
  assert.ok(!observed.includes("secret"));
});

test("A2.2: caller-key side effects require a key and replay without executing twice", async () => {
  const registry = new ToolRegistry();
  let executions = 0;
  registry.register({
    definition: { name: "controlled", description: "d", parameters: Type.Object({}) },
    controls: controls({ sideEffect: "reversible", idempotency: "callerKey" }),
    async execute() {
      executions += 1;
      return { content: [{ type: "text", text: `run-${executions}` }] };
    },
  });
  const controller = new ToolExecutionController({ globalCapacity: 1, defaultCapabilityCapacity: 1 });
  const missing = await dispatchToolCall(call("missing"), registry, options(controller));
  assert.match(text(missing), /idempotency-key-required/);
  const first = await dispatchToolCall(call("one"), registry, options(controller, { one: "stable" }));
  const replay = await dispatchToolCall(call("two"), registry, options(controller, { two: "stable" }));
  assert.equal(executions, 1);
  assert.equal(text(first), "run-1");
  assert.equal(text(replay), "run-1");
  assert.equal(replay.toolCallId, "two");
});

test("A2.2: workspace confinement follows symlinks and blocks an escape", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-root-"));
  const outside = await mkdtemp(join(tmpdir(), "workspace-outside-"));
  try {
    await mkdir(join(root, "inside"));
    await writeFile(join(root, "inside", "ok.txt"), "ok");
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(root, "escape"));
    const workspace = await WorkspaceConfinement.create(root);
    assert.equal(await workspace.existing("inside/ok.txt"), join(workspace.root, "inside", "ok.txt"));
    await assert.rejects(workspace.existing("escape/secret.txt"), /workspace\.path-escape/);
    await assert.rejects(workspace.forCreate("escape/new.txt"), /workspace\.path-escape/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("A2.2: shell policy fixes executable, cwd, arguments, and environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "shell-root-"));
  try {
    const workspace = await WorkspaceConfinement.create(root);
    const policy = {
      allowedExecutables: ["/usr/bin/git"],
      allowedEnvironmentKeys: ["LANG"],
      maxArguments: 4,
      maxArgumentChars: 100,
    };
    const validated = await validateShellExecution(
      { executable: "/usr/bin/git", args: ["status"], cwd: ".", environment: { LANG: "C" } },
      policy,
      workspace,
    );
    assert.equal(validated.cwd, workspace.root);
    await assert.rejects(
      validateShellExecution({ executable: "/bin/sh", args: ["-c", "pwd"], cwd: "." }, policy, workspace),
      /shell\.executable-denied/,
    );
    await assert.rejects(
      validateShellExecution({ executable: "/usr/bin/git", args: [], cwd: ".", environment: { PATH: "/tmp" } }, policy, workspace),
      /shell\.environment-denied/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("A2.2: HTTP redirects are re-resolved and response bytes are bounded", async () => {
  const policy = {
    allowedSchemes: ["https:" as const],
    maxRedirects: 2,
    maxResponseBytes: 4,
  };
  let calls = 0;
  await assert.rejects(
    fetchWithHttpPolicy("https://public.example/start", policy, {}, {
      resolveHost: async (host) => host === "public.example" ? ["93.184.216.34"] : ["127.0.0.1"],
      fetch: (async () => {
        calls += 1;
        return new Response(null, { status: 302, headers: { location: "https://internal.example/secret" } });
      }) as typeof fetch,
    }),
    /http\.destination-denied/,
  );
  assert.equal(calls, 1, "the redirected private destination must be blocked before a second fetch");

  await assert.rejects(
    fetchWithHttpPolicy("https://public.example/large", policy, {}, {
      resolveHost: async () => ["93.184.216.34"],
      fetch: (async () => new Response("12345")) as typeof fetch,
    }),
    /http\.response-too-large/,
  );
});
