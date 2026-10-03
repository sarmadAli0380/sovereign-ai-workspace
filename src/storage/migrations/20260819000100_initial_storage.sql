-- migrate:up

CREATE EXTENSION IF NOT EXISTS vector VERSION '0.8.6';

CREATE TABLE users (
  id text PRIMARY KEY CHECK (btrim(id) <> ''),
  external_subject text NOT NULL UNIQUE CHECK (btrim(external_subject) <> ''),
  display_name text NOT NULL CHECK (btrim(display_name) <> ''),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL,
  disabled_at timestamptz,
  CHECK ((status = 'disabled') = (disabled_at IS NOT NULL))
);

CREATE TABLE conversations (
  id text PRIMARY KEY CHECK (btrim(id) <> ''),
  created_by text NOT NULL REFERENCES users(id),
  title text CHECK (title IS NULL OR btrim(title) <> ''),
  created_at timestamptz NOT NULL,
  archived_at timestamptz
);

CREATE TABLE runs (
  id text PRIMARY KEY CHECK (btrim(id) <> ''),
  conversation_id text NOT NULL REFERENCES conversations(id),
  initiated_by text REFERENCES users(id),
  causation_id text NOT NULL CHECK (btrim(causation_id) <> ''),
  correlation_id text CHECK (correlation_id IS NULL OR btrim(correlation_id) <> ''),
  config_key text NOT NULL CHECK (btrim(config_key) <> ''),
  provider text NOT NULL CHECK (btrim(provider) <> ''),
  model text NOT NULL CHECK (btrim(model) <> ''),
  status text NOT NULL CHECK (status IN (
    'running', 'completed', 'failed', 'cancelled', 'needs_approval',
    'persistence_unavailable'
  )),
  terminal_reason text,
  terminal_code text,
  usage jsonb,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  CHECK (usage IS NULL OR jsonb_typeof(usage) = 'object'),
  CHECK (
    (status = 'running' AND completed_at IS NULL AND terminal_reason IS NULL)
    OR
    (status <> 'running' AND completed_at IS NOT NULL AND terminal_reason IS NOT NULL)
  )
);

CREATE INDEX runs_conversation_started_idx
  ON runs (conversation_id, started_at DESC, id);

CREATE TABLE turns (
  id text PRIMARY KEY CHECK (btrim(id) <> ''),
  run_id text NOT NULL REFERENCES runs(id),
  conversation_id text NOT NULL REFERENCES conversations(id),
  turn_number integer NOT NULL CHECK (turn_number >= 0),
  input_message_id text,
  stop_reason text CHECK (stop_reason IN ('stop', 'length', 'toolUse', 'error', 'aborted')),
  budget_tokens bigint CHECK (budget_tokens IS NULL OR budget_tokens >= 0),
  budget_source text CHECK (budget_source IN ('anchored', 'estimated')),
  usage jsonb,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (run_id, turn_number),
  UNIQUE (run_id, id),
  CHECK (usage IS NULL OR jsonb_typeof(usage) = 'object'),
  CHECK ((budget_tokens IS NULL) = (budget_source IS NULL)),
  CHECK ((completed_at IS NULL) = (stop_reason IS NULL))
);

CREATE TABLE messages (
  id text PRIMARY KEY CHECK (btrim(id) <> ''),
  conversation_id text NOT NULL REFERENCES conversations(id),
  seq bigint NOT NULL CHECK (seq >= 0),
  schema_version smallint NOT NULL CHECK (schema_version > 0),
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'toolResult')),
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  provider text,
  model text,
  config_key text,
  usage jsonb,
  created_at timestamptz NOT NULL,
  supersedes_id text REFERENCES messages(id),
  UNIQUE (conversation_id, seq),
  UNIQUE (supersedes_id),
  CHECK (usage IS NULL OR jsonb_typeof(usage) = 'object'),
  CHECK (supersedes_id IS NULL OR supersedes_id <> id),
  CHECK (content ->> 'messageId' = id),
  CHECK ((content ->> 'schemaVersion')::smallint = schema_version),
  CHECK (content ->> 'role' = role)
);

CREATE INDEX messages_conversation_created_idx
  ON messages (conversation_id, created_at, seq);

