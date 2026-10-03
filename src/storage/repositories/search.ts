import {
  embeddingManifestDigest,
  parseLocalEmbeddingManifest,
  vectorParameter,
  type LocalEmbeddingModelManifest,
} from "../../search/embeddings.ts";
import {
  isoParameter,
  jsonParameter,
  oneRow,
  parseJsonColumn,
  requireNonEmpty,
  requireTimestamp,
  requireWholeNumber,
  type SqlExecutor,
} from "../sql.ts";

export type KnowledgeSourceType = "message" | "attachment" | "document";

export interface ChunkAccessPolicy {
  readonly visibility: "public" | "restricted";
  readonly allowedUsers?: readonly string[];
  readonly allowedGroups?: readonly string[];
}

export interface StoredEmbeddingModel {
  readonly manifestDigest: string;
  readonly manifest: LocalEmbeddingModelManifest;
  readonly registeredAt: string;
}

export interface StoredKnowledgeChunk {
  readonly chunkId: string;
  readonly sourceId: string;
  readonly sourceType: KnowledgeSourceType;
  readonly sourceUri: string;
  readonly sourceVersion: string;
  readonly citationId: string;
  readonly ordinal: number;
  readonly content: string;
  readonly contentHash: string;
  readonly accessPolicy: ChunkAccessPolicy;
  readonly createdAt: string;
}

export interface SearchResult extends StoredKnowledgeChunk {
  readonly vectorScore: number;
  readonly lexicalScore: number;
  readonly combinedScore: number;
}

export class KnowledgeSearchRepository {
  readonly #database: SqlExecutor;

  constructor(database: SqlExecutor) {
    this.#database = database;
  }

