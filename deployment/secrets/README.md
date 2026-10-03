# Deployment secrets

Create these three untracked, mode-`0600` files before starting the stack:

- `database_password` — one newline-terminated 32–128 character value using
  only letters, digits, `.`, `_`, or `-`.
- `spool_key` — one newline-terminated, lowercase, 64-character hex value
  (exactly 32 random bytes).
- `session_registry` — the strict C1-compatible bootstrap registry. It contains
  SHA-256 token digests, never raw bearer tokens. On the first C4 start against
  an empty `server_sessions` table, it creates missing bootstrap users and
  imports their roles, model grants, and sessions. Later starts never overwrite
  PostgreSQL administration or revive revoked sessions. Deployed sessions
  should grant only `local-qwen`.

Generate them without printing either secret:

```bash
umask 077
openssl rand -hex -out deployment/secrets/database_password 32
openssl rand -hex -out deployment/secrets/spool_key 32
```

The registry is read during process startup only. After the first successful
bootstrap, PostgreSQL is the live authority and rotation/revocation uses the
authenticated identity administration endpoints. Its shape is:

```json
{
  "schemaVersion": 1,
  "sessions": [{
    "sessionId": "operator-issued-session-id",
    "userId": "existing-database-user-id",
    "tokenSha256": "64-lowercase-hex-characters",
    "roles": ["member"],
    "allowedConfigKeys": ["local-qwen"],
    "expiresAt": "2026-09-01T00:00:00.000Z",
    "status": "active"
  }]
}
```

Compose mounts each secret only into the services that need it. Never put
secret values in `deployment/env.example`, Compose environment entries,
container image layers, logs, or Git.
