// Shared ClickHouse DateTime formatter. ClickHouse expects the
// "YYYY-MM-DD HH:MM:SS" shape; JS `toISOString()` gives "YYYY-MM-DDTHH:MM:SS.sssZ".
// Extracted to kill the copy-pasted `iso(d)` / `isoCh(d)` / `chSeconds(d)`
// helpers that had accumulated across dashboard-queries, the post-call
// evaluator, the ingest route, the sync handler, and the CSV export.
//
// Lesson B1-L10 style: one helper, one shape. Callers import `chTimestamp`.

export function chTimestamp(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

// Inverse of `chTimestamp`. ClickHouse returns DateTime as
// `YYYY-MM-DD HH:MM:SS` in UTC; this rehydrates it to a JS Date and
// returns null for unparseable inputs (callers treat null as "no
// timestamp" rather than crashing the cron).
export function parseChTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value.replace(' ', 'T') + 'Z');
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
