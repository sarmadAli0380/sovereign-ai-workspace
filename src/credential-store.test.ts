import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential } from "@earendil-works/pi-ai";
import { FileCredentialStore } from "./credential-store.ts";

function tempStore(): FileCredentialStore {
  const dir = mkdtempSync(join(tmpdir(), "harness-creds-"));
  return new FileCredentialStore(join(dir, "creds.json"));
}

function apiKey(key: string): Credential {
  return { type: "api_key", key } as Credential;
}

test("round-trips a credential", async () => {
  const store = tempStore();
  await store.modify("anthropic", async () => apiKey("A"));
  assert.equal((await store.read("anthropic"))?.type, "api_key");
});

test("a missing file reads as no credentials", async () => {
  const store = tempStore();
  assert.equal(await store.read("anthropic"), undefined);
  assert.deepEqual(await store.list(), []);
});

test("modify returning undefined leaves the entry unchanged", async () => {
  const store = tempStore();
  await store.modify("anthropic", async () => apiKey("A"));
  await store.modify("anthropic", async () => undefined);
  assert.deepEqual(await store.read("anthropic"), apiKey("A"));
});

test("delete removes only its own entry", async () => {
  const store = tempStore();
  await store.modify("a", async () => apiKey("a1"));
  await store.modify("b", async () => apiKey("b1"));
  await store.delete("a");

  assert.equal(await store.read("a"), undefined);
  assert.deepEqual(await store.read("b"), apiKey("b1"));
});

test("the credential file is written 0600", async () => {
  const store = tempStore();
  await store.modify("anthropic", async () => apiKey("A"));
  const mode = statSync(store["path" as keyof FileCredentialStore] as unknown as string).mode;
  assert.equal(mode & 0o777, 0o600);
});

// --- regression found by the QA pass, 2026-08-04

test("REGRESSION: concurrent writes to DIFFERENT providers do not clobber each other", async () => {
  const store = tempStore();
  await store.modify("anthropic", async () => apiKey("A-original"));
  await store.modify("openai-codex", async () => apiKey("C-original"));

  // Both providers refresh at once — pi-ai runs OAuth refresh inside modify(),
  // so this is the real concurrent path, not a contrived one. Writes are a
  // whole-file read-modify-write, so a per-provider lock would let one
  // overwrite the other's rotated token while reporting success.
  await Promise.all([
    store.modify("anthropic", async (current) => {
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(current, "should see the existing credential");
      return apiKey("A-REFRESHED");
    }),
    store.modify("openai-codex", async () => {
      await new Promise((r) => setTimeout(r, 5));
      return apiKey("C-REFRESHED");
    }),
  ]);

  assert.deepEqual(await store.read("anthropic"), apiKey("A-REFRESHED"));
  assert.deepEqual(await store.read("openai-codex"), apiKey("C-REFRESHED"));
});

test("REGRESSION: a delete cannot be undone by an in-flight modify of another provider", async () => {
  const store = tempStore();
  await store.modify("a", async () => apiKey("a1"));
  await store.modify("b", async () => apiKey("b1"));

  await Promise.all([
    store.modify("b", async () => {
      await new Promise((r) => setTimeout(r, 20));
      return apiKey("b2");
    }),
    store.delete("a"),
  ]);

  assert.equal(await store.read("a"), undefined, "deleted credential must not come back");
  assert.deepEqual(await store.read("b"), apiKey("b2"));
});

test("many concurrent writes all land", async () => {
  const store = tempStore();
  const ids = Array.from({ length: 25 }, (_, i) => `p${i}`);

  await Promise.all(ids.map((id) => store.modify(id, async () => apiKey(id))));

  const listed = await store.list();
  assert.equal(listed.length, 25);
  for (const id of ids) assert.deepEqual(await store.read(id), apiKey(id));
});
