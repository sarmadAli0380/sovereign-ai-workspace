-- migrate:up

CREATE TABLE run_commands (
  id text PRIMARY KEY CHECK (btrim(id) <> ''),
  run_id text NOT NULL UNIQUE
    REFERENCES runs(id) DEFERRABLE INITIALLY DEFERRED,
  conversation_id text NOT NULL REFERENCES conversations(id),
  user_id text NOT NULL REFERENCES users(id),
  session_id text NOT NULL CHECK (btrim(session_id) <> ''),
  idempotency_key text NOT NULL CHECK (
    char_length(idempotency_key) BETWEEN 16 AND 128
    AND idempotency_key ~ '^[A-Za-z0-9._:-]+$'
  ),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  message_id text NOT NULL UNIQUE
    REFERENCES messages(id) DEFERRABLE INITIALLY DEFERRED,
  config_key text NOT NULL CHECK (btrim(config_key) <> ''),
  max_turns integer NOT NULL CHECK (max_turns BETWEEN 1 AND 32),
  causation_id text NOT NULL CHECK (btrim(causation_id) <> ''),
  accepted_at timestamptz NOT NULL,
  UNIQUE (user_id, idempotency_key)
);

ALTER TABLE runs
  ADD COLUMN command_id text UNIQUE
    REFERENCES run_commands(id) DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN runtime_started_at timestamptz,
  ADD CONSTRAINT runs_runtime_started_after_acceptance CHECK (
    runtime_started_at IS NULL OR runtime_started_at >= started_at
  );

UPDATE runs SET runtime_started_at = started_at;

CREATE INDEX run_commands_conversation_accepted_idx
  ON run_commands (conversation_id, accepted_at DESC, id);

-- migrate:down

ALTER TABLE runs DROP CONSTRAINT runs_runtime_started_after_acceptance;
ALTER TABLE runs DROP COLUMN runtime_started_at;
ALTER TABLE runs DROP COLUMN command_id;
DROP TABLE run_commands;
