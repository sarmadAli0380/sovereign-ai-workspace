-- migrate:up

CREATE TABLE user_roles (
  user_id text NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('member', 'admin')),
  granted_by text NOT NULL REFERENCES users(id),
  granted_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, role)
);

CREATE TABLE user_model_grants (
  user_id text NOT NULL REFERENCES users(id),
  config_key text NOT NULL CHECK (
    char_length(config_key) BETWEEN 1 AND 128
    AND config_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  granted_by text NOT NULL REFERENCES users(id),
  granted_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, config_key)
);

CREATE TABLE server_sessions (
  id text PRIMARY KEY CHECK (btrim(id) <> ''),
  user_id text NOT NULL REFERENCES users(id),
  token_sha256 text NOT NULL UNIQUE CHECK (token_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  issued_by text NOT NULL REFERENCES users(id),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > issued_at),
  revoked_by text REFERENCES users(id),
  revoked_at timestamptz,
  CHECK (
    (status = 'active' AND revoked_by IS NULL AND revoked_at IS NULL)
    OR
    (status = 'revoked' AND revoked_by IS NOT NULL AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX server_sessions_user_status_idx
  ON server_sessions (user_id, status, expires_at DESC, id);

ALTER TABLE approvals
  ADD COLUMN resolution_session_id text REFERENCES server_sessions(id),
  ADD COLUMN resolution_request_sha256 text CHECK (
    resolution_request_sha256 IS NULL
    OR resolution_request_sha256 ~ '^[a-f0-9]{64}$'
  ),
  ADD CONSTRAINT approvals_authenticated_resolution CHECK (
    (status IN ('approved', 'denied')) = (
      resolved_by IS NOT NULL
      AND resolution_session_id IS NOT NULL
      AND resolution_request_sha256 IS NOT NULL
    )
  ) NOT VALID;

-- migrate:down

ALTER TABLE approvals DROP CONSTRAINT approvals_authenticated_resolution;
ALTER TABLE approvals DROP COLUMN resolution_request_sha256;
ALTER TABLE approvals DROP COLUMN resolution_session_id;
DROP TABLE server_sessions;
DROP TABLE user_model_grants;
DROP TABLE user_roles;
