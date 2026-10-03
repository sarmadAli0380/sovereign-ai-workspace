import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";

export const SESSION_REGISTRY_SCHEMA_VERSION = 1 as const;

export type ServerRole = "member" | "admin";
export type ServerPermission =
  | "conversation.run"
  | "conversation.read"
  | "attachment.read"
  | "run.read"
  | "run.events"
  | "approval.list"
  | "approval.resolve"
  | "audit.read"
  | "identity.admin";

export interface ServerPrincipal {
  readonly sessionId: string;
  readonly userId: string;
  readonly roles: readonly ServerRole[];
  readonly allowedConfigKeys: readonly string[];
}

export interface SessionRegistryEntry extends ServerPrincipal {
  readonly tokenSha256: string;
  readonly expiresAt: string;
  readonly status: "active" | "revoked";
}

export interface SessionRegistry {
  readonly schemaVersion: typeof SESSION_REGISTRY_SCHEMA_VERSION;
  readonly sessions: readonly SessionRegistryEntry[];
}

export class AuthenticationError extends Error {
  readonly code: "authentication.required" | "authentication.invalid";

  constructor(code: AuthenticationError["code"]) {
    super(code);
    this.name = "AuthenticationError";
    this.code = code;
  }
}

export interface SessionAuthenticator {
  authenticate(authorization: string | undefined, now?: number): Promise<ServerPrincipal>;
}

const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const CONFIG_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ROLES = new Set<ServerRole>(["member", "admin"]);

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new TypeError(`${path} has unknown fields: ${unknown.join(", ")}`);
}

function identifier(value: unknown, path: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new TypeError(`${path} must be a bounded non-empty identifier`);
  }
  return value;
}

function stringArray(value: unknown, path: string, validate: (item: string) => boolean): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new TypeError(`${path} must be a non-empty array with at most 64 entries`);
  }
  const parsed = value.map((item, index) => {
    if (typeof item !== "string" || !validate(item)) throw new TypeError(`${path}[${index}] is invalid`);
    return item;
  });
  if (new Set(parsed).size !== parsed.length) throw new TypeError(`${path} must not contain duplicates`);
  return parsed;
}

export function parseSessionRegistry(value: unknown): SessionRegistry {
  if (!object(value)) throw new TypeError("session registry must be an object");
  exactKeys(value, ["schemaVersion", "sessions"], "session registry");
  if (value["schemaVersion"] !== SESSION_REGISTRY_SCHEMA_VERSION) {
    throw new TypeError("session registry schemaVersion is unsupported");
  }
  if (!Array.isArray(value["sessions"]) || value["sessions"].length === 0) {
    throw new TypeError("session registry must contain at least one session");
  }
  if (value["sessions"].length > 10_000) throw new TypeError("session registry is too large");

  const sessions = value["sessions"].map((candidate, index): SessionRegistryEntry => {
    const path = `sessions[${index}]`;
    if (!object(candidate)) throw new TypeError(`${path} must be an object`);
    exactKeys(candidate, [
      "sessionId", "userId", "tokenSha256", "roles", "allowedConfigKeys", "expiresAt", "status",
    ], path);
    const tokenSha256 = candidate["tokenSha256"];
    if (typeof tokenSha256 !== "string" || !SHA256.test(tokenSha256)) {
      throw new TypeError(`${path}.tokenSha256 must be lowercase SHA-256 hex`);
    }
    const roles = stringArray(candidate["roles"], `${path}.roles`, (role) => ROLES.has(role as ServerRole)) as ServerRole[];
    const allowedConfigKeys = stringArray(
      candidate["allowedConfigKeys"],
      `${path}.allowedConfigKeys`,
      (key) => CONFIG_KEY.test(key),
    );
    const expiresAt = candidate["expiresAt"];
    if (typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt))) {
      throw new TypeError(`${path}.expiresAt must be an ISO timestamp`);
    }
    if (candidate["status"] !== "active" && candidate["status"] !== "revoked") {
      throw new TypeError(`${path}.status must be active or revoked`);
    }
    return Object.freeze({
      sessionId: identifier(candidate["sessionId"], `${path}.sessionId`),
      userId: identifier(candidate["userId"], `${path}.userId`),
      tokenSha256,
      roles: Object.freeze(roles),
      allowedConfigKeys: Object.freeze(allowedConfigKeys),
      expiresAt,
      status: candidate["status"],
    });
  });
  const sessionIds = sessions.map((session) => session.sessionId);
  const tokenHashes = sessions.map((session) => session.tokenSha256);
  if (new Set(sessionIds).size !== sessionIds.length) throw new TypeError("session ids must be unique");
  if (new Set(tokenHashes).size !== tokenHashes.length) throw new TypeError("session token hashes must be unique");
  return Object.freeze({ schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION, sessions: Object.freeze(sessions) });
}

