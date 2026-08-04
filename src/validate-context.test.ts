import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/pi-ai";
import { collectContextIssues, validateContext } from "./validate-context.ts";
import { HarnessError } from "./types.ts";

function userContext(): Context {
  return { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] };
}

test("accepts a minimal valid context", () => {
  assert.deepEqual(collectContextIssues(userContext()), []);
});

test("ADR check 1 — rejects empty messages", () => {
  const issues = collectContextIssues({ messages: [] });
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.path, "messages");
});

test("ADR check 2 — rejects a tool with no parameters schema", () => {
  const context: Context = {
    ...userContext(),
    tools: [{ name: "broken", description: "d", parameters: undefined as never }],
  };
  const issues = collectContextIssues(context);
  assert.equal(issues.length, 1);
  assert.match(issues[0]!.message, /no parameters schema/);
});

test("ADR check 2 — rejects a non-object parameters schema", () => {
  const context: Context = {
    ...userContext(),
    tools: [{ name: "broken", description: "d", parameters: Type.String() as never }],
  };
  const issues = collectContextIssues(context);
  assert.match(issues[0]!.message, /must be an object schema/);
});

test("ADR check 2 — accepts a well-formed TypeBox tool", () => {
  const context: Context = {
    ...userContext(),
    tools: [
      {
        name: "get_weather",
        description: "Get weather for a city",
        parameters: Type.Object({ city: Type.String() }),
      },
    ],
  };
  assert.deepEqual(collectContextIssues(context), []);
});

test("ADR check 3 — rejects an unknown configKey", () => {
  const issues = collectContextIssues(userContext(), "nope", ["claude-default", "gpt-default"]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.path, "configKey");
  assert.match(issues[0]!.message, /claude-default, gpt-default/);
});

test("skips the configKey check when no known keys are supplied", () => {
  assert.deepEqual(collectContextIssues(userContext(), "anything"), []);
});

test("catches `required` naming an undefined property", () => {
  const context: Context = {
    ...userContext(),
    tools: [
      {
        name: "t",
        description: "d",
        parameters: { type: "object", properties: { a: { type: "string" } }, required: ["b"] } as never,
      },
    ],
  };
  const issues = collectContextIssues(context);
  assert.match(issues[0]!.message, /marks "b" as required/);
});

test("catches duplicate tool names", () => {
  const schema = Type.Object({});
  const context: Context = {
    ...userContext(),
    tools: [
      { name: "dupe", description: "a", parameters: schema },
      { name: "dupe", description: "b", parameters: schema },
    ],
  };
  const issues = collectContextIssues(context);
  assert.equal(issues.length, 1);
  assert.match(issues[0]!.message, /Duplicate tool name/);
});

test("reports every issue at once, not just the first", () => {
  const context: Context = {
    messages: [],
    tools: [{ name: "", description: "d", parameters: undefined as never }],
  };
  const issues = collectContextIssues(context, "bad", ["good"]);
  assert.equal(issues.length, 4); // configKey, messages, tool name, tool parameters
});

test("validateContext throws HarnessError with kind unknownConfigKey", () => {
  assert.throws(
    () => validateContext(userContext(), "nope", ["yes"]),
    (error: unknown) => error instanceof HarnessError && error.kind === "unknownConfigKey",
  );
});

test("validateContext throws kind invalidContext for context problems", () => {
  assert.throws(
    () => validateContext({ messages: [] }),
    (error: unknown) => error instanceof HarnessError && error.kind === "invalidContext",
  );
});

test("validateContext is silent on a valid context", () => {
  assert.doesNotThrow(() => validateContext(userContext(), "ok", ["ok"]));
});

test("REGRESSION: a null tool entry is reported, not thrown as a TypeError", () => {
  const context = { ...userContext(), tools: [null as never] };
  const issues = collectContextIssues(context);
  assert.equal(issues.length, 1);
  assert.match(issues[0]!.message, /not an object/);
});

test("REGRESSION: a null context is reported, not thrown", () => {
  const issues = collectContextIssues(null as never);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.path, "context");
});

test("REGRESSION: a tool name the provider would reject is caught pre-flight", () => {
  const context: Context = {
    ...userContext(),
    tools: [{ name: "get weather", description: "d", parameters: Type.Object({}) }],
  };
  const issues = collectContextIssues(context);
  assert.equal(issues.length, 1);
  assert.match(issues[0]!.message, /a-zA-Z0-9_-/);
});

test("ordinary tool names still pass", () => {
  const context: Context = {
    ...userContext(),
    tools: [{ name: "get_weather-2", description: "d", parameters: Type.Object({}) }],
  };
  assert.deepEqual(collectContextIssues(context), []);
});
