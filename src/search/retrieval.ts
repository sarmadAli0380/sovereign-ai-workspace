export interface RetrievalCandidate {
  readonly citationId: string;
  readonly text: string;
  readonly vector: readonly number[];
}

export interface RetrievalFixture {
  readonly id: string;
  readonly query: string;
  readonly queryVector: readonly number[];
  readonly relevantCitationIds: readonly string[];
}

export interface RetrievalFixtureResult {
  readonly fixtureId: string;
  readonly topCitationIds: readonly string[];
  readonly hitAtK: boolean;
  readonly reciprocalRank: number;
}

export interface RetrievalQualityReport {
  readonly fixtureCount: number;
  readonly k: number;
  readonly hitRateAtK: number;
  readonly meanReciprocalRank: number;
  readonly results: readonly RetrievalFixtureResult[];
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) {
    throw new TypeError("vectors must be non-empty and have equal dimensions");
  }
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = finiteNumber(left[index], `left[${index}]`);
    const b = finiteNumber(right[index], `right[${index}]`);
    dot += a * b;
    leftMagnitude += a * a;
    rightMagnitude += b * b;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

export function evaluateRetrievalFixtures(input: {
  readonly fixtures: readonly RetrievalFixture[];
  readonly candidates: readonly RetrievalCandidate[];
  readonly k: number;
}): RetrievalQualityReport {
  if (!Number.isSafeInteger(input.k) || input.k <= 0) {
    throw new TypeError("k must be a positive safe integer");
  }
  const results = input.fixtures.map((fixture) => {
    const relevant = new Set(fixture.relevantCitationIds);
    const ranked = [...input.candidates]
      .sort((left, right) =>
        cosineSimilarity(right.vector, fixture.queryVector) -
        cosineSimilarity(left.vector, fixture.queryVector)
      )
      .map((candidate) => candidate.citationId);
    const firstRelevantIndex = ranked.findIndex((citationId) => relevant.has(citationId));
    return {
      fixtureId: fixture.id,
      topCitationIds: ranked.slice(0, input.k),
      hitAtK: ranked.slice(0, input.k).some((citationId) => relevant.has(citationId)),
      reciprocalRank: firstRelevantIndex === -1 ? 0 : 1 / (firstRelevantIndex + 1),
    };
  });
  const fixtureCount = results.length;
  return {
    fixtureCount,
    k: input.k,
    hitRateAtK: fixtureCount === 0 ? 0 : results.filter((result) => result.hitAtK).length / fixtureCount,
    meanReciprocalRank: fixtureCount === 0
      ? 0
      : results.reduce((sum, result) => sum + result.reciprocalRank, 0) / fixtureCount,
    results,
  };
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${path} must be a finite number`);
  }
  return value;
}
