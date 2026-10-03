\restrict dbmate

-- Dumped from database version 18.6 (Debian 18.6-1.pgdg12+2)
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


--
-- Name: enforce_message_revision(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_message_revision() RETURNS trigger
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


--
-- Name: reject_erased_content_write(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reject_erased_content_write() RETURNS trigger
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


--
-- Name: reject_row_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reject_row_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: approvals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.approvals (
    id text NOT NULL,
    run_id text NOT NULL,
    tool_call_id text NOT NULL,
    arguments_hash text NOT NULL,
    capability text NOT NULL,
    capabilities text[] NOT NULL,
    reason_code text NOT NULL,
    status text NOT NULL,
    requested_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by text,
    resolution_reason_code text,
    resolution_session_id text,
    resolution_request_sha256 text,
    CONSTRAINT approvals_arguments_hash_check CHECK ((arguments_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT approvals_capabilities_check CHECK ((cardinality(capabilities) > 0)),
    CONSTRAINT approvals_capability_check CHECK ((btrim(capability) <> ''::text)),
    CONSTRAINT approvals_check CHECK ((expires_at > requested_at)),
    CONSTRAINT approvals_check1 CHECK ((((status = 'pending'::text) AND (resolved_at IS NULL) AND (resolved_by IS NULL)) OR ((status <> 'pending'::text) AND (resolved_at IS NOT NULL)))),
    CONSTRAINT approvals_id_check CHECK ((btrim(id) <> ''::text)),
    CONSTRAINT approvals_reason_code_check CHECK ((btrim(reason_code) <> ''::text)),
    CONSTRAINT approvals_resolution_request_sha256_check CHECK (((resolution_request_sha256 IS NULL) OR (resolution_request_sha256 ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT approvals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text, 'expired'::text])))
);


--
-- Name: attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attachments (
    id text NOT NULL,
    conversation_id text NOT NULL,
    message_id text,
    object_key text NOT NULL,
    sha256 text NOT NULL,
    byte_size bigint NOT NULL,
    mime_type text NOT NULL,
    original_name text,
    state text DEFAULT 'available'::text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    tombstoned_at timestamp with time zone,
    CONSTRAINT attachments_byte_size_check CHECK ((byte_size >= 0)),
    CONSTRAINT attachments_check CHECK (((state = ANY (ARRAY['tombstoned'::text, 'deleted'::text])) = (tombstoned_at IS NOT NULL))),
    CONSTRAINT attachments_id_check CHECK ((btrim(id) <> ''::text)),
    CONSTRAINT attachments_mime_type_check CHECK ((btrim(mime_type) <> ''::text)),
    CONSTRAINT attachments_object_key_check CHECK (((btrim(object_key) <> ''::text) AND (object_key !~ '^/'::text) AND (object_key !~ '(^|/)\.\.(/|$)'::text))),
    CONSTRAINT attachments_original_name_check CHECK (((original_name IS NULL) OR (btrim(original_name) <> ''::text))),
    CONSTRAINT attachments_sha256_check CHECK ((sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT attachments_state_check CHECK ((state = ANY (ARRAY['staging'::text, 'available'::text, 'tombstoned'::text, 'deleted'::text])))
);


--
-- Name: audit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_events (
    event_id text NOT NULL,
    run_id text NOT NULL,
    conversation_id text NOT NULL,
    event_sequence bigint NOT NULL,
    event_type text NOT NULL,
    actor_id text,
    metadata jsonb NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    recorded_at timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,
    CONSTRAINT audit_events_event_sequence_check CHECK ((event_sequence >= 0)),
    CONSTRAINT audit_events_event_type_check CHECK ((btrim(event_type) <> ''::text)),
    CONSTRAINT audit_events_metadata_check CHECK ((jsonb_typeof(metadata) = 'object'::text))
);


--
-- Name: chunk_embeddings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chunk_embeddings (
    chunk_id text NOT NULL,
    manifest_digest text NOT NULL,
    embedding public.vector(768) NOT NULL,
    created_at timestamp with time zone NOT NULL
);


--
-- Name: consumer_checkpoints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.consumer_checkpoints (
    consumer_name text NOT NULL,
    journal_seq bigint DEFAULT 0 NOT NULL,
    event_id text,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT consumer_checkpoints_check CHECK (((journal_seq = 0) = (event_id IS NULL))),
    CONSTRAINT consumer_checkpoints_consumer_name_check CHECK ((btrim(consumer_name) <> ''::text)),
    CONSTRAINT consumer_checkpoints_journal_seq_check CHECK ((journal_seq >= 0))
);


--
-- Name: conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversations (
    id text NOT NULL,
    created_by text NOT NULL,
    title text,
    created_at timestamp with time zone NOT NULL,
    archived_at timestamp with time zone,
    CONSTRAINT conversations_id_check CHECK ((btrim(id) <> ''::text)),
    CONSTRAINT conversations_title_check CHECK (((title IS NULL) OR (btrim(title) <> ''::text)))
);


--
-- Name: erasure_message_scope; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.erasure_message_scope (
    erasure_job_id text NOT NULL,
    message_id text NOT NULL,
    conversation_id text NOT NULL
);


--
-- Name: erasure_tombstones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.erasure_tombstones (
    erasure_job_id text NOT NULL,
    subject_type text NOT NULL,
    subject_id text NOT NULL,
    tombstoned_at timestamp with time zone NOT NULL,
    CONSTRAINT erasure_tombstones_subject_id_check CHECK ((btrim(subject_id) <> ''::text)),
    CONSTRAINT erasure_tombstones_subject_type_check CHECK ((subject_type = ANY (ARRAY['user'::text, 'conversation'::text, 'message'::text])))
);


--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    id text NOT NULL,
    conversation_id text NOT NULL,
    seq bigint NOT NULL,
    schema_version smallint NOT NULL,
    role text NOT NULL,
    content jsonb NOT NULL,
    provider text,
    model text,
    config_key text,
    usage jsonb,
    created_at timestamp with time zone NOT NULL,
    supersedes_id text,
    CONSTRAINT messages_check CHECK (((supersedes_id IS NULL) OR (supersedes_id <> id))),
    CONSTRAINT messages_check1 CHECK (((content ->> 'messageId'::text) = id)),
    CONSTRAINT messages_check2 CHECK ((((content ->> 'schemaVersion'::text))::smallint = schema_version)),
    CONSTRAINT messages_check3 CHECK (((content ->> 'role'::text) = role)),
    CONSTRAINT messages_content_check CHECK ((jsonb_typeof(content) = 'object'::text)),
    CONSTRAINT messages_id_check CHECK ((btrim(id) <> ''::text)),
    CONSTRAINT messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text, 'toolResult'::text]))),
    CONSTRAINT messages_schema_version_check CHECK ((schema_version > 0)),
    CONSTRAINT messages_seq_check CHECK ((seq >= 0)),
    CONSTRAINT messages_usage_check CHECK (((usage IS NULL) OR (jsonb_typeof(usage) = 'object'::text)))
);


