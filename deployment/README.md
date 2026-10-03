# Single-node deployment

This is the first supported single-node service: PostgreSQL 18 + pgvector,
local Ollama, immutable migrations, persistent application volumes, the C4
authenticated HTTP/SSE server, readiness, and backup on one client-owned
Docker host. PostgreSQL and Ollama remain unpublished. The server is the only
published port and binds to host loopback by default.

## Connected provisioning

Requirements: a Linux Docker host with Docker Engine and Compose, enough
measured memory for `qwen3:4b` at 8,192 context, and outbound registry/model
access during provisioning.

```bash
cp deployment/env.example .env
umask 077
openssl rand -hex -out deployment/secrets/database_password 32
openssl rand -hex -out deployment/secrets/spool_key 32
# Create deployment/secrets/session_registry as documented in
# deployment/secrets/README.md. Retain the raw bootstrap token securely; only
# its digest belongs in the file.
./deployment/bin/single-node.sh up
```

Set `DEPLOYMENT_ADMISSION_FREE_BYTES` in `.env` from a current target-host
measurement; the server refuses an absent measurement. `up` builds the
lockfile-based local images, runs the explicitly egress-capable
model bootstrap, starts only the internal database/inference services, applies
migrations, initializes volume ownership, runs readiness, and then starts the
authenticated server. It is
idempotent against already-pinned model and migrated database volumes.
The cold model-load gate has a finite ten-minute deadline because a CPU-only
Docker host can take several minutes to repack and warm the 8,192-context
model; this does not relax the required digest or context.

## Commands

```bash
./deployment/bin/single-node.sh verify   # real DB/model/context/storage readiness
./deployment/bin/single-node.sh backup   # custom pg_dump + adjacent SHA-256
./deployment/bin/single-node.sh down     # stops containers; preserves volumes
npm run verify:deployment                # static rendered-topology gate, no daemon needed
```

Run commands require `Authorization: Bearer ...`, `Content-Type:
application/json`, and a caller-owned `Idempotency-Key` of 16–128 safe
identifier characters. Reusing the same key with the same command returns the
same run; reusing it with different content fails with HTTP 409. SSE reconnects
to `GET /v1/runs/:runId/events` with `Last-Event-ID` and replays from the
durable journal before joining live post-acknowledgement fan-out.

On the first start only, the registry bootstraps durable sessions, roles, and
model grants into PostgreSQL. Thereafter admins use `PUT
/v1/admin/users/:userId/access`, `POST /v1/admin/sessions`, and `POST
/v1/admin/sessions/:sessionId/revoke`; newly issued raw tokens are returned
once in a `Cache-Control: no-store` response and only their SHA-256 digests are
stored. Members see and resolve approvals only for conversations they own via
`GET /v1/approvals` and `POST /v1/runs/:runId/approvals/resolve`; admins may act
across the tenant. The resolution body accepts only exact structured decisions,
never conversational text.

C4 admits a new command only after PostgreSQL atomically reserves the current
user/model concurrency slot and the user's rate, token, and spend capacity.
Defaults are one concurrent run per user/model, 60 accepted runs per hour, one
million tokens per day, and zero provider spend for the local Ollama route.
The control lease TTL must exceed the bounded run timeout. A route without an
enforced output limit and product-validated token/cost reporting is rejected
before its message or run is created.

Authenticated product reads are cursor-paginated and capped at 100 rows:
`GET /v1/conversations/:id/messages`, `GET
/v1/conversations/:id/attachments`, and `GET /v1/runs/:id`. Members remain
ownership-filtered. `GET /v1/admin/audit-events` is administrator-only and
reads the metadata/derived-content audit projection, never canonical journal
content. Attachment metadata omits object keys and content hashes.

This deployment is bearer-only. Cookies and all requests carrying an `Origin`
header are rejected, and the server emits no CORS credential authority. A
future browser-cookie mode requires a separately approved same-origin/CSRF
design.

The loopback bind deliberately does not pretend plain HTTP is safe on a wider
network. Put approved TLS termination or a client-network tunnel in front of
`127.0.0.1:8080`; do not expose PostgreSQL, Ollama, or the container port.

Backups land in the ignored, mode-`0700` `deployment/backups` directory. The
client operator must schedule the job, copy successful archives off-host,
enforce the 35-day policy, alert on failures, and rehearse isolated restores.
Do not use `docker compose down --volumes` in an operational deployment.

## Air-gapped provisioning

On a connected staging host, pull/export every digest-pinned upstream image,
build/export the three local images, and populate an Ollama volume with the
bootstrap job. Transfer those artifacts and the model volume through the
client's approved media process. On the disconnected target:

```bash
./deployment/bin/single-node.sh up-airgapped
```

That path performs no build, pull, or bootstrap. It fails if images or the
pinned model are absent. Steady-state workloads attach only to the Compose
`internal` data plane; Ollama cloud support is disabled.

## Service ownership

| Service/job | Lifecycle | Network | Secrets | Durable data |
|---|---|---|---|---|
| `server` | long-running, loopback ingress | internal data plane + one loopback host port | database + spool + bootstrap registry | identities, sessions, approvals, messages, journal, attachments/spool |
| `database` | long-running | internal only | database password | PostgreSQL volume |
| `inference` | long-running | internal only | none | Ollama model volume |
| `migrate` | one-shot | internal only | database password | schema changes |
| `volume-init` | one-shot | none | none | attachment/spool ownership |
| `runtime-check` | one-shot | internal only | database + spool key | canaries only |
| `model-bootstrap` | explicit one-shot | egress | none | Ollama model volume |
| `backup` | operator-scheduled one-shot | internal only | database password | host backup directory |

## Upgrade sequence

1. Run and copy a verified backup.
2. Stage the new digest-pinned images and model artifacts.
3. Build/load the application images from the exact candidate tree.
4. Run forward migrations once.
5. Start the dependency services and run readiness.
6. Start the C4 server only after readiness succeeds and verify health, bootstrap authentication, session revocation, approval, request controls, product reads, and origin negative controls.

Rollback of database state means isolated restore, reconciliation, and forward
repair. Never run `dbmate down` against production. PostgreSQL major upgrades
require a separate restore rehearsal.
