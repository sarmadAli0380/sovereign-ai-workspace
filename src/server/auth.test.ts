import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  AuthenticationError,
  hasPermission,
  parseSessionRegistry,
  RegistrySessionAuthenticator,
} from "./auth.ts";

const token = "a".repeat(48);
const now = Date.parse("2026-08-25T12:00:00.000Z");

function registry(status: "active" | "revoked" = "active", expiresAt = "2026-08-25T13:00:00.000Z") {
  return parseSessionRegistry({
    schemaVersion: 1,
    sessions: [{
      sessionId: "session-1",
      userId: "user-1",
      tokenSha256: createHash("sha256").update(token).digest("hex"),
      roles: ["member"],
      allowedConfigKeys: ["local-qwen"],
      expiresAt,
      status,
    }],
  });
}

test("C1 auth: a valid bearer session produces a bounded principal", async () => {
  const authenticator = new RegistrySessionAuthenticator(registry());
  const principal = await authenticator.authenticate(`Bearer ${token}`, now);
  assert.deepEqual(principal, {
    sessionId: "session-1",
    userId: "user-1",
    roles: ["member"],
    allowedConfigKeys: ["local-qwen"],
  });
  assert.equal(hasPermission(principal, "conversation.run"), true);
  assert.equal(hasPermission(principal, "run.events"), true);
});

test("C1 auth: absent, malformed, unknown, expired, and revoked sessions fail closed", async () => {
  const active = new RegistrySessionAuthenticator(registry());
  const cases: Array<Promise<unknown>> = [
    active.authenticate(undefined, now),
    active.authenticate(`bearer ${token}`, now),
    active.authenticate(`Bearer ${"b".repeat(48)}`, now),
    new RegistrySessionAuthenticator(registry("active", "2026-08-25T11:00:00.000Z"))
      .authenticate(`Bearer ${token}`, now),
    new RegistrySessionAuthenticator(registry("revoked")).authenticate(`Bearer ${token}`, now),
  ];
  for (const operation of cases) {
    await assert.rejects(operation, (error) => error instanceof AuthenticationError);
  }
});

test("C1 auth: registry parsing rejects ambiguity and secret-shaped drift", () => {
  const base = structuredClone(registry()) as unknown as { sessions: Array<Record<string, unknown>> };
  base.sessions[0]!["roles"] = ["member", "member"];
  assert.throws(() => parseSessionRegistry(base), /duplicates/);

  const unknown = structuredClone(registry()) as unknown as { sessions: Array<Record<string, unknown>> };
  unknown.sessions[0]!["token"] = token;
  assert.throws(() => parseSessionRegistry(unknown), /unknown fields/);
});