CREATE OR REPLACE FUNCTION enforce_message_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  previous messages%ROWTYPE;
BEGIN
  IF NEW.supersedes_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO previous
  FROM messages
  WHERE id = NEW.supersedes_id
  FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'messages.supersedes_id does not reference an existing message'
      USING ERRCODE = '23503';
  END IF;
  IF previous.conversation_id <> NEW.conversation_id THEN
    RAISE EXCEPTION 'a message revision must remain in the same conversation'
      USING ERRCODE = '23514';
  END IF;
  IF previous.seq >= NEW.seq THEN
    RAISE EXCEPTION 'a message revision must have a greater conversation sequence'
      USING ERRCODE = '23514';
  END IF;
  IF previous.created_at > NEW.created_at THEN
    RAISE EXCEPTION 'a message revision cannot predate the message it supersedes'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER messages_revision_guard
BEFORE INSERT ON messages
FOR EACH ROW EXECUTE FUNCTION enforce_message_revision();

CREATE OR REPLACE FUNCTION reject_row_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER messages_append_only
BEFORE UPDATE ON messages
FOR EACH ROW EXECUTE FUNCTION reject_row_update();

CREATE VIEW current_messages AS
SELECT message.*
FROM messages AS message
WHERE NOT EXISTS (
  SELECT 1
  FROM messages AS revision
  WHERE revision.supersedes_id = message.id
);

CREATE TABLE tool_calls (
  run_id text NOT NULL REFERENCES runs(id),
  tool_call_id text NOT NULL CHECK (btrim(tool_call_id) <> ''),
  turn_id text NOT NULL,
  conversation_id text NOT NULL REFERENCES conversations(id),
  tool_name text NOT NULL CHECK (btrim(tool_name) <> ''),
  arguments jsonb NOT NULL CHECK (jsonb_typeof(arguments) = 'object'),
  arguments_hash text NOT NULL CHECK (arguments_hash ~ '^[a-f0-9]{64}$'),
  requested_at timestamptz NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  is_error boolean,
  result jsonb,
  PRIMARY KEY (run_id, tool_call_id),
  FOREIGN KEY (run_id, turn_id) REFERENCES turns(run_id, id),
  CHECK ((completed_at IS NULL) = (is_error IS NULL)),
  CHECK (result IS NULL OR completed_at IS NOT NULL)
);

CREATE TABLE tool_decisions (
  id text PRIMARY KEY CHECK (btrim(id) <> ''),
  run_id text NOT NULL,
  tool_call_id text NOT NULL,
  capability text NOT NULL CHECK (btrim(capability) <> ''),
  capabilities text[] NOT NULL CHECK (cardinality(capabilities) > 0),
  decision text NOT NULL CHECK (decision IN ('allow', 'deny', 'requireApproval')),
  reason_code text NOT NULL CHECK (btrim(reason_code) <> ''),
  detail text,
  decided_at timestamptz NOT NULL,
  UNIQUE (run_id, tool_call_id),
  FOREIGN KEY (run_id, tool_call_id) REFERENCES tool_calls(run_id, tool_call_id)
);

CREATE TABLE approvals (
  id text PRIMARY KEY CHECK (btrim(id) <> ''),
  run_id text NOT NULL,
  tool_call_id text NOT NULL,
  arguments_hash text NOT NULL CHECK (arguments_hash ~ '^[a-f0-9]{64}$'),
  capability text NOT NULL CHECK (btrim(capability) <> ''),
  capabilities text[] NOT NULL CHECK (cardinality(capabilities) > 0),
  reason_code text NOT NULL CHECK (btrim(reason_code) <> ''),
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  requested_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  resolved_at timestamptz,
  resolved_by text REFERENCES users(id),
  resolution_reason_code text,
  UNIQUE (run_id, tool_call_id),
  FOREIGN KEY (run_id, tool_call_id) REFERENCES tool_calls(run_id, tool_call_id),
  CHECK (expires_at > requested_at),
  CHECK (
    (status = 'pending' AND resolved_at IS NULL AND resolved_by IS NULL)
    OR
    (status <> 'pending' AND resolved_at IS NOT NULL)
  )
);

CREATE TABLE attachments (
  id text PRIMARY KEY CHECK (btrim(id) <> ''),
  conversation_id text NOT NULL REFERENCES conversations(id),
  message_id text REFERENCES messages(id),
  object_key text NOT NULL UNIQUE CHECK (
    btrim(object_key) <> ''
    AND object_key !~ '^/'
    AND object_key !~ '(^|/)\.\.(/|$)'
  ),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  mime_type text NOT NULL CHECK (btrim(mime_type) <> ''),
  original_name text CHECK (original_name IS NULL OR btrim(original_name) <> ''),
  state text NOT NULL DEFAULT 'available' CHECK (state IN ('staging', 'available', 'tombstoned', 'deleted')),
  created_at timestamptz NOT NULL,
  tombstoned_at timestamptz,
  CHECK ((state IN ('tombstoned', 'deleted')) = (tombstoned_at IS NOT NULL))
);

