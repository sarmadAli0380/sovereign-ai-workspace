import { randomBytes, randomUUID } from "node:crypto";
import type { SqlExecutor } from "../storage/sql.ts";
import { StorageDecodeError, requireTimestamp } from "../storage/sql.ts";
import {
  AuthenticationError,
  bearerToken,
  bearerTokenSha256,
  type ServerPrincipal,
  type ServerRole,
  type SessionAuthenticator,
  type SessionRegistry,
} from "./auth.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const CONFIG_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ROLES = new Set<ServerRole>(["member", "admin"]);

function identifier(value: unknown, path: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new TypeError(`${path} must be a bounded identifier`);
  }
  return value;
}

function uniqueStrings(
  value: readonly string[],
  path: string,
  valid: (item: string) => boolean,
): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new TypeError(`${path} must contain between 1 and 64 values`);
  }
  const result = value.map((item) => {
    if (typeof item !== "string" || !valid(item)) throw new TypeError(`${path} contains an invalid value`);
    return item;
  }).sort();
  if (new Set(result).size !== result.length) throw new TypeError(`${path} must not contain duplicates`);
  return result;
}

function textArray(
  value: unknown,
  path: string,
  valid: (item: string) => boolean,
  allowEmpty = false,
): string[] {
  if (!Array.isArray(value)) throw new StorageDecodeError(`${path} must be a PostgreSQL text array`);
  if (allowEmpty && value.length === 0) return [];
  return uniqueStrings(value as string[], path, valid);
}

export interface DurableUserAccess {
  readonly userId: string;
  readonly roles: readonly ServerRole[];
  readonly allowedConfigKeys: readonly string[];
}

export interface IssuedSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly token: string;
  readonly expiresAt: string;
}

/** PostgreSQL is the live C3 authority. The file registry is bootstrap input only. */
export class PostgresIdentityStore implements SessionAuthenticator {
  readonly #database: SqlExecutor;
  readonly #idFactory: () => string;
  readonly #tokenFactory: () => string;
  readonly #now: () => number;

  constructor(database: SqlExecutor, options: {
    idFactory?: () => string;
    tokenFactory?: () => string;
    now?: () => number;
  } = {}) {
    this.#database = database;
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
    this.#now = options.now ?? Date.now;
  }

