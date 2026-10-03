import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRetrievalFixtures } from "./retrieval.ts";

test("retrieval fixtures compute hit-rate and reciprocal-rank metrics", () => {
  const report = evaluateRetrievalFixtures({
    k: 2,
    candidates: [
      { citationId: "adr-b1#persistence", text: "durable journal", vector: [1, 0, 0] },
      { citationId: "adr-b5#search", text: "local embeddings", vector: [0, 1, 0] },
      { citationId: "adr-a1#runtime", text: "event runtime", vector: [0, 0, 1] },
    ],
    fixtures: [
      {
        id: "local-search",
        query: "how is knowledge searched locally?",
        queryVector: [0.1, 0.9, 0],
        relevantCitationIds: ["adr-b5#search"],
      },
      {
        id: "journal",
        query: "where is history persisted?",
        queryVector: [0.9, 0.1, 0],
        relevantCitationIds: ["adr-b1#persistence"],
      },
    ],
  });

  assert.equal(report.fixtureCount, 2);
  assert.equal(report.hitRateAtK, 1);
  assert.equal(report.meanReciprocalRank, 1);
  assert.deepEqual(report.results.map((result) => result.topCitationIds[0]), [
    "adr-b5#search",
    "adr-b1#persistence",
  ]);
});

test("retrieval quality fixtures reject invalid vector shapes", () => {
  assert.throws(
    () => evaluateRetrievalFixtures({
      k: 1,
      candidates: [
        { citationId: "chunk", text: "x", vector: [1, 0] },
        { citationId: "other", text: "y", vector: [0, 1] },
      ],
      fixtures: [{
        id: "bad",
        query: "x",
        queryVector: [1],
        relevantCitationIds: ["chunk"],
      }],
    }),
    /equal dimensions/,
  );
});
