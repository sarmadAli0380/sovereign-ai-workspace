import assert from "node:assert/strict";
import test from "node:test";
import {
  embeddingManifestDigest,
  parseLocalEmbeddingManifest,
  vectorParameter,
} from "./embeddings.ts";

const manifest = {
  provider: "ollama" as const,
  model: "nomic-embed-text",
  version: "2026-08-21",
  dimensions: 768,
  digest: `sha256:${"a".repeat(64)}` as const,
  endpoint: "http://127.0.0.1:11434/api/embeddings",
};

test("embedding model manifests require a full local digest", () => {
  assert.equal(parseLocalEmbeddingManifest(manifest).model, "nomic-embed-text");
  assert.match(embeddingManifestDigest(manifest), /^[a-f0-9]{64}$/);

  assert.throws(
    () => parseLocalEmbeddingManifest({ ...manifest, digest: "sha256:abc" }),
    /full SHA-256 digest/,
  );
});

test("hosted embedding endpoints cannot be selected for air-gapped B5 search", () => {
  assert.throws(
    () => parseLocalEmbeddingManifest({
      ...manifest,
      endpoint: "https://api.openai.com/v1/embeddings",
    }),
    /local http or unix transport|outside the client boundary/,
  );
});

test("vector parameters reject dimension and numeric fail-open values", () => {
  assert.equal(vectorParameter([0.25, -1, 2], 3), "[0.25,-1,2]");
  assert.throws(() => vectorParameter([0.25, Number.NaN], 2), /finite numbers/);
  assert.throws(() => vectorParameter([0.25], 2), /dimensions do not match/);
});