  async registerEmbeddingModel(input: {
    manifest: LocalEmbeddingModelManifest;
    registeredAt: string;
  }): Promise<StoredEmbeddingModel> {
    const manifest = parseLocalEmbeddingManifest(input.manifest);
    const manifestDigest = embeddingManifestDigest(manifest);
    const result = await this.#database.query(
      `WITH inserted AS (
        INSERT INTO embedding_models (
          manifest_digest, provider, model, version, dimensions, model_digest,
          manifest, registered_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz)
        ON CONFLICT (manifest_digest) DO NOTHING
        RETURNING manifest_digest, manifest, registered_at
      )
      SELECT manifest_digest, manifest, registered_at
      FROM inserted
      UNION ALL
      SELECT manifest_digest, manifest, registered_at
      FROM embedding_models
      WHERE manifest_digest = $1
        AND NOT EXISTS (SELECT 1 FROM inserted)`,
      [
        manifestDigest,
        manifest.provider,
        manifest.model,
        manifest.version,
        manifest.dimensions,
        manifest.digest,
        jsonParameter(manifest),
        isoParameter(input.registeredAt, "embeddingModel.registeredAt"),
      ],
    );
    return decodeEmbeddingModel(oneRow(result, "register embedding model"));
  }

  async upsertSource(input: {
    sourceId: string;
    sourceType: KnowledgeSourceType;
    sourceUri: string;
    sourceVersion: string;
    title?: string;
    messageId?: string;
    attachmentId?: string;
    createdAt: string;
  }): Promise<void> {
    const result = await this.#database.query(
      `INSERT INTO knowledge_sources (
        id, source_type, source_uri, source_version, title,
        message_id, attachment_id, created_at
      )
      SELECT $1, $2, $3, $4, $5, $6, $7, $8::timestamptz
      WHERE ($2 = 'document')
         OR ($2 = 'message' AND EXISTS (SELECT 1 FROM current_messages WHERE id = $6))
         OR ($2 = 'attachment' AND EXISTS (
           SELECT 1 FROM attachments WHERE id = $7 AND state = 'available'
         ))
      ON CONFLICT (id) DO UPDATE
      SET source_version = EXCLUDED.source_version,
          title = EXCLUDED.title
      WHERE knowledge_sources.tombstoned_at IS NULL
      RETURNING id`,
      [
        requireNonEmpty(input.sourceId, "source.sourceId"),
        input.sourceType,
        requireNonEmpty(input.sourceUri, "source.sourceUri"),
        requireNonEmpty(input.sourceVersion, "source.sourceVersion"),
        input.title ?? null,
        input.messageId ?? null,
        input.attachmentId ?? null,
        isoParameter(input.createdAt, "source.createdAt"),
      ],
    );
    oneRow(result, "upsert knowledge source");
  }

  async upsertChunk(input: {
    chunkId: string;
    sourceId: string;
    citationId: string;
    ordinal: number;
    content: string;
    contentHash: string;
    accessPolicy: ChunkAccessPolicy;
    manifest: LocalEmbeddingModelManifest;
    embedding: readonly number[];
    createdAt: string;
  }): Promise<void> {
    const manifest = parseLocalEmbeddingManifest(input.manifest);
    const result = await this.#database.query(
      `WITH chunk AS (
        INSERT INTO knowledge_chunks (
          id, source_id, citation_id, ordinal, content, content_hash,
          access_policy, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz)
        ON CONFLICT (id) DO UPDATE
        SET content = EXCLUDED.content,
            content_hash = EXCLUDED.content_hash,
            access_policy = EXCLUDED.access_policy
        WHERE knowledge_chunks.tombstoned_at IS NULL
          AND EXISTS (
            SELECT 1 FROM knowledge_sources
            WHERE id = $2 AND tombstoned_at IS NULL
          )
        RETURNING id
      )
      INSERT INTO chunk_embeddings (
        chunk_id, manifest_digest, embedding, created_at
      )
      SELECT id, $9, $10::vector, $8::timestamptz
      FROM chunk
      ON CONFLICT (chunk_id, manifest_digest) DO UPDATE
      SET embedding = EXCLUDED.embedding
      RETURNING chunk_id`,
      [
        requireNonEmpty(input.chunkId, "chunk.chunkId"),
        requireNonEmpty(input.sourceId, "chunk.sourceId"),
        requireNonEmpty(input.citationId, "chunk.citationId"),
        nonNegativeInteger(input.ordinal, "chunk.ordinal"),
        requireNonEmpty(input.content, "chunk.content"),
        sha256Hex(input.contentHash, "chunk.contentHash"),
        jsonParameter(parseChunkAccessPolicy(input.accessPolicy)),
        isoParameter(input.createdAt, "chunk.createdAt"),
        embeddingManifestDigest(manifest),
        vectorParameter(input.embedding, manifest.dimensions),
      ],
    );
    oneRow(result, "upsert knowledge chunk");
  }

  async search(input: {
    manifest: LocalEmbeddingModelManifest;
    query: string;
    embedding: readonly number[];
    actorUserId: string;
    groupIds?: readonly string[];
    limit?: number;
  }): Promise<SearchResult[]> {
    const manifest = parseLocalEmbeddingManifest(input.manifest);
    const limit = input.limit ?? 8;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 50) {
      throw new TypeError("search.limit must be a positive safe integer no greater than 50");
    }
    const result = await this.#database.query(
      `SELECT
         kc.id AS chunk_id,
         ks.id AS source_id,
         ks.source_type,
         ks.source_uri,
         ks.source_version,
         kc.citation_id,
         kc.ordinal,
         kc.content,
         kc.content_hash,
         kc.access_policy,
         kc.created_at,
         (1 - (ce.embedding <=> $2::vector))::float8 AS vector_score,
         ts_rank(kc.lexical_vector, websearch_to_tsquery('simple', $3))::float8 AS lexical_score,
         (
           (1 - (ce.embedding <=> $2::vector)) * 0.82 +
           ts_rank(kc.lexical_vector, websearch_to_tsquery('simple', $3)) * 0.18
         )::float8 AS combined_score
       FROM chunk_embeddings ce
       JOIN knowledge_chunks kc ON kc.id = ce.chunk_id
       JOIN knowledge_sources ks ON ks.id = kc.source_id
       WHERE ce.manifest_digest = $1
         AND kc.tombstoned_at IS NULL
         AND ks.tombstoned_at IS NULL
         AND (
           kc.access_policy ->> 'visibility' = 'public'
           OR kc.access_policy -> 'allowedUsers' ? $4
           OR kc.access_policy -> 'allowedGroups' ?| $5::text[]
         )
       ORDER BY combined_score DESC, kc.id ASC
       LIMIT $6`,
      [
        embeddingManifestDigest(manifest),
        vectorParameter(input.embedding, manifest.dimensions),
        requireNonEmpty(input.query, "search.query"),
        requireNonEmpty(input.actorUserId, "search.actorUserId"),
        [...(input.groupIds ?? [])],
        limit,
      ],
    );
    return result.rows.map(decodeSearchResult);
  }
}