--
-- Name: current_messages; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.current_messages AS
 SELECT message.id,
    message.conversation_id,
    message.seq,
    message.schema_version,
    message.role,
    message.content,
    message.provider,
    message.model,
    message.config_key,
    message.usage,
    message.created_at,
    message.supersedes_id
   FROM (public.messages message
     JOIN public.conversations conversation ON ((conversation.id = message.conversation_id)))
  WHERE ((NOT (EXISTS ( SELECT 1
           FROM public.messages revision
          WHERE (revision.supersedes_id = message.id)))) AND (NOT (EXISTS ( SELECT 1
           FROM public.erasure_message_scope erased
          WHERE (erased.message_id = message.id)))) AND (NOT (EXISTS ( SELECT 1
           FROM public.erasure_tombstones erased
          WHERE (((erased.subject_type = 'conversation'::text) AND (erased.subject_id = message.conversation_id)) OR ((erased.subject_type = 'user'::text) AND (erased.subject_id = conversation.created_by)))))));


--
-- Name: embedding_models; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.embedding_models (
    manifest_digest text NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    version text NOT NULL,
    dimensions integer NOT NULL,
    model_digest text NOT NULL,
    manifest jsonb NOT NULL,
    registered_at timestamp with time zone NOT NULL,
    CONSTRAINT embedding_models_check CHECK (((manifest ->> 'provider'::text) = provider)),
    CONSTRAINT embedding_models_check1 CHECK (((manifest ->> 'model'::text) = model)),
    CONSTRAINT embedding_models_check2 CHECK (((manifest ->> 'version'::text) = version)),
    CONSTRAINT embedding_models_check3 CHECK ((((manifest ->> 'dimensions'::text))::integer = dimensions)),
    CONSTRAINT embedding_models_check4 CHECK (((manifest ->> 'digest'::text) = model_digest)),
    CONSTRAINT embedding_models_dimensions_check CHECK ((dimensions = 768)),
    CONSTRAINT embedding_models_manifest_check CHECK ((jsonb_typeof(manifest) = 'object'::text)),
    CONSTRAINT embedding_models_manifest_digest_check CHECK ((manifest_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT embedding_models_model_check CHECK ((btrim(model) <> ''::text)),
    CONSTRAINT embedding_models_model_digest_check CHECK ((model_digest ~ '^sha256:[a-f0-9]{64}$'::text)),
    CONSTRAINT embedding_models_provider_check CHECK ((provider = ANY (ARRAY['ollama'::text, 'local-process'::text, 'local-file'::text]))),
    CONSTRAINT embedding_models_version_check CHECK ((btrim(version) <> ''::text))
);


--
-- Name: erasure_attachment_objects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.erasure_attachment_objects (
    erasure_job_id text NOT NULL,
    attachment_id text NOT NULL,
    object_key text NOT NULL
);


--
-- Name: erasure_conversation_scope; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.erasure_conversation_scope (
    erasure_job_id text NOT NULL,
    conversation_id text NOT NULL,
    erase_all boolean NOT NULL
);


--
-- Name: erasure_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.erasure_jobs (
    id text NOT NULL,
    subject_type text NOT NULL,
    subject_id text NOT NULL,
    requested_by text,
    reason_code text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    requested_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    last_error_code text,
    CONSTRAINT erasure_jobs_check CHECK (((status = 'completed'::text) = (completed_at IS NOT NULL))),
    CONSTRAINT erasure_jobs_id_check CHECK ((btrim(id) <> ''::text)),
    CONSTRAINT erasure_jobs_reason_code_check CHECK ((btrim(reason_code) <> ''::text)),
    CONSTRAINT erasure_jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'reconciling'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT erasure_jobs_subject_id_check CHECK ((btrim(subject_id) <> ''::text)),
    CONSTRAINT erasure_jobs_subject_type_check CHECK ((subject_type = ANY (ARRAY['user'::text, 'conversation'::text, 'message'::text])))
);


--
-- Name: erasure_knowledge_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.erasure_knowledge_sources (
    erasure_job_id text NOT NULL,
    source_id text NOT NULL
);


--
-- Name: erasure_targets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.erasure_targets (
    erasure_job_id text NOT NULL,
    store text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error_code text,
    verified_at timestamp with time zone,
    CONSTRAINT erasure_targets_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT erasure_targets_check CHECK (((status = 'verified'::text) = (verified_at IS NOT NULL))),
    CONSTRAINT erasure_targets_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'verified'::text, 'failed'::text]))),
    CONSTRAINT erasure_targets_store_check CHECK ((store = ANY (ARRAY['postgres'::text, 'attachments'::text, 'embeddings'::text, 'search'::text, 'cache'::text, 'temporary_derivatives'::text, 'provider_payloads'::text])))
);


