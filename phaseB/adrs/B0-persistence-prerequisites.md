# B0 — Persistence prerequisites

**Status:** Accepted, 2026-08-12
**Depends on:** ADR-003, A0.3 product messages, A4 controlled tools
**Feeds:** B1–B7 and `B1-persistence-and-residency.md`

## Why this ADR exists

These choices change schemas, deployment artifacts, repository contracts, and
recovery tests. They are fixed before B1 so implementation does not quietly
choose them one migration at a time.

## 1. PostgreSQL and vector extension

**Decision:** support PostgreSQL **18.x**, always at the current security/minor
release, with pgvector **0.8.6**. Development and conformance use the same
major and extension version as production. Images and packages are pinned by
digest in deployment manifests, not by a floating tag.

PostgreSQL 18 is supported until November 2030 and the current minor at this
decision is 18.4. PostgreSQL recommends staying on the current minor:
<https://www.postgresql.org/support/versioning/>. pgvector publishes
PostgreSQL-18 packages and v0.8.6 artifacts:
<https://github.com/pgvector/pgvector>.

A major upgrade requires its own restore rehearsal and compatibility evidence;
it is never folded into an ordinary application migration.

## 2. Migration tool and SQL policy

**Decision:** use **dbmate v2.35.0** with timestamped plain-SQL migrations,
transactional migrations by default, and a checked-in `schema.sql`. The
runtime repositories remain explicit SQL; dbmate never becomes a runtime
dependency or query builder.

**Implementation correction, 2026-08-19:** **[VERIFIED]** the pinned dbmate
2.35.0 CLI has no `--strict` option and rejects it as undefined. Applied-file
immutability is therefore enforced by a checked-in SHA-256 manifest exercised
by the test suite, plus review policy; it is not attributed to a nonexistent
dbmate mode.

The selected version is the current signed release at this decision. Dbmate's
documented model is framework-independent plain SQL, ordered migrations, and
transactions by default: <https://github.com/amacneil/dbmate/releases/tag/v2.35.0>
and <https://github.com/amacneil/dbmate>.

Applied migration files are immutable. Production recovery is restore plus
forward migration; destructive `down` blocks are not a production rollback
strategy.

## 3. Attachment backend

**Decision:** the default is a **client-owned local filesystem volume**.
Attachments use content-addressed object keys and integrity hashes outside the
application source tree and web root. Writes stage and use atomic no-clobber
publication on the same filesystem. The local implementation uses a hard link
from the private quarantine file, then removes the quarantine name. Database
rows carry metadata and object identity, never an uncontrolled absolute path.

A client-run S3-compatible backend remains behind the same interface. It
becomes the recommended backend when a deployment has multiple application
nodes, requires storage-layer replication, or cannot meet the recovery
objectives with one encrypted volume. Hosted vendor object storage is not an
implicit fallback and must be inside the accepted residency boundary.

## 4. Encryption and key-management boundary

**Decision:** B1 does not add ad-hoc per-row application encryption. All data
stores that can contain client data—PostgreSQL, attachments, journal spool,
temporary processing, logs, vector indexes, and backups—must reside on
deployment-managed encrypted volumes. Network database access requires TLS;
a same-host Unix socket is also acceptable. Backups are encrypted before
leaving the host.

Keys belong to the client deployment boundary: a customer-managed KMS/HSM in
private cloud, or the host keystore/offline recovery secret on premises. The
application receives short-lived credentials or key handles from the
deployment secret mechanism. Raw master keys never live in PostgreSQL, source
control, configuration JSON, logs, or backup manifests.

This boundary protects lost media and backups but does not claim to hide data
from an authorized database or host administrator. A customer requirement to
exclude those administrators triggers a separate envelope-encryption ADR
before schema implementation for that deployment; it cannot be retrofitted as
a checkbox.

## 5. Backup, restore, RPO, and RTO

**Decision:** the baseline objectives are **RPO at most 15 minutes** and
**RTO at most 4 hours** for a supported single-tenant deployment.

- PostgreSQL uses encrypted pgBackRest full/differential backups plus continuous
  WAL archiving. The deployment keeps at least 30 days and one monthly recovery
  point for 12 months unless a shorter legal retention policy requires erasure.
- The immutable content-addressed attachment volume, encrypted spool, model and
  configuration manifests, and key-recovery metadata are included in the
  backup inventory. Attachment replication/snapshots must meet the same RPO.
- Restore is into a clean environment, then migrations run forward. Recovery
  verifies message/event ordering, schema versions, attachment hashes,
  embedding-model identity, outbox checkpoints, and retrieval visibility.
- A restore drill is required before release and at least quarterly. A backup
  that has not passed a restore drill is not accepted recovery evidence.

Deployments may declare stricter objectives. Relaxing either default requires
documented customer acceptance and updated capacity/backup evidence.

## 6. Tenancy boundary

**Decision:** one installation and one database serve **one legal/security
tenant**. B1 carries no speculative `tenant_id` and does not claim row-level
tenant isolation.

Work stops for a tenancy ADR before the first deployment that would place two
independent legal organizations, data-residency domains, or mutually untrusted
administrative domains in one database/control plane. That ADR must choose and
test database-per-tenant, schema-per-tenant, or row-level security before any
shared deployment. User roles and teams inside one customer do not by
themselves trigger multi-tenancy.

## 7. Local embedding runtime and model

**Decision:** use **Ollama v0.32.5** and
**`nomic-embed-text:v1.5`**, native **768 dimensions**, with the required
`search_document:` and `search_query:` prefixes. The published Ollama model
identifier is `0a109f422b47`, F16, 274 MB, Apache-2.0, and configured for an
8192-token context: <https://ollama.com/library/nomic-embed-text:v1.5>. The
model card confirms the 768-dimensional representation and prefix contract:
<https://huggingface.co/nomic-ai/nomic-embed-text-v1.5>.

**B5 live update, 2026-08-21:** local Ollama 0.32.5 served
`nomic-embed-text:v1.5` with full digest
`sha256:0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f`,
F16 quantization, embedding capability, and 768 dimensions. A deterministic
`search_query:` probe returned a 768-dimensional vector. Evidence is recorded
in `conformance/2026-08-21-embedding-nomic-local.json`.

The model tag alone is never sufficient production identity. A
model/dimension change creates a new embedding generation and a rebuild,
never mixed vectors in one index. Air-gapped mode permits only the configured
local runtime and has no hosted embedding fallback.

## Acceptance gate

B0 is complete when these decisions are referenced by B1, the implementation
plan and session handoff; no schema implementation precedes them. Version and
model claims above are source-backed; local embedding availability has now
passed the B5 live gate.
