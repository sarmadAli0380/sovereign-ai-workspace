export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function collectJsonValueIssues(
  value: unknown,
  path: string,
  issues: string[],
  seen = new Set<object>(),
): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) issues.push(`${path}: JSON numbers must be finite`);
    return;
  }
  if (typeof value !== "object") {
    issues.push(`${path}: must contain only JSON values`);
    return;
  }
  if (seen.has(value)) {
    issues.push(`${path}: circular references are not JSON serializable`);
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) issues.push(`${path}[${index}]: sparse arrays are not canonical JSON`);
      else collectJsonValueIssues(value[index], `${path}[${index}]`, issues, seen);
    }
    const extraKeys = Object.keys(value).filter((key) => !/^\d+$/.test(key));
    if (extraKeys.length > 0) issues.push(`${path}: arrays cannot have named fields`);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      issues.push(`${path}: must be a plain JSON object`);
      seen.delete(value);
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      collectJsonValueIssues(item, `${path}.${key}`, issues, seen);
    }
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    issues.push(`${path}: symbol-keyed fields are not JSON serializable`);
  }
  seen.delete(value);
}

export function cloneJsonValue<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