--
-- Name: event_journal; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_journal (
    journal_seq bigint NOT NULL,
    event_id text NOT NULL,
    schema_version smallint NOT NULL,
    run_id text NOT NULL,
    conversation_id text NOT NULL,
    event_sequence bigint NOT NULL,
    turn_number integer NOT NULL,
    event_type text NOT NULL,
    sensitivity text NOT NULL,
    event jsonb NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    persisted_at timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,
    CONSTRAINT event_journal_event_check CHECK ((jsonb_typeof(event) = 'object'::text)),
    CONSTRAINT event_journal_event_id_check CHECK ((btrim(event_id) <> ''::text)),
    CONSTRAINT event_journal_event_sequence_check CHECK ((event_sequence >= 0)),
    CONSTRAINT event_journal_event_type_check CHECK ((btrim(event_type) <> ''::text)),
    CONSTRAINT event_journal_schema_version_check CHECK ((schema_version > 0)),
    CONSTRAINT event_journal_sensitivity_check CHECK ((sensitivity = ANY (ARRAY['content'::text, 'derived-content'::text, 'metadata'::text]))),
    CONSTRAINT event_journal_turn_number_check CHECK ((turn_number >= 0))
);


--
-- Name: event_journal_journal_seq_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.event_journal ALTER COLUMN journal_seq ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.event_journal_journal_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: knowledge_chunks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knowledge_chunks (
    id text NOT NULL,
    source_id text NOT NULL,
    citation_id text NOT NULL,
    ordinal integer NOT NULL,
    content text NOT NULL,
    content_hash text NOT NULL,
    access_policy jsonb NOT NULL,
    lexical_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, content)) STORED,
    created_at timestamp with time zone NOT NULL,
    tombstoned_at timestamp with time zone,
    CONSTRAINT knowledge_chunks_access_policy_check CHECK (((jsonb_typeof(access_policy) = 'object'::text) AND ((access_policy ->> 'visibility'::text) = ANY (ARRAY['public'::text, 'restricted'::text])))),
    CONSTRAINT knowledge_chunks_citation_id_check CHECK ((btrim(citation_id) <> ''::text)),
    CONSTRAINT knowledge_chunks_content_check CHECK ((btrim(content) <> ''::text)),
    CONSTRAINT knowledge_chunks_content_hash_check CHECK ((content_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT knowledge_chunks_id_check CHECK ((btrim(id) <> ''::text)),
    CONSTRAINT knowledge_chunks_ordinal_check CHECK ((ordinal >= 0))
);


--
-- Name: knowledge_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knowledge_sources (
    id text NOT NULL,
    source_type text NOT NULL,
    source_uri text NOT NULL,
    source_version text NOT NULL,
    title text,
    message_id text,
    attachment_id text,
    created_at timestamp with time zone NOT NULL,
    tombstoned_at timestamp with time zone,
    CONSTRAINT knowledge_sources_check CHECK ((((source_type = 'message'::text) AND (message_id IS NOT NULL) AND (attachment_id IS NULL)) OR ((source_type = 'attachment'::text) AND (attachment_id IS NOT NULL) AND (message_id IS NULL)) OR ((source_type = 'document'::text) AND (message_id IS NULL) AND (attachment_id IS NULL)))),
    CONSTRAINT knowledge_sources_id_check CHECK ((btrim(id) <> ''::text)),
    CONSTRAINT knowledge_sources_source_type_check CHECK ((source_type = ANY (ARRAY['message'::text, 'attachment'::text, 'document'::text]))),
    CONSTRAINT knowledge_sources_source_uri_check CHECK ((btrim(source_uri) <> ''::text)),
    CONSTRAINT knowledge_sources_source_version_check CHECK ((btrim(source_version) <> ''::text)),
    CONSTRAINT knowledge_sources_title_check CHECK (((title IS NULL) OR (btrim(title) <> ''::text)))
);


--
-- Name: outbox_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbox_jobs (
    id text NOT NULL,
    topic text NOT NULL,
    aggregate_type text NOT NULL,
    aggregate_id text NOT NULL,
    idempotency_key text NOT NULL,
    payload jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone NOT NULL,
    locked_at timestamp with time zone,
    locked_by text,
    last_error_code text,
    created_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT outbox_jobs_aggregate_id_check CHECK ((btrim(aggregate_id) <> ''::text)),
    CONSTRAINT outbox_jobs_aggregate_type_check CHECK ((btrim(aggregate_type) <> ''::text)),
    CONSTRAINT outbox_jobs_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT outbox_jobs_check CHECK (((locked_at IS NULL) = (locked_by IS NULL))),
    CONSTRAINT outbox_jobs_check1 CHECK (((status = 'completed'::text) = (completed_at IS NOT NULL))),
    CONSTRAINT outbox_jobs_id_check CHECK ((btrim(id) <> ''::text)),
    CONSTRAINT outbox_jobs_idempotency_key_check CHECK ((btrim(idempotency_key) <> ''::text)),
    CONSTRAINT outbox_jobs_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT outbox_jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT outbox_jobs_topic_check CHECK ((btrim(topic) <> ''::text))
);


--
-- Name: retrievable_event_journal; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.retrievable_event_journal AS
 SELECT journal.journal_seq,
    journal.event_id,
    journal.schema_version,
    journal.run_id,
    journal.conversation_id,
    journal.event_sequence,
    journal.turn_number,
    journal.event_type,
    journal.sensitivity,
    journal.event,
    journal.occurred_at,
    journal.persisted_at
   FROM (public.event_journal journal
     JOIN public.conversations conversation ON ((conversation.id = journal.conversation_id)))
  WHERE ((NOT (EXISTS ( SELECT 1
           FROM public.erasure_tombstones erased
          WHERE (((erased.subject_type = 'conversation'::text) AND (erased.subject_id = journal.conversation_id)) OR ((erased.subject_type = 'user'::text) AND (erased.subject_id = conversation.created_by)))))) AND (NOT (EXISTS ( SELECT 1
           FROM public.erasure_message_scope erased
          WHERE (erased.message_id = COALESCE((journal.event #>> '{payload,message,messageId}'::text[]), (journal.event #>> '{payload,messageId}'::text[])))))));


--
-- Name: run_commands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_commands (
    id text NOT NULL,
    run_id text NOT NULL,
    conversation_id text NOT NULL,
    user_id text NOT NULL,
    session_id text NOT NULL,
    idempotency_key text NOT NULL,
    request_sha256 text NOT NULL,
    message_id text NOT NULL,
    config_key text NOT NULL,
    max_turns integer NOT NULL,
    causation_id text NOT NULL,
    accepted_at timestamp with time zone NOT NULL,
    CONSTRAINT run_commands_causation_id_check CHECK ((btrim(causation_id) <> ''::text)),
    CONSTRAINT run_commands_config_key_check CHECK ((btrim(config_key) <> ''::text)),
    CONSTRAINT run_commands_id_check CHECK ((btrim(id) <> ''::text)),
    CONSTRAINT run_commands_idempotency_key_check CHECK ((((char_length(idempotency_key) >= 16) AND (char_length(idempotency_key) <= 128)) AND (idempotency_key ~ '^[A-Za-z0-9._:-]+$'::text))),
    CONSTRAINT run_commands_max_turns_check CHECK (((max_turns >= 1) AND (max_turns <= 32))),
    CONSTRAINT run_commands_request_sha256_check CHECK ((request_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT run_commands_session_id_check CHECK ((btrim(session_id) <> ''::text))
);


--
-- Name: run_control_reservations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_control_reservations (
    id text NOT NULL,
    run_id text NOT NULL,
    user_id text NOT NULL,
    idempotency_key text NOT NULL,
    request_sha256 text NOT NULL,
    config_key text NOT NULL,
    model_scope text NOT NULL,
    reserved_tokens bigint NOT NULL,
    reserved_cost_usd numeric(20,10) NOT NULL,
    observed_tokens bigint,
    observed_cost_usd numeric(20,10),
    status text NOT NULL,
    accounting_state text NOT NULL,
    accepted_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    settled_at timestamp with time zone,
    CONSTRAINT run_control_reservations_accounting_state_check CHECK ((accounting_state = ANY (ARRAY['reserved'::text, 'measured'::text, 'conservative'::text]))),
    CONSTRAINT run_control_reservations_check CHECK ((expires_at > accepted_at)),
    CONSTRAINT run_control_reservations_check1 CHECK ((((status = 'active'::text) AND (accounting_state = 'reserved'::text) AND (observed_tokens IS NULL) AND (observed_cost_usd IS NULL) AND (settled_at IS NULL)) OR ((status = 'settled'::text) AND (accounting_state = ANY (ARRAY['measured'::text, 'conservative'::text])) AND (observed_tokens IS NOT NULL) AND (observed_cost_usd IS NOT NULL) AND (settled_at IS NOT NULL)) OR ((status = 'released'::text) AND (accounting_state = 'reserved'::text) AND (observed_tokens IS NULL) AND (observed_cost_usd IS NULL) AND (settled_at IS NOT NULL)))),
    CONSTRAINT run_control_reservations_config_key_check CHECK ((btrim(config_key) <> ''::text)),
    CONSTRAINT run_control_reservations_id_check CHECK ((btrim(id) <> ''::text)),
    CONSTRAINT run_control_reservations_idempotency_key_check CHECK ((((char_length(idempotency_key) >= 16) AND (char_length(idempotency_key) <= 128)) AND (idempotency_key ~ '^[A-Za-z0-9._:-]+$'::text))),
    CONSTRAINT run_control_reservations_model_scope_check CHECK ((btrim(model_scope) <> ''::text)),
    CONSTRAINT run_control_reservations_observed_cost_usd_check CHECK (((observed_cost_usd IS NULL) OR (observed_cost_usd >= (0)::numeric))),
    CONSTRAINT run_control_reservations_observed_tokens_check CHECK (((observed_tokens IS NULL) OR (observed_tokens >= 0))),
    CONSTRAINT run_control_reservations_request_sha256_check CHECK ((request_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT run_control_reservations_reserved_cost_usd_check CHECK ((reserved_cost_usd >= (0)::numeric)),
    CONSTRAINT run_control_reservations_reserved_tokens_check CHECK ((reserved_tokens >= 0)),
    CONSTRAINT run_control_reservations_run_id_check CHECK ((btrim(run_id) <> ''::text)),
    CONSTRAINT run_control_reservations_status_check CHECK ((status = ANY (ARRAY['active'::text, 'settled'::text, 'released'::text])))
);


--
-- Name: runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.runs (
    id text NOT NULL,
    conversation_id text NOT NULL,
    initiated_by text,
    causation_id text NOT NULL,
    correlation_id text,
    config_key text NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    status text NOT NULL,
    terminal_reason text,
    terminal_code text,
    usage jsonb,
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    command_id text,
    runtime_started_at timestamp with time zone,
    CONSTRAINT runs_causation_id_check CHECK ((btrim(causation_id) <> ''::text)),
    CONSTRAINT runs_check CHECK ((((status = 'running'::text) AND (completed_at IS NULL) AND (terminal_reason IS NULL)) OR ((status <> 'running'::text) AND (completed_at IS NOT NULL) AND (terminal_reason IS NOT NULL)))),
    CONSTRAINT runs_config_key_check CHECK ((btrim(config_key) <> ''::text)),
    CONSTRAINT runs_correlation_id_check CHECK (((correlation_id IS NULL) OR (btrim(correlation_id) <> ''::text))),
    CONSTRAINT runs_id_check CHECK ((btrim(id) <> ''::text)),
    CONSTRAINT runs_model_check CHECK ((btrim(model) <> ''::text)),
    CONSTRAINT runs_provider_check CHECK ((btrim(provider) <> ''::text)),
    CONSTRAINT runs_runtime_started_after_acceptance CHECK (((runtime_started_at IS NULL) OR (runtime_started_at >= started_at))),
    CONSTRAINT runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text, 'cancelled'::text, 'needs_approval'::text, 'persistence_unavailable'::text]))),
    CONSTRAINT runs_usage_check CHECK (((usage IS NULL) OR (jsonb_typeof(usage) = 'object'::text)))
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version character varying NOT NULL
);


--
-- Name: server_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.server_sessions (
    id text NOT NULL,
    user_id text NOT NULL,
    token_sha256 text NOT NULL,
    status text NOT NULL,
    issued_by text NOT NULL,
    issued_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_by text,
    revoked_at timestamp with time zone,
    CONSTRAINT server_sessions_check CHECK ((expires_at > issued_at)),
    CONSTRAINT server_sessions_check1 CHECK ((((status = 'active'::text) AND (revoked_by IS NULL) AND (revoked_at IS NULL)) OR ((status = 'revoked'::text) AND (revoked_by IS NOT NULL) AND (revoked_at IS NOT NULL)))),
    CONSTRAINT server_sessions_id_check CHECK ((btrim(id) <> ''::text)),
    CONSTRAINT server_sessions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text]))),
    CONSTRAINT server_sessions_token_sha256_check CHECK ((token_sha256 ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: tool_calls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tool_calls (
    run_id text NOT NULL,
    tool_call_id text NOT NULL,
    turn_id text NOT NULL,
    conversation_id text NOT NULL,
    tool_name text NOT NULL,
    arguments jsonb NOT NULL,
    arguments_hash text NOT NULL,
    requested_at timestamp with time zone NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    is_error boolean,
    result jsonb,
    CONSTRAINT tool_calls_arguments_check CHECK ((jsonb_typeof(arguments) = 'object'::text)),
    CONSTRAINT tool_calls_arguments_hash_check CHECK ((arguments_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT tool_calls_check CHECK (((completed_at IS NULL) = (is_error IS NULL))),
    CONSTRAINT tool_calls_check1 CHECK (((result IS NULL) OR (completed_at IS NOT NULL))),
    CONSTRAINT tool_calls_tool_call_id_check CHECK ((btrim(tool_call_id) <> ''::text)),
    CONSTRAINT tool_calls_tool_name_check CHECK ((btrim(tool_name) <> ''::text))
);


--
-- Name: tool_decisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tool_decisions (
    id text NOT NULL,
    run_id text NOT NULL,
    tool_call_id text NOT NULL,
    capability text NOT NULL,
    capabilities text[] NOT NULL,
    decision text NOT NULL,
    reason_code text NOT NULL,
    detail text,
    decided_at timestamp with time zone NOT NULL,
    CONSTRAINT tool_decisions_capabilities_check CHECK ((cardinality(capabilities) > 0)),
    CONSTRAINT tool_decisions_capability_check CHECK ((btrim(capability) <> ''::text)),
    CONSTRAINT tool_decisions_decision_check CHECK ((decision = ANY (ARRAY['allow'::text, 'deny'::text, 'requireApproval'::text]))),
    CONSTRAINT tool_decisions_id_check CHECK ((btrim(id) <> ''::text)),
    CONSTRAINT tool_decisions_reason_code_check CHECK ((btrim(reason_code) <> ''::text))
);


--
-- Name: turns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.turns (
    id text NOT NULL,
    run_id text NOT NULL,
    conversation_id text NOT NULL,
    turn_number integer NOT NULL,
    input_message_id text,
    stop_reason text,
    budget_tokens bigint,
    budget_source text,
    usage jsonb,
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT turns_budget_source_check CHECK ((budget_source = ANY (ARRAY['anchored'::text, 'estimated'::text]))),
    CONSTRAINT turns_budget_tokens_check CHECK (((budget_tokens IS NULL) OR (budget_tokens >= 0))),
    CONSTRAINT turns_check CHECK (((budget_tokens IS NULL) = (budget_source IS NULL))),
    CONSTRAINT turns_check1 CHECK (((completed_at IS NULL) = (stop_reason IS NULL))),
    CONSTRAINT turns_id_check CHECK ((btrim(id) <> ''::text)),
    CONSTRAINT turns_stop_reason_check CHECK ((stop_reason = ANY (ARRAY['stop'::text, 'length'::text, 'toolUse'::text, 'error'::text, 'aborted'::text]))),
    CONSTRAINT turns_turn_number_check CHECK ((turn_number >= 0)),
    CONSTRAINT turns_usage_check CHECK (((usage IS NULL) OR (jsonb_typeof(usage) = 'object'::text)))
);


--
-- Name: user_model_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_model_grants (
    user_id text NOT NULL,
    config_key text NOT NULL,
    granted_by text NOT NULL,
    granted_at timestamp with time zone NOT NULL,
    CONSTRAINT user_model_grants_config_key_check CHECK ((((char_length(config_key) >= 1) AND (char_length(config_key) <= 128)) AND (config_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'::text)))
);


--
-- Name: user_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_roles (
    user_id text NOT NULL,
    role text NOT NULL,
    granted_by text NOT NULL,
    granted_at timestamp with time zone NOT NULL,
    CONSTRAINT user_roles_role_check CHECK ((role = ANY (ARRAY['member'::text, 'admin'::text])))
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id text NOT NULL,
    external_subject text NOT NULL,
    display_name text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    disabled_at timestamp with time zone,
    CONSTRAINT users_check CHECK (((status = 'disabled'::text) = (disabled_at IS NOT NULL))),
    CONSTRAINT users_display_name_check CHECK ((btrim(display_name) <> ''::text)),
    CONSTRAINT users_external_subject_check CHECK ((btrim(external_subject) <> ''::text)),
    CONSTRAINT users_id_check CHECK ((btrim(id) <> ''::text)),
    CONSTRAINT users_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text])))
);


--
-- Name: approvals approvals_authenticated_resolution; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.approvals
    ADD CONSTRAINT approvals_authenticated_resolution CHECK (((status = ANY (ARRAY['approved'::text, 'denied'::text])) = ((resolved_by IS NOT NULL) AND (resolution_session_id IS NOT NULL) AND (resolution_request_sha256 IS NOT NULL)))) NOT VALID;


--
-- Name: approvals approvals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_pkey PRIMARY KEY (id);


--
-- Name: approvals approvals_run_id_tool_call_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_run_id_tool_call_id_key UNIQUE (run_id, tool_call_id);


--
-- Name: attachments attachments_object_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_object_key_key UNIQUE (object_key);


--
-- Name: attachments attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_pkey PRIMARY KEY (id);


--
-- Name: audit_events audit_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_pkey PRIMARY KEY (event_id);


--
-- Name: audit_events audit_events_run_id_event_sequence_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_run_id_event_sequence_key UNIQUE (run_id, event_sequence);


--
-- Name: chunk_embeddings chunk_embeddings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chunk_embeddings
    ADD CONSTRAINT chunk_embeddings_pkey PRIMARY KEY (chunk_id, manifest_digest);


--
-- Name: consumer_checkpoints consumer_checkpoints_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consumer_checkpoints
    ADD CONSTRAINT consumer_checkpoints_pkey PRIMARY KEY (consumer_name);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: embedding_models embedding_models_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.embedding_models
    ADD CONSTRAINT embedding_models_pkey PRIMARY KEY (manifest_digest);


--
-- Name: erasure_attachment_objects erasure_attachment_objects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.erasure_attachment_objects
    ADD CONSTRAINT erasure_attachment_objects_pkey PRIMARY KEY (erasure_job_id, attachment_id);


--
-- Name: erasure_conversation_scope erasure_conversation_scope_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.erasure_conversation_scope
    ADD CONSTRAINT erasure_conversation_scope_pkey PRIMARY KEY (erasure_job_id, conversation_id);


--
-- Name: erasure_jobs erasure_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.erasure_jobs
    ADD CONSTRAINT erasure_jobs_pkey PRIMARY KEY (id);


--
-- Name: erasure_jobs erasure_jobs_subject_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.erasure_jobs
    ADD CONSTRAINT erasure_jobs_subject_unique UNIQUE (subject_type, subject_id);


--
-- Name: erasure_knowledge_sources erasure_knowledge_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.erasure_knowledge_sources
    ADD CONSTRAINT erasure_knowledge_sources_pkey PRIMARY KEY (erasure_job_id, source_id);


--
-- Name: erasure_message_scope erasure_message_scope_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.erasure_message_scope
    ADD CONSTRAINT erasure_message_scope_pkey PRIMARY KEY (erasure_job_id, message_id);


--
-- Name: erasure_targets erasure_targets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.erasure_targets
    ADD CONSTRAINT erasure_targets_pkey PRIMARY KEY (erasure_job_id, store);


--
-- Name: erasure_tombstones erasure_tombstones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.erasure_tombstones
    ADD CONSTRAINT erasure_tombstones_pkey PRIMARY KEY (erasure_job_id);


--
-- Name: erasure_tombstones erasure_tombstones_subject_type_subject_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.erasure_tombstones
    ADD CONSTRAINT erasure_tombstones_subject_type_subject_id_key UNIQUE (subject_type, subject_id);


--
-- Name: event_journal event_journal_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_journal
    ADD CONSTRAINT event_journal_event_id_key UNIQUE (event_id);


--
-- Name: event_journal event_journal_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_journal
    ADD CONSTRAINT event_journal_pkey PRIMARY KEY (journal_seq);


--
-- Name: event_journal event_journal_run_id_event_sequence_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_journal
    ADD CONSTRAINT event_journal_run_id_event_sequence_key UNIQUE (run_id, event_sequence);


--
-- Name: knowledge_chunks knowledge_chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_chunks
    ADD CONSTRAINT knowledge_chunks_pkey PRIMARY KEY (id);


--
-- Name: knowledge_chunks knowledge_chunks_source_id_ordinal_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_chunks
    ADD CONSTRAINT knowledge_chunks_source_id_ordinal_key UNIQUE (source_id, ordinal);


--
-- Name: knowledge_sources knowledge_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_sources
    ADD CONSTRAINT knowledge_sources_pkey PRIMARY KEY (id);


--
-- Name: messages messages_conversation_id_seq_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_conversation_id_seq_key UNIQUE (conversation_id, seq);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: messages messages_supersedes_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_supersedes_id_key UNIQUE (supersedes_id);


--
-- Name: outbox_jobs outbox_jobs_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox_jobs
    ADD CONSTRAINT outbox_jobs_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: outbox_jobs outbox_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox_jobs
    ADD CONSTRAINT outbox_jobs_pkey PRIMARY KEY (id);


--
-- Name: run_commands run_commands_message_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_commands
    ADD CONSTRAINT run_commands_message_id_key UNIQUE (message_id);


--
-- Name: run_commands run_commands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_commands
    ADD CONSTRAINT run_commands_pkey PRIMARY KEY (id);


--
-- Name: run_commands run_commands_run_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_commands
    ADD CONSTRAINT run_commands_run_id_key UNIQUE (run_id);


--
-- Name: run_commands run_commands_user_id_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_commands
    ADD CONSTRAINT run_commands_user_id_idempotency_key_key UNIQUE (user_id, idempotency_key);


--
-- Name: run_control_reservations run_control_reservations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_control_reservations
    ADD CONSTRAINT run_control_reservations_pkey PRIMARY KEY (id);


--
-- Name: run_control_reservations run_control_reservations_run_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_control_reservations
    ADD CONSTRAINT run_control_reservations_run_id_key UNIQUE (run_id);


--
-- Name: run_control_reservations run_control_reservations_user_id_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_control_reservations
    ADD CONSTRAINT run_control_reservations_user_id_idempotency_key_key UNIQUE (user_id, idempotency_key);


--
-- Name: runs runs_command_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_command_id_key UNIQUE (command_id);


--
-- Name: runs runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: server_sessions server_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_sessions
    ADD CONSTRAINT server_sessions_pkey PRIMARY KEY (id);


--
-- Name: server_sessions server_sessions_token_sha256_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_sessions
    ADD CONSTRAINT server_sessions_token_sha256_key UNIQUE (token_sha256);


--
-- Name: tool_calls tool_calls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_calls
    ADD CONSTRAINT tool_calls_pkey PRIMARY KEY (run_id, tool_call_id);


--
-- Name: tool_decisions tool_decisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_decisions
    ADD CONSTRAINT tool_decisions_pkey PRIMARY KEY (id);


--
-- Name: tool_decisions tool_decisions_run_id_tool_call_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_decisions
    ADD CONSTRAINT tool_decisions_run_id_tool_call_id_key UNIQUE (run_id, tool_call_id);


--
-- Name: turns turns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turns
    ADD CONSTRAINT turns_pkey PRIMARY KEY (id);


--
-- Name: turns turns_run_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turns
    ADD CONSTRAINT turns_run_id_id_key UNIQUE (run_id, id);


--
-- Name: turns turns_run_id_turn_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turns
    ADD CONSTRAINT turns_run_id_turn_number_key UNIQUE (run_id, turn_number);


--
-- Name: user_model_grants user_model_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_model_grants
    ADD CONSTRAINT user_model_grants_pkey PRIMARY KEY (user_id, config_key);


--
-- Name: user_roles user_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_pkey PRIMARY KEY (user_id, role);


--
-- Name: users users_external_subject_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_external_subject_key UNIQUE (external_subject);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: audit_events_recorded_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_recorded_idx ON public.audit_events USING btree (recorded_at, event_id);


--
-- Name: chunk_embeddings_vector_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chunk_embeddings_vector_idx ON public.chunk_embeddings USING hnsw (embedding public.vector_cosine_ops);


--
-- Name: erasure_attachment_objects_job_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_attachment_objects_job_idx ON public.erasure_attachment_objects USING btree (erasure_job_id, attachment_id);


--
-- Name: erasure_knowledge_sources_job_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_knowledge_sources_job_idx ON public.erasure_knowledge_sources USING btree (erasure_job_id, source_id);


--
-- Name: erasure_message_scope_conversation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_message_scope_conversation_idx ON public.erasure_message_scope USING btree (erasure_job_id, conversation_id);


--
-- Name: knowledge_chunks_access_groups_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX knowledge_chunks_access_groups_idx ON public.knowledge_chunks USING gin (((access_policy -> 'allowedGroups'::text)));


--
-- Name: knowledge_chunks_access_users_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX knowledge_chunks_access_users_idx ON public.knowledge_chunks USING gin (((access_policy -> 'allowedUsers'::text)));


--
-- Name: knowledge_chunks_lexical_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX knowledge_chunks_lexical_idx ON public.knowledge_chunks USING gin (lexical_vector);


--
-- Name: messages_conversation_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_conversation_created_idx ON public.messages USING btree (conversation_id, created_at, seq);


--
-- Name: outbox_jobs_ready_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbox_jobs_ready_idx ON public.outbox_jobs USING btree (available_at, created_at, id) WHERE (status = ANY (ARRAY['pending'::text, 'failed'::text]));


--
-- Name: run_commands_conversation_accepted_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_commands_conversation_accepted_idx ON public.run_commands USING btree (conversation_id, accepted_at DESC, id);


--
-- Name: run_control_model_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_control_model_active_idx ON public.run_control_reservations USING btree (model_scope, expires_at) WHERE (status = 'active'::text);


--
-- Name: run_control_user_window_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX run_control_user_window_idx ON public.run_control_reservations USING btree (user_id, accepted_at DESC);


--
-- Name: runs_conversation_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_conversation_started_idx ON public.runs USING btree (conversation_id, started_at DESC, id);


--
-- Name: server_sessions_user_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX server_sessions_user_status_idx ON public.server_sessions USING btree (user_id, status, expires_at DESC, id);


--
-- Name: attachments attachments_erasure_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER attachments_erasure_guard AFTER INSERT ON public.attachments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reject_erased_content_write();


--
-- Name: audit_events audit_events_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_events_append_only BEFORE UPDATE ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.reject_row_update();


--
-- Name: event_journal event_journal_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER event_journal_append_only BEFORE UPDATE ON public.event_journal FOR EACH ROW EXECUTE FUNCTION public.reject_row_update();


--
-- Name: event_journal event_journal_erasure_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER event_journal_erasure_guard AFTER INSERT ON public.event_journal DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reject_erased_content_write();


--
-- Name: knowledge_chunks knowledge_chunks_erasure_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER knowledge_chunks_erasure_guard AFTER INSERT ON public.knowledge_chunks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reject_erased_content_write();


--
-- Name: knowledge_sources knowledge_sources_erasure_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER knowledge_sources_erasure_guard AFTER INSERT ON public.knowledge_sources DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reject_erased_content_write();


--
-- Name: messages messages_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER messages_append_only BEFORE UPDATE ON public.messages FOR EACH ROW EXECUTE FUNCTION public.reject_row_update();


--
-- Name: messages messages_erasure_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER messages_erasure_guard AFTER INSERT ON public.messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.reject_erased_content_write();


--
-- Name: messages messages_revision_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER messages_revision_guard BEFORE INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION public.enforce_message_revision();


--
-- Name: approvals approvals_resolution_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_resolution_session_id_fkey FOREIGN KEY (resolution_session_id) REFERENCES public.server_sessions(id);


--
-- Name: approvals approvals_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id);


--
-- Name: approvals approvals_run_id_tool_call_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_run_id_tool_call_id_fkey FOREIGN KEY (run_id, tool_call_id) REFERENCES public.tool_calls(run_id, tool_call_id);


--
-- Name: attachments attachments_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id);


--
-- Name: attachments attachments_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.messages(id);


--
-- Name: chunk_embeddings chunk_embeddings_chunk_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chunk_embeddings
    ADD CONSTRAINT chunk_embeddings_chunk_id_fkey FOREIGN KEY (chunk_id) REFERENCES public.knowledge_chunks(id) ON DELETE CASCADE;


--
-- Name: chunk_embeddings chunk_embeddings_manifest_digest_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chunk_embeddings
    ADD CONSTRAINT chunk_embeddings_manifest_digest_fkey FOREIGN KEY (manifest_digest) REFERENCES public.embedding_models(manifest_digest);


--
-- Name: conversations conversations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: erasure_attachment_objects erasure_attachment_objects_erasure_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.erasure_attachment_objects
    ADD CONSTRAINT erasure_attachment_objects_erasure_job_id_fkey FOREIGN KEY (erasure_job_id) REFERENCES public.erasure_jobs(id) ON DELETE CASCADE;


--
-- Name: erasure_conversation_scope erasure_conversation_scope_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.erasure_conversation_scope
    ADD CONSTRAINT erasure_conversation_scope_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id);


--
-- Name: erasure_conversation_scope erasure_conversation_scope_erasure_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.erasure_conversation_scope
    ADD CONSTRAINT erasure_conversation_scope_erasure_job_id_fkey FOREIGN KEY (erasure_job_id) REFERENCES public.erasure_jobs(id) ON DELETE CASCADE;


--
-- Name: erasure_jobs erasure_jobs_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.erasure_jobs
    ADD CONSTRAINT erasure_jobs_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id);


--
-- Name: erasure_knowledge_sources erasure_knowledge_sources_erasure_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.erasure_knowledge_sources
    ADD CONSTRAINT erasure_knowledge_sources_erasure_job_id_fkey FOREIGN KEY (erasure_job_id) REFERENCES public.erasure_jobs(id) ON DELETE CASCADE;


--
-- Name: erasure_message_scope erasure_message_scope_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.erasure_message_scope
    ADD CONSTRAINT erasure_message_scope_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id);


--
-- Name: erasure_message_scope erasure_message_scope_erasure_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.erasure_message_scope
    ADD CONSTRAINT erasure_message_scope_erasure_job_id_fkey FOREIGN KEY (erasure_job_id) REFERENCES public.erasure_jobs(id) ON DELETE CASCADE;


--
-- Name: erasure_targets erasure_targets_erasure_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.erasure_targets
    ADD CONSTRAINT erasure_targets_erasure_job_id_fkey FOREIGN KEY (erasure_job_id) REFERENCES public.erasure_jobs(id) ON DELETE CASCADE;


--
-- Name: erasure_tombstones erasure_tombstones_erasure_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.erasure_tombstones
    ADD CONSTRAINT erasure_tombstones_erasure_job_id_fkey FOREIGN KEY (erasure_job_id) REFERENCES public.erasure_jobs(id) ON DELETE CASCADE;


--
-- Name: event_journal event_journal_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_journal
    ADD CONSTRAINT event_journal_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id);


--
-- Name: event_journal event_journal_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_journal
    ADD CONSTRAINT event_journal_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id);


--
-- Name: knowledge_chunks knowledge_chunks_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_chunks
    ADD CONSTRAINT knowledge_chunks_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.knowledge_sources(id);


--
-- Name: knowledge_sources knowledge_sources_attachment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_sources
    ADD CONSTRAINT knowledge_sources_attachment_id_fkey FOREIGN KEY (attachment_id) REFERENCES public.attachments(id);


--
-- Name: knowledge_sources knowledge_sources_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_sources
    ADD CONSTRAINT knowledge_sources_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.messages(id);


--
-- Name: messages messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id);


