// Drizzle's tx.execute() returns an array of rows on some adapter versions and
// a `{ rows: T[] }` wrapper on others. Normalize so callers don't care.

export function unwrapRows<T = unknown>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const wrapped = result as { rows?: T[] } | undefined;
  return wrapped?.rows ?? [];
}
