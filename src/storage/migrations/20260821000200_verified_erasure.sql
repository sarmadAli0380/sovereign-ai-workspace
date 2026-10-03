-- migrate:up

ALTER TABLE erasure_jobs
  ADD CONSTRAINT erasure_jobs_subject_unique UNIQUE (subject_type, subject_id);

ALTER TABLE erasure_targets
  DROP CONSTRAINT erasure_targets_store_check;

ALTER TABLE erasure_targets
  ADD CONSTRAINT erasure_targets_store_check CHECK (store IN (
    'postgres', 'attachments', 'embeddings', 'search', 'cache',
    'temporary_derivatives', 'provider_payloads'
  ));

CREATE TABLE erasure_tombstones (
  erasure_job_id text PRIMARY KEY REFERENCES erasure_jobs(id) ON DELETE CASCADE,
  subject_type text NOT NULL CHECK (subject_type IN ('user', 'conversation', 'message')),
  subject_id text NOT NULL CHECK (btrim(subject_id) <> ''),
  tombstoned_at timestamptz NOT NULL,
  UNIQUE (subject_type, subject_id)
);

CREATE TABLE erasure_conversation_scope (
  erasure_job_id text NOT NULL REFERENCES erasure_jobs(id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES conversations(id),
  erase_all boolean NOT NULL,
  PRIMARY KEY (erasure_job_id, conversation_id)
);

CREATE TABLE erasure_message_scope (
  erasure_job_id text NOT NULL REFERENCES erasure_jobs(id) ON DELETE CASCADE,
  message_id text NOT NULL,
  conversation_id text NOT NULL REFERENCES conversations(id),
  PRIMARY KEY (erasure_job_id, message_id)
);

CREATE TABLE erasure_attachment_objects (
  erasure_job_id text NOT NULL REFERENCES erasure_jobs(id) ON DELETE CASCADE,
  attachment_id text NOT NULL,
  object_key text NOT NULL,
  PRIMARY KEY (erasure_job_id, attachment_id)
);

CREATE TABLE erasure_knowledge_sources (
  erasure_job_id text NOT NULL REFERENCES erasure_jobs(id) ON DELETE CASCADE,
  source_id text NOT NULL,
  PRIMARY KEY (erasure_job_id, source_id)
);

CREATE INDEX erasure_message_scope_conversation_idx
  ON erasure_message_scope (erasure_job_id, conversation_id);

CREATE INDEX erasure_attachment_objects_job_idx
  ON erasure_attachment_objects (erasure_job_id, attachment_id);

CREATE INDEX erasure_knowledge_sources_job_idx
  ON erasure_knowledge_sources (erasure_job_id, source_id);

CREATE OR REPLACE FUNCTION reject_erased_content_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  blocked boolean;
BEGIN
  blocked := false;

  IF TG_TABLE_NAME = 'messages' THEN
    SELECT EXISTS (
      SELECT 1
      FROM conversations AS conversation
      JOIN erasure_tombstones AS erased
        ON (erased.subject_type = 'conversation' AND erased.subject_id = conversation.id)
        OR (erased.subject_type = 'user' AND erased.subject_id = conversation.created_by)
      WHERE conversation.id = NEW.conversation_id
    ) OR EXISTS (
      SELECT 1 FROM erasure_message_scope
      WHERE message_id = NEW.id OR message_id = NEW.supersedes_id
    ) INTO blocked;
  ELSIF TG_TABLE_NAME = 'attachments' THEN
    SELECT EXISTS (
      SELECT 1
      FROM conversations AS conversation
      JOIN erasure_tombstones AS erased
        ON (erased.subject_type = 'conversation' AND erased.subject_id = conversation.id)
        OR (erased.subject_type = 'user' AND erased.subject_id = conversation.created_by)
      WHERE conversation.id = NEW.conversation_id
    ) OR EXISTS (
      SELECT 1 FROM erasure_message_scope WHERE message_id = NEW.message_id
    ) INTO blocked;
  ELSIF TG_TABLE_NAME = 'event_journal' THEN
    SELECT EXISTS (
      SELECT 1
      FROM conversations AS conversation
      JOIN erasure_tombstones AS erased
        ON (erased.subject_type = 'conversation' AND erased.subject_id = conversation.id)
        OR (erased.subject_type = 'user' AND erased.subject_id = conversation.created_by)
      WHERE conversation.id = NEW.conversation_id
    ) OR EXISTS (
      SELECT 1 FROM erasure_message_scope AS erased
      WHERE erased.message_id = COALESCE(
        NEW.event #>> '{payload,message,messageId}',
        NEW.event #>> '{payload,messageId}'
      )
    ) INTO blocked;
  ELSIF TG_TABLE_NAME = 'knowledge_sources' THEN
    SELECT EXISTS (
      SELECT 1 FROM erasure_message_scope WHERE message_id = NEW.message_id
    ) OR EXISTS (
      SELECT 1 FROM attachments
      WHERE id = NEW.attachment_id AND state <> 'available'
    ) INTO blocked;
  ELSIF TG_TABLE_NAME = 'knowledge_chunks' THEN
    SELECT EXISTS (
      SELECT 1 FROM knowledge_sources
      WHERE id = NEW.source_id AND tombstoned_at IS NOT NULL
    ) INTO blocked;
  END IF;

  IF blocked THEN
    RAISE EXCEPTION 'content belongs to a tombstoned erasure scope'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER messages_erasure_guard
AFTER INSERT ON messages
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION reject_erased_content_write();

CREATE CONSTRAINT TRIGGER attachments_erasure_guard
AFTER INSERT ON attachments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION reject_erased_content_write();

CREATE CONSTRAINT TRIGGER event_journal_erasure_guard
AFTER INSERT ON event_journal
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION reject_erased_content_write();

CREATE CONSTRAINT TRIGGER knowledge_sources_erasure_guard
AFTER INSERT ON knowledge_sources
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION reject_erased_content_write();

CREATE CONSTRAINT TRIGGER knowledge_chunks_erasure_guard
AFTER INSERT ON knowledge_chunks
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION reject_erased_content_write();

CREATE OR REPLACE VIEW current_messages AS
SELECT message.*
FROM messages AS message
JOIN conversations AS conversation ON conversation.id = message.conversation_id
WHERE NOT EXISTS (
  SELECT 1
  FROM messages AS revision
  WHERE revision.supersedes_id = message.id
)
AND NOT EXISTS (
  SELECT 1
  FROM erasure_message_scope AS erased
  WHERE erased.message_id = message.id
)
AND NOT EXISTS (
  SELECT 1
  FROM erasure_tombstones AS erased
  WHERE (erased.subject_type = 'conversation' AND erased.subject_id = message.conversation_id)
     OR (erased.subject_type = 'user' AND erased.subject_id = conversation.created_by)
);

CREATE VIEW retrievable_event_journal AS
SELECT journal.*
FROM event_journal AS journal
JOIN conversations AS conversation ON conversation.id = journal.conversation_id
WHERE NOT EXISTS (
  SELECT 1
  FROM erasure_tombstones AS erased
  WHERE (erased.subject_type = 'conversation' AND erased.subject_id = journal.conversation_id)
     OR (erased.subject_type = 'user' AND erased.subject_id = conversation.created_by)
)
AND NOT EXISTS (
  SELECT 1
  FROM erasure_message_scope AS erased
  WHERE erased.message_id = COALESCE(
    journal.event #>> '{payload,message,messageId}',
    journal.event #>> '{payload,messageId}'
  )
);

ALTER TABLE audit_events
  DROP CONSTRAINT audit_events_event_id_fkey;

ALTER TABLE consumer_checkpoints
  DROP CONSTRAINT consumer_checkpoints_event_id_fkey;

-- migrate:down

ALTER TABLE consumer_checkpoints
  ADD CONSTRAINT consumer_checkpoints_event_id_fkey
  FOREIGN KEY (event_id) REFERENCES event_journal(event_id);

ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_event_id_fkey
  FOREIGN KEY (event_id) REFERENCES event_journal(event_id) ON DELETE CASCADE;

DROP VIEW IF EXISTS retrievable_event_journal;

DROP TRIGGER IF EXISTS knowledge_chunks_erasure_guard ON knowledge_chunks;
DROP TRIGGER IF EXISTS knowledge_sources_erasure_guard ON knowledge_sources;
DROP TRIGGER IF EXISTS event_journal_erasure_guard ON event_journal;
DROP TRIGGER IF EXISTS attachments_erasure_guard ON attachments;
DROP TRIGGER IF EXISTS messages_erasure_guard ON messages;
DROP FUNCTION IF EXISTS reject_erased_content_write();

CREATE OR REPLACE VIEW current_messages AS
SELECT message.*
FROM messages AS message
WHERE NOT EXISTS (
  SELECT 1
  FROM messages AS revision
  WHERE revision.supersedes_id = message.id
);

DROP TABLE IF EXISTS erasure_knowledge_sources;
DROP TABLE IF EXISTS erasure_attachment_objects;
DROP TABLE IF EXISTS erasure_message_scope;
DROP TABLE IF EXISTS erasure_conversation_scope;
DROP TABLE IF EXISTS erasure_tombstones;

ALTER TABLE erasure_targets
  DROP CONSTRAINT erasure_targets_store_check;

ALTER TABLE erasure_targets
  ADD CONSTRAINT erasure_targets_store_check CHECK (store IN (
    'postgres', 'attachments', 'embeddings', 'search', 'cache'
  ));

ALTER TABLE erasure_jobs
  DROP CONSTRAINT erasure_jobs_subject_unique;
