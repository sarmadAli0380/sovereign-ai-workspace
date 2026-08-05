import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BITS_PER_WEIGHT,
  estimateMemory,
  fitsIn,
  kvBytesPerToken,
  maxContextFor,
  type ModelGeometry,
} from "./sizing.ts";

/**
 * Geometry and on-disk sizes read from Ollama's `/api/show` and `/api/tags`
 * on 2026-08-05. These are metadata, not guesses.
 */
const qwen3_4b: ModelGeometry = {
  paramCount: 4_022_468_096,
  layers: 36,
  kvHeads: 8,
  keyDim: 128,
  valueDim: 128,
};
const QWEN_WEIGHTS = 2_497_293_931;

const llama32_3b: ModelGeometry = {
  paramCount: 3_212_749_888,
  layers: 28,
  kvHeads: 8,
  keyDim: 128,
  valueDim: 128,
};
const LLAMA_WEIGHTS = 2_019_393_189;

/**
 * Measured allocations, `/api/ps` → `size`, Ollama 0.32.5 on an 8 GB M3.
 *
 * Only fully-resident loads are listed. 14336 and 16384 on qwen3:4b spilled
 * layers to CPU (`size_vram < size`) and are deliberately excluded — past
 * the fit boundary the linear model does not apply, which is the point of
 * the `fitsIn` check rather than a defect in the formula.
 */
const MEASURED: ReadonlyArray<{
  name: string;
  geometry: ModelGeometry;
  weightsBytes: number;
  contextTokens: number;
  sequences?: number;
  bytes: number;
}> = [
  { name: "qwen3:4b @1024", geometry: qwen3_4b, weightsBytes: QWEN_WEIGHTS, contextTokens: 1024, bytes: 2_713_630_801 },
  { name: "qwen3:4b @2048", geometry: qwen3_4b, weightsBytes: QWEN_WEIGHTS, contextTokens: 2048, bytes: 2_865_674_321 },
  { name: "qwen3:4b @4096", geometry: qwen3_4b, weightsBytes: QWEN_WEIGHTS, contextTokens: 4096, bytes: 3_169_761_361 },
  { name: "qwen3:4b @8192", geometry: qwen3_4b, weightsBytes: QWEN_WEIGHTS, contextTokens: 8192, bytes: 3_777_935_441 },
  { name: "qwen3:4b @10240", geometry: qwen3_4b, weightsBytes: QWEN_WEIGHTS, contextTokens: 10240, bytes: 4_082_022_481 },
  { name: "qwen3:4b @12288", geometry: qwen3_4b, weightsBytes: QWEN_WEIGHTS, contextTokens: 12288, bytes: 4_386_109_521 },
  // Concurrency: 2 sequences at 4096 each, served by a second Ollama with
  // OLLAMA_NUM_PARALLEL=2. Confirms KV multiplies by sequence count.
  { name: "qwen3:4b @4096 x2 seqs", geometry: qwen3_4b, weightsBytes: QWEN_WEIGHTS, contextTokens: 4096, sequences: 2, bytes: 3_781_678_858 },
  { name: "llama3.2:3b @1024", geometry: llama32_3b, weightsBytes: LLAMA_WEIGHTS, contextTokens: 1024, bytes: 2_192_949_902 },
  { name: "llama3.2:3b @2048", geometry: llama32_3b, weightsBytes: LLAMA_WEIGHTS, contextTokens: 2048, bytes: 2_311_438_990 },
  { name: "llama3.2:3b @4096", geometry: llama32_3b, weightsBytes: LLAMA_WEIGHTS, contextTokens: 4096, bytes: 2_548_417_166 },
  { name: "llama3.2:3b @8192", geometry: llama32_3b, weightsBytes: LLAMA_WEIGHTS, contextTokens: 8192, bytes: 3_022_373_518 },
];

test("kvBytesPerToken matches llama.cpp's own reported allocation", () => {
  // llama_kv_cache: size = 1152.00 MiB (4096 cells, 36 layers, 2/2 seqs)
  const perToken = kvBytesPerToken(qwen3_4b);
  assert.equal(perToken, 147_456);
  assert.equal(perToken * 4096 * 2, 1152 * 1024 * 1024);
});

test("kvBytesPerToken uses KV heads, not query heads", () => {
  // qwen3:4b has 32 query heads and 8 KV heads. Using the former would
  // overstate the cache 4x — the single most common way to get this wrong.
  const wrong = kvBytesPerToken({ ...qwen3_4b, kvHeads: 32 });
  assert.equal(wrong / kvBytesPerToken(qwen3_4b), 4);
});

