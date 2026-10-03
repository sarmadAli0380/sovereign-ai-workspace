/**
 * Clone a data graph while preserving symbol-keyed TypeBox metadata.
 * structuredClone() and JSON cloning both drop those schema symbols.
 */
export function cloneData<T>(value: T, seen = new Map<object, unknown>()): T {
  if (typeof value !== "object" || value === null) return value;

  const existing = seen.get(value);
  if (existing !== undefined) return existing as T;

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(cloneData(item, seen));
    return copy as T;
  }

  const copy = Object.create(Object.getPrototypeOf(value)) as object;
  seen.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if ("value" in descriptor) descriptor.value = cloneData(descriptor.value, seen);
    Object.defineProperty(copy, key, descriptor);
  }
  return copy as T;
}