--
-- Name: messages messages_supersedes_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_supersedes_id_fkey FOREIGN KEY (supersedes_id) REFERENCES public.messages(id);


--
-- Name: run_commands run_commands_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_commands
    ADD CONSTRAINT run_commands_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id);


--
-- Name: run_commands run_commands_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_commands
    ADD CONSTRAINT run_commands_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.messages(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_commands run_commands_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_commands
    ADD CONSTRAINT run_commands_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: run_commands run_commands_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_commands
    ADD CONSTRAINT run_commands_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: run_control_reservations run_control_reservations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_control_reservations
    ADD CONSTRAINT run_control_reservations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: runs runs_command_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_command_id_fkey FOREIGN KEY (command_id) REFERENCES public.run_commands(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: runs runs_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id);


--
-- Name: runs runs_initiated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_initiated_by_fkey FOREIGN KEY (initiated_by) REFERENCES public.users(id);


--
-- Name: server_sessions server_sessions_issued_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_sessions
    ADD CONSTRAINT server_sessions_issued_by_fkey FOREIGN KEY (issued_by) REFERENCES public.users(id);


--
-- Name: server_sessions server_sessions_revoked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_sessions
    ADD CONSTRAINT server_sessions_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES public.users(id);


--
-- Name: server_sessions server_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_sessions
    ADD CONSTRAINT server_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: tool_calls tool_calls_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_calls
    ADD CONSTRAINT tool_calls_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id);