export function bearerToken(authorization: string | undefined): string {
  if (authorization === undefined) throw new AuthenticationError("authentication.required");
  const match = /^Bearer ([A-Za-z0-9._~-]{32,4096})$/.exec(authorization);
  if (!match) throw new AuthenticationError("authentication.invalid");
  return match[1]!;
}

export function bearerTokenSha256(token: string): string {
  if (typeof token !== "string" || !/^[A-Za-z0-9._~-]{32,4096}$/.test(token)) {
    throw new AuthenticationError("authentication.invalid");
  }
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class RegistrySessionAuthenticator implements SessionAuthenticator {
  readonly #registry: () => Promise<SessionRegistry>;

  constructor(registry: SessionRegistry | (() => Promise<SessionRegistry>)) {
    this.#registry = typeof registry === "function" ? registry : async () => registry;
  }

  async authenticate(authorization: string | undefined, now = Date.now()): Promise<ServerPrincipal> {
    if (!Number.isFinite(now)) throw new TypeError("authentication time must be finite");
    const token = bearerToken(authorization);
    const tokenSha256 = bearerTokenSha256(token);
    const registry = await this.#registry();
    const session = registry.sessions.find((candidate) => candidate.tokenSha256 === tokenSha256);
    if (!session || session.status !== "active" || Date.parse(session.expiresAt) <= now) {
      throw new AuthenticationError("authentication.invalid");
    }
    return Object.freeze({
      sessionId: session.sessionId,
      userId: session.userId,
      roles: Object.freeze([...session.roles]),
      allowedConfigKeys: Object.freeze([...session.allowedConfigKeys]),
    });
  }
}

async function readRegularFile(path: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new TypeError("session registry must be a regular non-symbolic file");
  }
  return readFile(path, "utf8");
}

export async function readSessionRegistryFile(path: string): Promise<SessionRegistry> {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new TypeError("session registry path must be absolute");
  }
  const raw = await readRegularFile(path);
  if (Buffer.byteLength(raw, "utf8") > 1_048_576) throw new TypeError("session registry file is too large");
  return parseSessionRegistry(JSON.parse(raw));
}

/** Reloads on every request so an atomic file replacement rotates/revokes sessions without a restart. */
export class FileSessionAuthenticator extends RegistrySessionAuthenticator {
  constructor(path: string) {
    if (typeof path !== "string" || !path.startsWith("/")) {
      throw new TypeError("session registry path must be absolute");
    }
    super(() => readSessionRegistryFile(path));
  }
}

const ROLE_PERMISSIONS: Readonly<Record<ServerRole, ReadonlySet<ServerPermission>>> = Object.freeze({
  member: new Set<ServerPermission>([
    "conversation.run", "conversation.read", "attachment.read", "run.read",
    "run.events", "approval.list", "approval.resolve",
  ]),
  admin: new Set<ServerPermission>([
    "conversation.run", "conversation.read", "attachment.read", "run.read",
    "run.events", "approval.list", "approval.resolve", "audit.read", "identity.admin",
  ]),
});

export function hasPermission(principal: ServerPrincipal, permission: ServerPermission): boolean {
  return principal.roles.some((role) => ROLE_PERMISSIONS[role]?.has(permission) === true);
}