  async bootstrap(registry: SessionRegistry): Promise<boolean> {
    const now = this.#timestamp(this.#now(), "bootstrap time");
    const payload = registry.sessions.map((session) => ({
      sessionId: session.sessionId,
      userId: session.userId,
      tokenSha256: session.tokenSha256,
      roles: [...session.roles],
      allowedConfigKeys: [...session.allowedConfigKeys],
      expiresAt: session.expiresAt,
      status: session.status,
    }));
    const result = await this.#database.query(
      `WITH bootstrap_lock AS MATERIALIZED (
         SELECT pg_advisory_xact_lock(74193021)
       ), source AS MATERIALIZED (
         SELECT input.*
         FROM bootstrap_lock,
              jsonb_to_recordset($1::jsonb) AS input(
                "sessionId" text, "userId" text, "tokenSha256" text,
                roles text[], "allowedConfigKeys" text[], "expiresAt" timestamptz,
                status text
              )
         WHERE NOT EXISTS (SELECT 1 FROM server_sessions)
       ), inserted_users AS (
         INSERT INTO users (id, external_subject, display_name, status, created_at)
         SELECT DISTINCT "userId", 'bootstrap:' || "userId", "userId", 'active',
                LEAST($2::timestamptz, "expiresAt" - interval '1 millisecond')
         FROM source
         ON CONFLICT (id) DO NOTHING
         RETURNING id
       ), inserted_roles AS (
         INSERT INTO user_roles (user_id, role, granted_by, granted_at)
         SELECT DISTINCT source."userId", role, source."userId",
                LEAST($2::timestamptz, source."expiresAt" - interval '1 millisecond')
         FROM source CROSS JOIN LATERAL unnest(source.roles) AS role
         ON CONFLICT (user_id, role) DO NOTHING
         RETURNING user_id
       ), inserted_grants AS (
         INSERT INTO user_model_grants (user_id, config_key, granted_by, granted_at)
         SELECT DISTINCT source."userId", config_key, source."userId",
                LEAST($2::timestamptz, source."expiresAt" - interval '1 millisecond')
         FROM source CROSS JOIN LATERAL unnest(source."allowedConfigKeys") AS config_key
         ON CONFLICT (user_id, config_key) DO NOTHING
         RETURNING user_id
       ), inserted_sessions AS (
         INSERT INTO server_sessions (
           id, user_id, token_sha256, status, issued_by, issued_at, expires_at,
           revoked_by, revoked_at
         )
         SELECT "sessionId", "userId", "tokenSha256", status, "userId",
                LEAST($2::timestamptz, "expiresAt" - interval '1 millisecond'),
                "expiresAt",
                CASE WHEN status = 'revoked' THEN "userId" END,
                CASE WHEN status = 'revoked'
                     THEN LEAST($2::timestamptz, "expiresAt" - interval '1 millisecond') END
         FROM source
         RETURNING id
       )
       SELECT count(*)::text AS inserted FROM inserted_sessions`,
      [JSON.stringify(payload), now],
    );
    const inserted = Number(result.rows[0]?.["inserted"] ?? 0);
    return inserted > 0;
  }

  async authenticate(authorization: string | undefined, now = Date.now()): Promise<ServerPrincipal> {
    if (!Number.isFinite(now)) throw new TypeError("authentication time must be finite");
    const digest = bearerTokenSha256(bearerToken(authorization));
    const result = await this.#database.query(
      `SELECT session.id AS session_id, session.user_id,
              array_agg(DISTINCT role.role ORDER BY role.role) AS roles,
              array_agg(DISTINCT model_grant.config_key ORDER BY model_grant.config_key) AS config_keys
       FROM server_sessions AS session
       JOIN users AS actor ON actor.id = session.user_id AND actor.status = 'active'
       JOIN user_roles AS role ON role.user_id = actor.id
       JOIN user_model_grants AS model_grant ON model_grant.user_id = actor.id
       WHERE session.token_sha256 = $1
         AND session.status = 'active'
         AND session.expires_at > $2::timestamptz
       GROUP BY session.id, session.user_id`,
      [digest, this.#timestamp(now, "authentication time")],
    );
    if (result.rows.length !== 1) throw new AuthenticationError("authentication.invalid");
    const row = result.rows[0]!;
    return Object.freeze({
      sessionId: identifier(row["session_id"], "session.id"),
      userId: identifier(row["user_id"], "session.userId"),
      roles: Object.freeze(textArray(row["roles"], "session.roles", (item) => ROLES.has(item as ServerRole)) as ServerRole[]),
      allowedConfigKeys: Object.freeze(textArray(row["config_keys"], "session.configKeys", (item) => CONFIG_KEY.test(item))),
    });
  }

  async getUserAccess(actor: ServerPrincipal, userId: string): Promise<DurableUserAccess | undefined> {
    this.#requireAdmin(actor);
    const result = await this.#database.query(
      `SELECT target.id AS user_id,
              COALESCE(array_agg(DISTINCT role.role ORDER BY role.role)
                FILTER (WHERE role.role IS NOT NULL), '{}') AS roles,
              COALESCE(array_agg(DISTINCT model_grant.config_key ORDER BY model_grant.config_key)
                FILTER (WHERE model_grant.config_key IS NOT NULL), '{}') AS config_keys
       FROM users AS target
       LEFT JOIN user_roles AS role ON role.user_id = target.id
       LEFT JOIN user_model_grants AS model_grant ON model_grant.user_id = target.id
       WHERE target.id = $1 AND target.status = 'active'
       GROUP BY target.id`,
      [identifier(userId, "userId")],
    );
    if (result.rows.length === 0) return undefined;
    const row = result.rows[0]!;
    return Object.freeze({
      userId: identifier(row["user_id"], "access.userId"),
      roles: Object.freeze(textArray(row["roles"], "access.roles", (item) => ROLES.has(item as ServerRole), true) as ServerRole[]),
      allowedConfigKeys: Object.freeze(textArray(row["config_keys"], "access.configKeys", (item) => CONFIG_KEY.test(item), true)),
    });
  }

  async setUserAccess(actor: ServerPrincipal, input: {
    userId: string;
    roles: readonly ServerRole[];
    allowedConfigKeys: readonly string[];
  }): Promise<DurableUserAccess> {
    this.#requireAdmin(actor);
    const userId = identifier(input.userId, "userId");
    const roles = uniqueStrings(input.roles, "roles", (item) => ROLES.has(item as ServerRole)) as ServerRole[];
    const grants = uniqueStrings(input.allowedConfigKeys, "allowedConfigKeys", (item) => CONFIG_KEY.test(item));
    const at = this.#timestamp(this.#now(), "access update time");
    const result = await this.#database.query(
      `WITH administration_lock AS MATERIALIZED (
         SELECT pg_advisory_xact_lock(74193022)
       ), authorized AS MATERIALIZED (
         SELECT target.id
         FROM administration_lock, users AS target
         WHERE target.id = $1 AND target.status = 'active'
           AND EXISTS (
             SELECT 1 FROM users AS admin
             JOIN user_roles AS role ON role.user_id = admin.id AND role.role = 'admin'
             WHERE admin.id = $2 AND admin.status = 'active'
           )
           AND (
             $1 <> $2 OR 'admin' = ANY($3::text[]) OR EXISTS (
               SELECT 1 FROM users AS other_admin
               JOIN user_roles AS other_role
                 ON other_role.user_id = other_admin.id AND other_role.role = 'admin'
               WHERE other_admin.id <> $1 AND other_admin.status = 'active'
             )
           )
       ), inserted_roles AS (
         INSERT INTO user_roles (user_id, role, granted_by, granted_at)
         SELECT authorized.id, role, $2, $5::timestamptz
         FROM authorized CROSS JOIN unnest($3::text[]) AS role
         ON CONFLICT (user_id, role) DO UPDATE
           SET granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at
         RETURNING role
       ), inserted_grants AS (
         INSERT INTO user_model_grants (user_id, config_key, granted_by, granted_at)
         SELECT authorized.id, config_key, $2, $5::timestamptz
         FROM authorized CROSS JOIN unnest($4::text[]) AS config_key
         ON CONFLICT (user_id, config_key) DO UPDATE
           SET granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at
         RETURNING config_key
       ), removed_roles AS (
         DELETE FROM user_roles
         WHERE user_id IN (SELECT id FROM authorized) AND NOT (role = ANY($3::text[]))
       ), removed_grants AS (
         DELETE FROM user_model_grants
         WHERE user_id IN (SELECT id FROM authorized) AND NOT (config_key = ANY($4::text[]))
       )
       SELECT id AS user_id, $3::text[] AS roles, $4::text[] AS config_keys
       FROM authorized`,
      [userId, actor.userId, roles, grants, at],
    );
    if (result.rows.length !== 1) throw new Error("identity.access-update-denied");
    return Object.freeze({ userId, roles: Object.freeze(roles), allowedConfigKeys: Object.freeze(grants) });
  }

  async issueSession(actor: ServerPrincipal, input: { userId: string; expiresAt: string }): Promise<IssuedSession> {
    this.#requireAdmin(actor);
    const userId = identifier(input.userId, "userId");
    const nowMs = this.#now();
    const issuedAt = this.#timestamp(nowMs, "session issue time");
    const expiresAt = requireTimestamp(input.expiresAt, "session.expiresAt");
    const expiresMs = Date.parse(expiresAt);
    if (expiresMs <= nowMs || expiresMs > nowMs + 31_536_000_000) {
      throw new TypeError("session.expiresAt must be in the future and no more than one year away");
    }
    const sessionId = identifier(this.#idFactory(), "session.id");
    const token = this.#tokenFactory();
    const tokenSha256 = bearerTokenSha256(token);
    const result = await this.#database.query(
      `INSERT INTO server_sessions (
         id, user_id, token_sha256, status, issued_by, issued_at, expires_at
       )
       SELECT $1, target.id, $3, 'active', $4, $5::timestamptz, $6::timestamptz
       FROM users AS target
       WHERE target.id = $2 AND target.status = 'active'
         AND EXISTS (SELECT 1 FROM user_roles WHERE user_id = target.id)
         AND EXISTS (SELECT 1 FROM user_model_grants WHERE user_id = target.id)
         AND EXISTS (
           SELECT 1 FROM users AS admin
           JOIN user_roles AS role ON role.user_id = admin.id AND role.role = 'admin'
           WHERE admin.id = $4 AND admin.status = 'active'
         )
       RETURNING id`,
      [sessionId, userId, tokenSha256, actor.userId, issuedAt, expiresAt],
    );
    if (result.rows.length !== 1) throw new Error("identity.session-issue-denied");
    return Object.freeze({ sessionId, userId, token, expiresAt });
  }

  async revokeSession(actor: ServerPrincipal, sessionId: string): Promise<boolean> {
    this.#requireAdmin(actor);
    const at = this.#timestamp(this.#now(), "session revocation time");
    const result = await this.#database.query(
      `UPDATE server_sessions AS session
       SET status = 'revoked', revoked_by = $2, revoked_at = $3::timestamptz
       WHERE session.id = $1 AND session.status = 'active'
         AND EXISTS (
           SELECT 1 FROM users AS admin
           JOIN user_roles AS role ON role.user_id = admin.id AND role.role = 'admin'
           WHERE admin.id = $2 AND admin.status = 'active'
         )
       RETURNING id`,
      [identifier(sessionId, "sessionId"), actor.userId, at],
    );
    if (result.rows.length === 1) return true;
    const existing = await this.#database.query(
      `SELECT 1 FROM server_sessions WHERE id = $1 AND status = 'revoked'`,
      [sessionId],
    );
    return existing.rows.length === 1;
  }

  #requireAdmin(actor: ServerPrincipal): void {
    if (!actor.roles.includes("admin")) throw new Error("identity.administration-denied");
    identifier(actor.userId, "actor.userId");
    identifier(actor.sessionId, "actor.sessionId");
  }

  #timestamp(value: number, path: string): string {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must be finite`);
    return new Date(value).toISOString();
  }
}
