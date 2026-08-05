/**
 * 2.4 — Memory sizing calculator.
 *
 *   # geometry read from a live Ollama
 *   node scripts/size-model.ts --model qwen3:4b --budget 5.7
 *   node scripts/size-model.ts --model qwen3:4b --ctx 8192 --sequences 2
 *
 *   # a box nobody here owns: describe the model, ask what fits
 *   node scripts/size-model.ts --params 70e9 --layers 80 --kv-heads 8 \
 *     --head-dim 128 --quant Q4_K_M --budget 48
 *
 * With `--ctx` it prints one breakdown. Without, it sweeps a range of
 * contexts and marks where they stop fitting, which is usually the actual
 * question ("what context does this box buy me?").
 *
 * `--budget` is *free* memory in GB, not installed memory. On unified-memory
 * hardware they are very different numbers — see 2.4.
 */

import {
  BITS_PER_WEIGHT,
  estimateMemory,
  fitsIn,
  gb,
  kvBytesPerToken,
  maxContextFor,
  type ModelGeometry,
} from "../src/sizing.ts";

// --- arg parsing

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (!arg?.startsWith("--")) continue;
  const key = arg.slice(2);
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) {
    args.set(key, next);
    i += 1;
  } else {
    args.set(key, "true");
  }
}

function num(key: string, min = 0): number | undefined {
  const raw = args.get(key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    console.error(`✗ --${key} must be a number, got "${raw}"`);
    process.exit(1);
  }
  // Checked at the boundary as well as in `sizing.ts`. A negative context
  // used to print a negative total and "✓ fits — 17.21 GB headroom".
  if (value < min) {
    console.error(`✗ --${key} must be at least ${min}, got ${value}`);
    process.exit(1);
  }
  return value;
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

// --- geometry: either from a live Ollama, or from flags

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";

/**
 * GGUF metadata keys are architecture-prefixed (`qwen3.block_count`,
 * `llama.attention.head_count_kv`), so read by suffix rather than
 * hardcoding a family — the same reason there are no provider names in the
 * harness's control flow.
 */
function readGguf(info: Record<string, unknown>, suffix: string): number | undefined {
  for (const [key, value] of Object.entries(info)) {
    if (key.endsWith(suffix) && typeof value === "number") return value;
  }
  return undefined;
}

async function fromOllama(
  tag: string,
): Promise<{ geometry: ModelGeometry; weightsBytes?: number; quant?: string }> {
  let show: Response;
  try {
    show = await fetch(`${OLLAMA_HOST}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: tag }),
    });
  } catch (cause) {
    fail(`could not reach Ollama at ${OLLAMA_HOST} — is \`ollama serve\` running?\n  ${cause}`);
  }
  if (!show.ok) fail(`Ollama returned ${show.status} for "${tag}" — is it pulled?`);

  const body = (await show.json()) as {
    model_info?: Record<string, unknown>;
    details?: { quantization_level?: string };
  };
  const info = body.model_info ?? {};

  const geometry: Partial<ModelGeometry> = {
    paramCount: readGguf(info, "general.parameter_count") ?? readGguf(info, "parameter_count"),
    layers: readGguf(info, ".block_count"),
    kvHeads: readGguf(info, ".attention.head_count_kv"),
    keyDim: readGguf(info, ".attention.key_length"),
    valueDim: readGguf(info, ".attention.value_length"),
  };

  for (const [field, value] of Object.entries(geometry)) {
    if (value === undefined) fail(`Ollama's metadata for "${tag}" has no ${field}`);
  }

  // On-disk size is a measurement; prefer it over params x bits-per-weight.
  let weightsBytes: number | undefined;
  try {
    const tags = (await (await fetch(`${OLLAMA_HOST}/api/tags`)).json()) as {
      models?: Array<{ name: string; size: number }>;
    };
    weightsBytes = tags.models?.find((m) => m.name === tag)?.size;
  } catch {
    // Non-fatal: fall back to estimating from the quantization rate.
  }

  return {
    geometry: geometry as ModelGeometry,
    ...(weightsBytes ? { weightsBytes } : {}),
    ...(body.details?.quantization_level ? { quant: body.details.quantization_level } : {}),
  };
}

const tag = args.get("model");
let geometry: ModelGeometry;
let weightsBytes: number | undefined;
let quant = args.get("quant");
let label: string;

if (tag) {
  const resolved = await fromOllama(tag);
  geometry = resolved.geometry;
  weightsBytes = resolved.weightsBytes;
  quant ??= resolved.quant;
  label = tag;
} else {
  const paramCount = num("params");
  const layers = num("layers");
  const kvHeads = num("kv-heads");
  const headDim = num("head-dim") ?? 128;
  if (paramCount === undefined || layers === undefined || kvHeads === undefined) {
    fail(
      "need either --model <ollama-tag>, or --params --layers --kv-heads " +
        "(--head-dim defaults to 128).\n" +
        "  --kv-heads is num_key_value_heads, NOT num_attention_heads.",
    );
  }
  geometry = { paramCount, layers, kvHeads, keyDim: headDim, valueDim: headDim };
  quant ??= "Q4_K_M";
  label = `${(paramCount / 1e9).toFixed(1)}B custom`;
}

const bitsPerWeight = BITS_PER_WEIGHT[quant ?? "Q4_K_M"];
if (bitsPerWeight === undefined) {
  fail(`unknown --quant "${quant}". Known: ${Object.keys(BITS_PER_WEIGHT).join(", ")}`);
}

const kvCacheBits = num("kv-bits", 1) ?? 16;
const sequences = num("sequences", 1) ?? 1;
const budgetGb = num("budget");
const freeBytes = budgetGb === undefined ? undefined : budgetGb * 1e9;

const base = {
  geometry,
  sequences,
  kvCacheBits,
  bitsPerWeight,
  ...(weightsBytes ? { weightsBytes } : {}),
};

// --- report

console.log(`\nmodel:        ${label}`);
console.log(
  `params:       ${(geometry.paramCount / 1e9).toFixed(2)}B` +
    `   layers ${geometry.layers}   kv-heads ${geometry.kvHeads}   head-dim ${geometry.keyDim}`,
);
console.log(
  `weights:      ${gb(weightsBytes ?? (geometry.paramCount * bitsPerWeight) / 8)} GB` +
    `   (${quant}, ${bitsPerWeight} bits/weight${weightsBytes ? ", from on-disk size" : ", estimated"})`,
);
console.log(
  `kv cache:     ${(kvBytesPerToken(geometry, kvCacheBits) / 1024).toFixed(0)} KiB/token/sequence` +
    `   (${kvCacheBits}-bit cache)`,
);
if (sequences > 1) console.log(`sequences:    ${sequences} concurrent`);
if (freeBytes !== undefined) console.log(`free memory:  ${budgetGb} GB (1 GiB reserved by the runtime)`);

// Sizing rejects inputs that cannot describe a real deployment. Surface that
// as advice rather than as a stack trace — this tool exists to answer a
// hardware question, so an unusable answer must read like one.
try {
  estimateMemory({ ...base, contextTokens: 0 });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const ctx = num("ctx");
if (ctx !== undefined) {
  const est = estimateMemory({ ...base, contextTokens: ctx });
  console.log(`\ncontext:      ${ctx} tokens x ${sequences}`);
  console.log(`  weights     ${gb(est.weightsBytes).toFixed(2)} GB`);
  console.log(`  kv cache    ${gb(est.kvBytes).toFixed(2)} GB`);
  console.log(`  runtime     ${gb(est.runtimeBytes + est.fixedOverheadBytes).toFixed(2)} GB`);
  console.log(`  ---------   -------`);
  console.log(`  total       ${gb(est.totalBytes).toFixed(2)} GB`);
  if (freeBytes !== undefined) {
    const verdict = fitsIn(est, freeBytes);
    console.log(
      `\n${verdict.fits ? "✓ fits" : "✗ does not fit"} — ` +
        `${gb(Math.abs(verdict.headroomBytes)).toFixed(2)} GB ` +
        `${verdict.fits ? "headroom" : "over budget"}`,
    );
    if (!verdict.fits) {
      console.log(
        `  past this point layers spill to CPU: the model still answers, but\n` +
          `  throughput falls off a cliff and memory stops scaling linearly.`,
      );
    }
  }
} else {
  const sweep = [2048, 4096, 8192, 16384, 32768, 65536, 131072];
  console.log(`\n  context   kv cache     total${freeBytes !== undefined ? "     fits?" : ""}`);
  console.log(`  --------  ---------  ---------${freeBytes !== undefined ? "  -------" : ""}`);
  for (const c of sweep) {
    const est = estimateMemory({ ...base, contextTokens: c });
    const verdict = freeBytes === undefined ? undefined : fitsIn(est, freeBytes);
    console.log(
      `  ${String(c).padStart(7)}  ` +
        `${(gb(est.kvBytes).toFixed(2) + " GB").padStart(9)}  ` +
        `${(gb(est.totalBytes).toFixed(2) + " GB").padStart(9)}` +
        (verdict ? `  ${verdict.fits ? "   yes" : "   no "}` : ""),
    );
  }
  if (freeBytes !== undefined) {
    const max = maxContextFor(base, freeBytes);
    console.log(
      max > 0
        ? `\nmax context:  ${max} tokens${sequences > 1 ? ` per sequence, x${sequences}` : ""}`
        : `\n✗ the weights alone do not fit in ${budgetGb} GB.`,
    );
  } else {
    console.log(`\nPass --budget <free GB> for fit verdicts and a max context.`);
  }
}
console.log();