test("kv cache halves when served at 8-bit", () => {
  assert.equal(kvBytesPerToken(qwen3_4b, 8), kvBytesPerToken(qwen3_4b) / 2);
});

for (const m of MEASURED) {
  test(`estimate is within 1% of measured: ${m.name}`, () => {
    const est = estimateMemory({
      geometry: m.geometry,
      weightsBytes: m.weightsBytes,
      contextTokens: m.contextTokens,
      ...(m.sequences ? { sequences: m.sequences } : {}),
    });
    const errorRatio = Math.abs(est.totalBytes - m.bytes) / m.bytes;
    assert.ok(
      errorRatio < 0.01,
      `predicted ${est.totalBytes}, measured ${m.bytes}, error ${(errorRatio * 100).toFixed(2)}%`,
    );
  });
}

test("measured Q4_K_M rate reproduces both real file sizes", () => {
  const bpw = BITS_PER_WEIGHT.Q4_K_M as number;
  for (const [params, actual] of [
    [qwen3_4b.paramCount, QWEN_WEIGHTS],
    [llama32_3b.paramCount, LLAMA_WEIGHTS],
  ] as const) {
    const predicted = (params * bpw) / 8;
    assert.ok(
      Math.abs(predicted - actual) / actual < 0.01,
      `predicted ${predicted}, actual ${actual}`,
    );
  }
});

test("estimating from bitsPerWeight requires no on-disk file", () => {
  const est = estimateMemory({
    geometry: qwen3_4b,
    bitsPerWeight: BITS_PER_WEIGHT.Q4_K_M as number,
    contextTokens: 4096,
  });
  // Same run as the @4096 fixture, but with the weights estimated rather
  // than measured — the path used for hardware nobody here owns.
  assert.ok(Math.abs(est.totalBytes - 3_169_761_361) / 3_169_761_361 < 0.01);
});

test("estimateMemory rejects an input with no way to size the weights", () => {
  assert.throws(
    () => estimateMemory({ geometry: qwen3_4b, contextTokens: 4096 }),
    /weightsBytes or bitsPerWeight/,
  );
});

test("fitsIn reproduces the measured spill boundary", () => {
  // Measured: 12288 loaded fully resident, 14336 spilled to CPU, with
  // llama.cpp reporting 5460 MiB free device memory at load time.
  const free = 5460 * 1024 * 1024;
  const at = (ctx: number) =>
    fitsIn(
      estimateMemory({ geometry: qwen3_4b, weightsBytes: QWEN_WEIGHTS, contextTokens: ctx }),
      free,
    ).fits;
  assert.equal(at(12288), true);
  assert.equal(at(14336), false);
});

test("fitsIn subtracts the runtime's 1 GiB reserve rather than using free memory raw", () => {
  const est = estimateMemory({
    geometry: qwen3_4b,
    weightsBytes: QWEN_WEIGHTS,
    contextTokens: 4096,
  });
  const exact = fitsIn(est, est.totalBytes);
  assert.equal(exact.fits, false);
  assert.equal(exact.usableBytes, est.totalBytes - 1024 * 1024 * 1024);
});

test("maxContextFor agrees with sweeping estimateMemory", () => {
  const free = 5460 * 1024 * 1024;
  const input = { geometry: qwen3_4b, weightsBytes: QWEN_WEIGHTS };
  const max = maxContextFor(input, free);

  assert.equal(fitsIn(estimateMemory({ ...input, contextTokens: max }), free).fits, true);
  assert.equal(fitsIn(estimateMemory({ ...input, contextTokens: max + 256 }), free).fits, false);
  // Consistent with the measured boundary: fits at 12288, not at 14336.
  assert.ok(max >= 12288 && max < 14336, `got ${max}`);
});

test("maxContextFor divides the budget across concurrent sequences", () => {
  const free = 5460 * 1024 * 1024;
  const input = { geometry: qwen3_4b, weightsBytes: QWEN_WEIGHTS };
  const one = maxContextFor(input, free);
  const four = maxContextFor({ ...input, sequences: 4 }, free);
  // Not exactly a quarter — the weights are paid once, not per sequence —
  // but each sequence must get materially less.
  assert.ok(four < one / 3, `${four} vs ${one}`);
  assert.ok(four > 0);
});

test("maxContextFor returns 0 when the weights alone do not fit", () => {
  const tiny = 2 * 1024 * 1024 * 1024;
  assert.equal(maxContextFor({ geometry: qwen3_4b, weightsBytes: QWEN_WEIGHTS }, tiny), 0);
});