function decodeEmbeddingModel(row: Record<string, unknown>): StoredEmbeddingModel {
  return {
    manifestDigest: requireNonEmpty(row["manifest_digest"], "embedding_models.manifest_digest"),
    manifest: parseLocalEmbeddingManifest(parseJsonColumn(
      row["manifest"],
      "embedding_models.manifest",
    ) as unknown as LocalEmbeddingModelManifest),
    registeredAt: requireTimestamp(row["registered_at"], "embedding_models.registered_at"),
  };
}

function decodeSearchResult(row: Record<string, unknown>): SearchResult {
  return {
    chunkId: requireNonEmpty(row["chunk_id"], "knowledge_chunks.id"),
    sourceId: requireNonEmpty(row["source_id"], "knowledge_sources.id"),
    sourceType: parseSourceType(row["source_type"]),
    sourceUri: requireNonEmpty(row["source_uri"], "knowledge_sources.source_uri"),
    sourceVersion: requireNonEmpty(row["source_version"], "knowledge_sources.source_version"),
    citationId: requireNonEmpty(row["citation_id"], "knowledge_chunks.citation_id"),
    ordinal: requireWholeNumber(row["ordinal"], "knowledge_chunks.ordinal"),
    content: requireNonEmpty(row["content"], "knowledge_chunks.content"),
    contentHash: sha256Hex(row["content_hash"], "knowledge_chunks.content_hash"),
    accessPolicy: parseChunkAccessPolicy(parseJsonColumn(row["access_policy"], "knowledge_chunks.access_policy")),
    createdAt: requireTimestamp(row["created_at"], "knowledge_chunks.created_at"),
    vectorScore: finiteScore(row["vector_score"], "search.vectorScore"),
    lexicalScore: finiteScore(row["lexical_score"], "search.lexicalScore"),
    combinedScore: finiteScore(row["combined_score"], "search.combinedScore"),
  };
}

function parseSourceType(value: unknown): KnowledgeSourceType {
  if (value === "message" || value === "attachment" || value === "document") return value;
  throw new TypeError("knowledge source type is not supported");
}

function parseChunkAccessPolicy(value: unknown): ChunkAccessPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("chunk access policy must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record["visibility"] !== "public" && record["visibility"] !== "restricted") {
    throw new TypeError("chunk access policy visibility is not supported");
  }
  return {
    visibility: record["visibility"],
    ...(record["allowedUsers"] === undefined ? {} : { allowedUsers: stringArray(record["allowedUsers"], "allowedUsers") }),
    ...(record["allowedGroups"] === undefined ? {} : { allowedGroups: stringArray(record["allowedGroups"], "allowedGroups") }),
  };
}

function stringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value.map((item, index) => requireNonEmpty(item, `${path}[${index}]`));
}

function nonNegativeInteger(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${path} must be a non-negative safe integer`);
  }
  return value;
}

function sha256Hex(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`${path} must be lowercase SHA-256 hex`);
  }
  return value;
}

function finiteScore(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${path} must be a finite number`);
  }
  return value;
}