CREATE TABLE embedding_models (
  manifest_digest text PRIMARY KEY CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  provider text NOT NULL CHECK (provider IN ('ollama', 'local-process', 'local-file')),
  model text NOT NULL CHECK (btrim(model) <> ''),
  version text NOT NULL CHECK (btrim(version) <> ''),
  dimensions integer NOT NULL CHECK (dimensions = 768),
  model_digest text NOT NULL CHECK (model_digest ~ '^sha256:[a-f0-9]{64}$'),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  registered_at timestamptz NOT NULL,
  CHECK (manifest ->> 'provider' = provider),
  CHECK (manifest ->> 'model' = model),
  CHECK (manifest ->> 'version' = version),
  CHECK ((manifest ->> 'dimensions')::integer = dimensions),
  CHECK (manifest ->> 'digest' = model_digest)
);

CREATE TABLE knowledge_sources (
  id text PRIMARY KEY CHECK (btrim(id) <> ''),
  source_type text NOT NULL CHECK (source_type IN ('message', 'attachment', 'document')),
  source_uri text NOT NULL CHECK (btrim(source_uri) <> ''),
  source_version text NOT NULL CHECK (btrim(source_version) <> ''),
  title text CHECK (title IS NULL OR btrim(title) <> ''),
  message_id text REFERENCES messages(id),
  attachment_id text REFERENCES attachments(id),
  created_at timestamptz NOT NULL,
  tombstoned_at timestamptz,
  CHECK (
    (source_type = 'message' AND message_id IS NOT NULL AND attachment_id IS NULL)
    OR
    (source_type = 'attachment' AND attachment_id IS NOT NULL AND message_id IS NULL)
    OR
    (source_type = 'document' AND message_id IS NULL AND attachment_id IS NULL)
  )
);

CREATE TABLE knowledge_chunks (
  id text PRIMARY KEY CHECK (btrim(id) <> ''),
  source_id text NOT NULL REFERENCES knowledge_sources(id),
  citation_id text NOT NULL CHECK (btrim(citation_id) <> ''),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  content text NOT NULL CHECK (btrim(content) <> ''),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  access_policy jsonb NOT NULL CHECK (
    jsonb_typeof(access_policy) = 'object'
    AND access_policy ->> 'visibility' IN ('public', 'restricted')
  ),
  lexical_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  created_at timestamptz NOT NULL,
  tombstoned_at timestamptz,
  UNIQUE (source_id, ordinal)
);

CREATE INDEX knowledge_chunks_lexical_idx
  ON knowledge_chunks USING GIN (lexical_vector);

CREATE INDEX knowledge_chunks_access_users_idx
  ON knowledge_chunks USING GIN ((access_policy -> 'allowedUsers'));

CREATE INDEX knowledge_chunks_access_groups_idx
  ON knowledge_chunks USING GIN ((access_policy -> 'allowedGroups'));

CREATE TABLE chunk_embeddings (
  chunk_id text NOT NULL REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
  manifest_digest text NOT NULL REFERENCES embedding_models(manifest_digest),
  embedding vector(768) NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (chunk_id, manifest_digest)
);

CREATE INDEX chunk_embeddings_vector_idx
  ON chunk_embeddings USING hnsw (embedding vector_cosine_ops);

CREATE TABLE event_journal (
  journal_seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id text NOT NULL UNIQUE CHECK (btrim(event_id) <> ''),
  schema_version smallint NOT NULL CHECK (schema_version > 0),
  run_id text NOT NULL REFERENCES runs(id),
  conversation_id text NOT NULL REFERENCES conversations(id),
  event_sequence bigint NOT NULL CHECK (event_sequence >= 0),
  turn_number integer NOT NULL CHECK (turn_number >= 0),
  event_type text NOT NULL CHECK (btrim(event_type) <> ''),
  sensitivity text NOT NULL CHECK (sensitivity IN ('content', 'derived-content', 'metadata')),
  event jsonb NOT NULL CHECK (jsonb_typeof(event) = 'object'),
  occurred_at timestamptz NOT NULL,
  persisted_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (run_id, event_sequence)
);

