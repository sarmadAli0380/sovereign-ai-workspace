-- migrate:up

CREATE TABLE run_control_reservations (
  id text PRIMARY KEY CHECK (btrim(id) <> ''),
  run_id text NOT NULL UNIQUE CHECK (btrim(run_id) <> ''),
  user_id text NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL CHECK (
    char_length(idempotency_key) BETWEEN 16 AND 128
    AND idempotency_key ~ '^[A-Za-z0-9._:-]+$'
  ),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  config_key text NOT NULL CHECK (btrim(config_key) <> ''),
  model_scope text NOT NULL CHECK (btrim(model_scope) <> ''),
  reserved_tokens bigint NOT NULL CHECK (reserved_tokens >= 0),
  reserved_cost_usd numeric(20, 10) NOT NULL CHECK (reserved_cost_usd >= 0),
  observed_tokens bigint CHECK (observed_tokens IS NULL OR observed_tokens >= 0),
  observed_cost_usd numeric(20, 10) CHECK (
    observed_cost_usd IS NULL OR observed_cost_usd >= 0
  ),
  status text NOT NULL CHECK (status IN ('active', 'settled', 'released')),
  accounting_state text NOT NULL CHECK (
    accounting_state IN ('reserved', 'measured', 'conservative')
  ),
  accepted_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > accepted_at),
  settled_at timestamptz,
  UNIQUE (user_id, idempotency_key),
  CHECK (
    (status = 'active' AND accounting_state = 'reserved'
      AND observed_tokens IS NULL AND observed_cost_usd IS NULL AND settled_at IS NULL)
    OR
    (status = 'settled' AND accounting_state IN ('measured', 'conservative')
      AND observed_tokens IS NOT NULL AND observed_cost_usd IS NOT NULL AND settled_at IS NOT NULL)
    OR
    (status = 'released' AND accounting_state = 'reserved'
      AND observed_tokens IS NULL AND observed_cost_usd IS NULL AND settled_at IS NOT NULL)
  )
);

CREATE INDEX run_control_user_window_idx
  ON run_control_reservations (user_id, accepted_at DESC);

CREATE INDEX run_control_model_active_idx
  ON run_control_reservations (model_scope, expires_at)
  WHERE status = 'active';

CREATE INDEX audit_events_recorded_idx
  ON audit_events (recorded_at, event_id);

-- migrate:down

DROP INDEX audit_events_recorded_idx;
DROP TABLE run_control_reservations;