--
-- Name: tool_calls tool_calls_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_calls
    ADD CONSTRAINT tool_calls_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id);


--
-- Name: tool_calls tool_calls_run_id_turn_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_calls
    ADD CONSTRAINT tool_calls_run_id_turn_id_fkey FOREIGN KEY (run_id, turn_id) REFERENCES public.turns(run_id, id);


--
-- Name: tool_decisions tool_decisions_run_id_tool_call_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_decisions
    ADD CONSTRAINT tool_decisions_run_id_tool_call_id_fkey FOREIGN KEY (run_id, tool_call_id) REFERENCES public.tool_calls(run_id, tool_call_id);


--
-- Name: turns turns_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turns
    ADD CONSTRAINT turns_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id);


--
-- Name: turns turns_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.turns
    ADD CONSTRAINT turns_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id);


--
-- Name: user_model_grants user_model_grants_granted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_model_grants
    ADD CONSTRAINT user_model_grants_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES public.users(id);


--
-- Name: user_model_grants user_model_grants_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_model_grants
    ADD CONSTRAINT user_model_grants_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: user_roles user_roles_granted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES public.users(id);


--
-- Name: user_roles user_roles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- PostgreSQL database dump complete
--

\unrestrict dbmate


--
-- Dbmate schema migrations
--

INSERT INTO public.schema_migrations (version) VALUES
    ('20260819000100'),
    ('20260821000200'),
    ('20260825000300'),
    ('20260825000400'),
    ('20260825000500');