CREATE TRIGGER event_journal_append_only
BEFORE UPDATE ON event_journal
FOR EACH ROW EXECUTE FUNCTION reject_row_update();

CREATE TABLE audit_events (
  event_id text PRIMARY KEY REFERENCES event_journal(event_id) ON DELETE CASCADE,
  run_id text NOT NULL,
  conversation_id text NOT NULL,
  event_sequence bigint NOT NULL CHECK (event_sequence >= 0),
  event_type text NOT NULL CHECK (btrim(event_type) <> ''),
  actor_id text,
  metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object'),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (run_id, event_sequence)
);

CREATE TRIGGER audit_events_append_only
BEFORE UPDATE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reject_row_update();

CREATE TABLE outbox_jobs (
  id text PRIMARY KEY CHECK (btrim(id) <> ''),
  topic text NOT NULL CHECK (btrim(topic) <> ''),
  aggregate_type text NOT NULL CHECK (btrim(aggregate_type) <> ''),
  aggregate_id text NOT NULL CHECK (btrim(aggregate_id) <> ''),
  idempotency_key text NOT NULL UNIQUE CHECK (btrim(idempotency_key) <> ''),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL,
  locked_at timestamptz,
  locked_by text,
  last_error_code text,
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  CHECK ((locked_at IS NULL) = (locked_by IS NULL)),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

CREATE INDEX outbox_jobs_ready_idx
  ON outbox_jobs (available_at, created_at, id)
  WHERE status IN ('pending', 'failed');

CREATE TABLE consumer_checkpoints (
  consumer_name text PRIMARY KEY CHECK (btrim(consumer_name) <> ''),
  journal_seq bigint NOT NULL DEFAULT 0 CHECK (journal_seq >= 0),
  event_id text REFERENCES event_journal(event_id),
  updated_at timestamptz NOT NULL,
  CHECK ((journal_seq = 0) = (event_id IS NULL))
);

CREATE TABLE erasure_jobs (
  id text PRIMARY KEY CHECK (btrim(id) <> ''),
  subject_type text NOT NULL CHECK (subject_type IN ('user', 'conversation', 'message')),
  subject_id text NOT NULL CHECK (btrim(subject_id) <> ''),
  requested_by text REFERENCES users(id),
  reason_code text NOT NULL CHECK (btrim(reason_code) <> ''),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'reconciling', 'completed', 'failed')),
  requested_at timestamptz NOT NULL,
  completed_at timestamptz,
  last_error_code text,
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

CREATE TABLE erasure_targets (
  erasure_job_id text NOT NULL REFERENCES erasure_jobs(id) ON DELETE CASCADE,
  store text NOT NULL CHECK (store IN ('postgres', 'attachments', 'embeddings', 'search', 'cache')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'verified', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code text,
  verified_at timestamptz,
  PRIMARY KEY (erasure_job_id, store),
  CHECK ((status = 'verified') = (verified_at IS NOT NULL))
);

-- migrate:down

DROP TABLE IF EXISTS erasure_targets;
DROP TABLE IF EXISTS erasure_jobs;
DROP TABLE IF EXISTS consumer_checkpoints;
DROP TABLE IF EXISTS outbox_jobs;
DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;
DROP TABLE IF EXISTS audit_events;
DROP TRIGGER IF EXISTS event_journal_append_only ON event_journal;
DROP TABLE IF EXISTS event_journal;
DROP TABLE IF EXISTS chunk_embeddings;
DROP TABLE IF EXISTS knowledge_chunks;
DROP TABLE IF EXISTS knowledge_sources;
DROP TABLE IF EXISTS embedding_models;
DROP TABLE IF EXISTS attachments;
DROP TABLE IF EXISTS approvals;
DROP TABLE IF EXISTS tool_decisions;
DROP TABLE IF EXISTS tool_calls;
DROP VIEW IF EXISTS current_messages;
DROP TRIGGER IF EXISTS messages_append_only ON messages;
DROP TRIGGER IF EXISTS messages_revision_guard ON messages;
DROP TABLE IF EXISTS messages;
DROP FUNCTION IF EXISTS reject_row_update();
DROP FUNCTION IF EXISTS enforce_message_revision();
DROP TABLE IF EXISTS turns;
DROP TABLE IF EXISTS runs;
DROP TABLE IF EXISTS conversations;
DROP TABLE IF EXISTS users;
