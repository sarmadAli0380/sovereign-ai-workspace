import { cloneJsonValue, collectJsonValueIssues, type JsonValue } from "../json.ts";

export interface SqlQueryResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount?: number | null;
}

/**
 * Deliberately smaller than a driver API. A server can adapt a pg PoolClient,
 * a test transaction, or another PostgreSQL transport without exposing query
 * builders to the storage layer.
 */
export interface SqlExecutor {
  query(sql: string, values?: readonly unknown[]): Promise<SqlQueryResult>;
}

export class StorageDecodeError extends TypeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageDecodeError";
  }
}

export function requireNonEmpty(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value;
}

export function requireWholeNumber(value: unknown, path: string): number {
  const parsed = typeof value === "string" && /^\d+$/.test(value)
    ? Number(value)
    : value;
  if (
    typeof parsed !== "number" ||
    !Number.isSafeInteger(parsed) ||
    parsed < 0
  ) {
    throw new StorageDecodeError(`${path} must be a non-negative safe integer`);
  }
  return parsed;
}

export function requireTimestamp(value: unknown, path: string): string {
  const serialized = value instanceof Date ? value.toISOString() : value;
  if (
    typeof serialized !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T/.test(serialized) ||
    Number.isNaN(Date.parse(serialized))
  ) {
    throw new StorageDecodeError(`${path} must be a timestamp`);
  }
  return new Date(serialized).toISOString();
}

export function jsonParameter(value: unknown): string {
  const issues: string[] = [];
  collectJsonValueIssues(value, "value", issues);
  if (issues.length > 0) throw new TypeError(issues[0]!);
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("value must be JSON serializable");
  return serialized;
}

export function parseJsonColumn(value: unknown, path: string): JsonValue {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (cause) {
      throw new StorageDecodeError(`${path} contains malformed JSON`, { cause });
    }
  }
  const issues: string[] = [];
  collectJsonValueIssues(parsed, path, issues);
  if (issues.length > 0) throw new StorageDecodeError(issues[0]!);
  return cloneJsonValue(parsed as JsonValue);
}

export function oneRow(result: SqlQueryResult, operation: string): Record<string, unknown> {
  if (result.rows.length !== 1) {
    throw new StorageDecodeError(
      `${operation} expected exactly one row, received ${result.rows.length}`,
    );
  }
  return result.rows[0]!;
}

export function isoParameter(value: string, path: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${path} must be an RFC 3339 timestamp`);
  }
  return new Date(value).toISOString();
}
