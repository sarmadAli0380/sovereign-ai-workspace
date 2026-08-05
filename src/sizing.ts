/**
 * 2.4 — Memory sizing math.
 *
 * Answers "how much memory does serving this model at this context cost?"
 * from the model's architecture rather than from a lookup table, so it
 * generalises to models nobody here has run.
 *
 * Every constant below is measured, not quoted — see
 * `phase2/adrs/2.4-sizing-math.md` for the runs. The headline result is
 * that total memory is *exactly* linear in context while the model stays
 * resident on the accelerator:
 *
 *   total = weights + fixedOverhead + contextTokens × sequences × perToken
 *
 * and that linearity breaks the moment the allocation no longer fits,
 * because layers spill to CPU. So the useful output of this module is not
 * one number, it is a number plus whether it fits.
 *
 * This module is deliberately free of any pi-ai or Ollama dependency — it
 * is arithmetic over published model metadata, usable for a client's box
 * that nobody has touched yet.
 */

/**
 * The attention geometry that determines KV cache size, as reported by
 * GGUF metadata (`/api/show` → `model_info`) or a HuggingFace `config.json`.
 *
 * GGUF keys are prefixed by architecture, e.g. `qwen3.block_count`,
 * `llama.attention.head_count_kv`. HF names are given per field.
 */
export interface ModelGeometry {
  /** Total parameters. GGUF `general.parameter_count`. */
  paramCount: number;
  /** Transformer blocks. GGUF `*.block_count`; HF `num_hidden_layers`. */
  layers: number;
  /**
   * Key/value heads — NOT query heads. GGUF `*.attention.head_count_kv`;
   * HF `num_key_value_heads`.
   *
   * This is the field that makes the difference between a right answer and
   * a 3-4x overestimate on any modern model: grouped-query attention gives
   * qwen3:4b 32 query heads but only 8 KV heads, and only the KV heads are
   * cached. Using `head_count` here is the most common way to get this
   * calculation wrong.
   */
  kvHeads: number;
  /** GGUF `*.attention.key_length`; HF `head_dim`. */
  keyDim: number;
  /** GGUF `*.attention.value_length`. Equal to `keyDim` on every model measured. */
  valueDim: number;
}

export interface SizingInput {
  geometry: ModelGeometry;
  /** Context length per sequence, in tokens — what the server actually serves. */
  contextTokens: number;
  /**
   * Concurrent sequences the server keeps resident (Ollama's
   * `OLLAMA_NUM_PARALLEL`, vLLM's max concurrent sequences).
   *
   * KV cache is per sequence, so this multiplies. Default 1.
   */
  sequences?: number;
  /**
   * Bits per weight for the quantization in use. See `BITS_PER_WEIGHT`.
   * Ignored when `weightsBytes` is supplied.
   */
  bitsPerWeight?: number;
  /**
   * Known on-disk weight size, used in preference to
   * `paramCount × bitsPerWeight`. Prefer this when the file exists — it is
   * a measurement rather than an estimate.
   */
  weightsBytes?: number;
  /**
   * Bits per KV cache element. 16 (f16) is the default everywhere measured.
   * llama.cpp can serve 8 (`q8_0`) or 4 (`q4_0`) via `OLLAMA_KV_CACHE_TYPE`,
   * which scales the cache term directly.
   */
  kvCacheBits?: number;
}

export interface SizingEstimate {
  weightsBytes: number;
  /** KV cache bytes for ONE token of ONE sequence. */
  kvBytesPerToken: number;
  /** KV cache across all sequences at full context. */
  kvBytes: number;
  /** Non-KV per-token runtime cost, measured at 1 KiB/token. */
  runtimeBytes: number;
  /** Context-independent runtime cost (tokenizer caches, compute buffers). */
  fixedOverheadBytes: number;
  totalBytes: number;
}

/**
 * Non-KV memory that still scales with context, measured at exactly
 * 1024 bytes per token.
 *
 * [VERIFIED] Identical on qwen3:4b (36 layers) and llama3.2:3b (28 layers),
 * so it is per-token and not per-layer-per-token. Derived as the gap between
 * the architectural KV formula and Ollama's measured allocation slope:
 *
 *   qwen3:4b    measured 148,480 B/token − KV 147,456 = 1024
 *   llama3.2:3b measured 115,712 B/token − KV 114,688 = 1024
 *
 * It is ~0.7% of the per-token cost, so it matters for reconciling a
 * measurement, not for sizing a purchase.
 */
export const RUNTIME_BYTES_PER_TOKEN = 1024;

/**
 * Context-independent overhead beyond the weights themselves: tokenizer
 * caches, output buffer, compute graph buffers.
 *
 * [VERIFIED] as the intercept of the measured lines, minus the on-disk
 * weight size: 64.3 MB on qwen3:4b, 55.1 MB on llama3.2:3b. Both are under
 * 0.07 GB, so the conservative end is taken rather than modelled — the
 * error is smaller than the rounding on any real memory budget.
 */
export const FIXED_OVERHEAD_BYTES = 64_000_000;

/**
 * Bits per weight by quantization.
 *
 * `Q4_K_M` is [VERIFIED] — measured from the on-disk size of two real GGUF
 * files, 4.97 bpw (qwen3:4b) and 5.03 bpw (llama3.2:3b). Note this is above
 * the ~4.8 usually quoted: K-quants keep the embedding and output tensors
 * at higher precision, so the effective rate rises as the vocabulary grows
 * relative to the model. Both models here have large vocabularies for their
 * size, which is exactly the case where the quoted figure runs low.
 *
 * The rest are [UNVERIFIED] reference values from llama.cpp's quantization
 * scheme, carried so the calculator can answer questions about hardware
 * nobody here owns. Treat them as ±5%, and prefer a real file size when one
 * exists.
 */
