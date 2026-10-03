import assert from "node:assert/strict";
import test from "node:test";
import { OllamaRuntimeAdapter, parseOllamaProcessSnapshot } from "./ollama.ts";

test("parses running model identity, served context, allocation, and quantization", () => {
  const result = parseOllamaProcessSnapshot({ models: [{
    name: "qwen3:4b",
    model: "qwen3:4b",
    digest: "sha256:abc",
    size: 3_777_935_441,
    size_vram: 3_777_935_441,
    context_length: 8_192,
    expires_at: "2026-08-11T13:00:00Z",
    details: { quantization_level: "Q4_K_M" },
  }] }, {
    observedAt: "2026-08-11T12:00:00.000Z",
    freeMemoryBytes: 4_000_000_000,
    memorySource: "test",
  });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.models[0], {
    modelId: "qwen3:4b", digest: "sha256:abc", quantization: "Q4_K_M",
    servedContextWindow: 8_192, residentBytes: 3_777_935_441,
    acceleratorBytes: 3_777_935_441, expiresAt: "2026-08-11T13:00:00Z",
  });
});

test("malformed runner data becomes explicit issues rather than usable zeroes", () => {
  const result = parseOllamaProcessSnapshot({ models: [{ model: "qwen3:4b", context_length: 0, size: Number.NaN }] }, {
    observedAt: "bad", freeMemoryBytes: -1, memorySource: "test",
  });
  assert.equal(result.models.length, 0);
  assert.match(result.issues.join("\n"), /context_length is invalid/);
  assert.match(result.issues.join("\n"), /size is invalid/);
  assert.match(result.issues.join("\n"), /size_vram is invalid/);
});

test("adapter inspects /api/ps and loads with an explicit served context", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    if (url.endsWith("/api/ps")) return Response.json({ models: [] });
    return new Response("{}", { status: 200 });
  };
  const adapter = new OllamaRuntimeAdapter({
    baseUrl: "http://127.0.0.1:11434/",
    fetch: fakeFetch as typeof fetch,
    now: () => new Date("2026-08-11T12:00:00.000Z"),
    freeMemory: () => 5_000,
    memorySource: "fixture",
    keepAlive: "10m",
  });
  const inspected = await adapter.inspect();
  assert.equal(inspected.freeMemoryBytes, 5_000);
  assert.equal(inspected.memorySource, "fixture");
  await adapter.load({ modelId: "qwen3:4b", contextWindow: 8_192, signal: AbortSignal.timeout(1_000) });
  assert.equal(calls[0]?.url, "http://127.0.0.1:11434/api/ps");
  assert.equal(calls[1]?.url, "http://127.0.0.1:11434/api/generate");
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
    model: "qwen3:4b", prompt: "", stream: false, keep_alive: "10m", options: { num_ctx: 8_192 },
  });
});

test("adapter describes model geometry and measured weight size", async () => {
  const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/api/show")) return Response.json({
      model_info: {
        "general.parameter_count": 4_022_468_096,
        "qwen3.block_count": 36,
        "qwen3.attention.head_count_kv": 8,
        "qwen3.attention.key_length": 128,
        "qwen3.attention.value_length": 128,
      },
      details: { quantization_level: "Q4_K_M" },
    });
    return Response.json({ models: [{ name: "qwen3:4b", digest: "sha256:abc", size: 2_497_293_931 }] });
  };
  const described = await new OllamaRuntimeAdapter({ fetch: fakeFetch as typeof fetch }).describe("qwen3:4b");
  assert.deepEqual(described, {
    modelId: "qwen3:4b", digest: "sha256:abc", quantization: "Q4_K_M",
    geometry: { paramCount: 4_022_468_096, layers: 36, kvHeads: 8, keyDim: 128, valueDim: 128 },
    weightsBytes: 2_497_293_931,
  });
});

test("adapter rejects unsafe URLs and HTTP failures", async () => {
  assert.throws(() => new OllamaRuntimeAdapter({ baseUrl: "file:///tmp/ollama" }), /http or https/);
  const adapter = new OllamaRuntimeAdapter({
    fetch: (async () => new Response("no", { status: 503 })) as typeof fetch,
  });
  await assert.rejects(adapter.inspect(), /HTTP 503/);
});

test("default memory authority is unconfigured rather than os.freemem", async () => {
  const adapter = new OllamaRuntimeAdapter({
    fetch: (async () => Response.json({ models: [] })) as typeof fetch,
  });
  const snapshot = await adapter.inspect();
  assert.equal(Number.isNaN(snapshot.freeMemoryBytes), true);
  assert.equal(snapshot.memorySource, "unconfigured memory source");
});
