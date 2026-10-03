# Implementation plan — P3 deployment substrate

**Status:** P3.0 and P3.1 implemented 2026-08-24; deterministic and live
development-environment gates passed. Target-host certification remains a
pre-production gate.  
**Scope:** the supported topology and reproducible single-node deployment
selected by `SESSION-HANDOFF.md` after B7.  
**Decision:** `phase3/adrs/P3.1-single-node-deployment.md`.

## Outcome

Package the completed runtime/persistence foundation so an operator can
provision its real dependencies on one client-owned Docker host without
exposing data services, embedding secrets, silently skipping migrations, or
mistaking process health for application readiness.

## P3.0 — freeze topology and ownership

**Status:** implemented.

- One Linux host, one PostgreSQL/pgvector service, one local Ollama service.
- Internal steady-state network with no data-service host ports. C2 later adds
  the one loopback authenticated server ingress.
- Explicit one-shot egress for connected model provisioning only.
- Named volumes for database, models, attachments, and encrypted spool.
- File-mounted secrets and per-service grants.
- Operator-owned backup schedule, off-host copies, expiry, restore, upgrades,
  and host/network controls.
- No placeholder API in P3.1; C2 now supplies the real authenticated server.

## P3.1 — reproducible Compose deployment

**Status:** implemented.

- Runtime, migration, and model-bootstrap Dockerfiles with immutable upstream
  digests and lockfile-based Node dependencies.
- Compose services for PostgreSQL, Ollama, migrations, model bootstrap,
  volume ownership, runtime readiness, and custom-format backups.
- Connected `up` and pre-provisioned `up-airgapped` operator flows.
- Runtime readiness proves database/extensions/migrations, Ollama/model
  identity/context, and storage/spool behavior.
- Pure topology policy plus a rendered-Compose verifier and negative controls.

**Deterministic gate:** the full database-free suite discovered 448 tests (442
passed, six isolated database/process integrations skipped); typecheck passed;
five focused P3.1 tests passed; `npm run verify:deployment` passed its eight
static checks; the production dependency audit reported zero vulnerabilities;
and `git diff --check` passed.

## P3.2 — live single-node operational proof

**Status:** passed on Docker Desktop's Linux ARM64 engine, 2026-08-24. Repeat
on the target client-owned Linux host before production.

Build every local image and exercise this exact sequence on a supported Docker
host:

1. provision both secret files;
2. bootstrap the pinned model and verify its digest;
3. start PostgreSQL and Ollama and wait for health;
4. apply migrations from an empty volume;
5. initialize application-volume ownership;
6. pass runtime readiness, including a real 8,192-context model load;
7. create and checksum a real custom-format backup;
8. stop/restart without deleting volumes and pass readiness again;
9. confirm steady-state services have no host ports or egress-capable network.

Record Docker/Compose/host architecture, image digests, check results, and
backup digest in a metadata-only dated conformance artifact. A missing Docker
daemon, failed image pull, unavailable accelerator, or skipped model load is
not a pass.

**Development evidence:** `conformance/2026-08-24-single-node-deployment.json`
records the full connected build/bootstrap/migrate/readiness/backup/restart and
network proof. The first model load failed closed at a too-short 120-second
deadline and the first backup exposed incorrect tmpfs ownership; both were
fixed and the complete gates rerun successfully.

## Boundary after P3

P3 packages the foundation but does not make it a workspace. The next product
critical-path milestone is Phase C: an authenticated HTTP/SSE server that
becomes the sole ingress service and reuses the existing runtime, policy,
journal, repository, and deployment readiness boundaries.