export const BITS_PER_WEIGHT: Readonly<Record<string, number>> = {
  F32: 32,
  F16: 16,
  BF16: 16,
  Q8_0: 8.5,
  Q6_K: 6.6,
  Q5_K_M: 5.7,
  Q5_K_S: 5.5,
  /** Measured. See note above on why this exceeds the commonly quoted 4.8. */
  Q4_K_M: 5.0,
  Q4_K_S: 4.6,
  Q4_0: 4.5,
  Q3_K_M: 3.9,
  Q2_K: 3.4,
  /** GPU-serving formats (2.3). Not loadable here; included for advising. */
  AWQ_4BIT: 4.25,
  GPTQ_4BIT: 4.25,
};

/**
 * KV cache bytes for one token of one sequence.
 *
 * [VERIFIED] against llama.cpp's own allocation report rather than inferred:
 * serving qwen3:4b at 4096 context with 2 parallel sequences, it logs
 *
 *   llama_kv_cache: size = 1152.00 MiB (4096 cells, 36 layers, 2/2 seqs),
 *                   K (f16): 576.00 MiB, V (f16): 576.00 MiB
 *
 * 1152 MiB / 2 seqs / 4096 tokens = 147,456 B, which is what this returns.
 */
export function kvBytesPerToken(geometry: ModelGeometry, kvCacheBits = 16): number {
  const { layers, kvHeads, keyDim, valueDim } = geometry;
  return layers * kvHeads * (keyDim + valueDim) * (kvCacheBits / 8);
}

export function estimateMemory(input: SizingInput): SizingEstimate {
  const {
    geometry,
    contextTokens,
    sequences = 1,
    bitsPerWeight,
    weightsBytes: given,
    kvCacheBits = 16,
  } = input;

  if (given === undefined && bitsPerWeight === undefined) {
    throw new Error("estimateMemory requires either weightsBytes or bitsPerWeight");
  }

  const weightsBytes = given ?? (geometry.paramCount * (bitsPerWeight as number)) / 8;
  const perToken = kvBytesPerToken(geometry, kvCacheBits);
  const cells = contextTokens * sequences;
  const kvBytes = perToken * cells;
  const runtimeBytes = RUNTIME_BYTES_PER_TOKEN * cells;

  return {
    weightsBytes,
    kvBytesPerToken: perToken,
    kvBytes,
    runtimeBytes,
    fixedOverheadBytes: FIXED_OVERHEAD_BYTES,
    totalBytes: weightsBytes + kvBytes + runtimeBytes + FIXED_OVERHEAD_BYTES,
  };
}

/**
 * Headroom the runtime refuses to consume, in bytes.
 *
 * [VERIFIED] llama.cpp's parameter fitting logs its own rule on load:
 *
 *   projected to use 3606 MiB of device memory vs 5460 MiB of free device memory
 *   will leave 1854 >= 1024 MiB of free device memory, no changes needed
 *
 * So the budget is not "total memory" and not even "free memory" — it is
 * free memory minus 1 GiB. Sizing against total memory overstates capacity
 * by that much plus whatever else is running.
 */
export const DEVICE_MEMORY_RESERVE_BYTES = 1024 * 1024 * 1024;

export interface FitVerdict {
  fits: boolean;
  /** Bytes of usable budget after the runtime's own reserve. */
  usableBytes: number;
  /** Positive when it fits, negative by the amount it overruns. */
  headroomBytes: number;
}

/**
 * Whether an estimate fits a given amount of *free* memory.
 *
 * Pass free memory at load time, not installed memory. On unified-memory
 * hardware (2.3) the OS and every other process draw on the same pool, so
 * the ceiling moves between runs — measured directly here: qwen3:4b served
 * 12288 tokens fully resident and spilled to CPU at 14336, with the spill
 * point set by what else was open, not by a property of the machine.
 */
export function fitsIn(estimate: SizingEstimate, freeBytes: number): FitVerdict {
  const usableBytes = Math.max(0, freeBytes - DEVICE_MEMORY_RESERVE_BYTES);
  return {
    fits: estimate.totalBytes <= usableBytes,
    usableBytes,
    headroomBytes: usableBytes - estimate.totalBytes,
  };
}

/**
 * The largest context that fits a memory budget, rounded down to a multiple
 * of 256 tokens.
 *
 * This is the question a client actually asks — they have a box, they want
 * to know what context it buys — so it is solved directly rather than by
 * making the caller sweep `estimateMemory`.
 */
export function maxContextFor(
  input: Omit<SizingInput, "contextTokens">,
  freeBytes: number,
  granularity = 256,
): number {
  const base = estimateMemory({ ...input, contextTokens: 0 });
  const usable = Math.max(0, freeBytes - DEVICE_MEMORY_RESERVE_BYTES);
  const perCell =
    kvBytesPerToken(input.geometry, input.kvCacheBits ?? 16) + RUNTIME_BYTES_PER_TOKEN;
  const cells = Math.floor((usable - base.totalBytes) / perCell);
  const perSequence = Math.floor(cells / (input.sequences ?? 1));
  if (perSequence <= 0) return 0;
  return Math.floor(perSequence / granularity) * granularity;
}

/** Bytes as GB (10^9), matching how Ollama's own `/api/ps` numbers read. */
export function gb(bytes: number): number {
  return Math.round((bytes / 1e9) * 100) / 100;
}
