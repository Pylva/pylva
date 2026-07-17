// audit_log partition runway management.
//
// `audit_log` is declared `PARTITION BY RANGE (timestamp)` (migration 001).
// A partitioned table can only accept a row if a partition covers its
// timestamp — an INSERT with no matching partition fails with
// `no partition of relation "audit_log" found for row` (SQLSTATE 23514).
// Because audit entries are written inside the same RLS transaction as the
// business write (see src/lib/auth/audit-log.ts), that failure rolls back
// the whole operation: every state-changing API call would 500 the moment
// the pre-created partitions run out.
//
// Migrations 001 + 032 only created a FINITE, hardcoded runway. The written
// spec says partitions are "managed by pg_partman", but pg_partman/pg_cron
// were never installed. This module is the partition manager the rest of the
// system assumes exists: the ensure-audit-partitions cron calls it on a
// schedule to keep a rolling window of monthly partitions ahead of NOW().

// Default look-ahead: keep the current month plus this many future months.
// 12 mirrors the migration-032 seed loop (0..12 = 13 partitions) and gives a
// full year of runway, so even a long cron outage cannot exhaust it.
export const AUDIT_PARTITION_MONTHS_AHEAD = 12;

export interface AuditPartitionSpec {
  /** Partition table name, e.g. `audit_log_y2026m07`. */
  name: string;
  /** Logical lower-bound month, `YYYY-MM-DD` (first day, selected in UTC). */
  from: string;
  /** Logical upper-bound month, `YYYY-MM-DD` (first day of the next month). */
  to: string;
}

// Validated-by-construction shapes. The ensure-audit-partitions cron passes the
// lower-bound date to a bounded database function, which independently derives
// the identifier and upper bound. Re-checking the complete semantic spec here
// is defense in depth against a future caller feeding inconsistent values into
// the route.
const PARTITION_NAME_RE = /^audit_log_y\d{4}m\d{2}$/;
const PARTITION_DATE_RE = /^\d{4}-\d{2}-01$/;

export function isValidPartitionSpec(spec: AuditPartitionSpec): boolean {
  if (
    !PARTITION_NAME_RE.test(spec.name) ||
    !PARTITION_DATE_RE.test(spec.from) ||
    !PARTITION_DATE_RE.test(spec.to)
  ) {
    return false;
  }

  const [fromYearText, fromMonthText] = spec.from.split('-');
  const fromYear = Number(fromYearText);
  const fromMonth = Number(fromMonthText);
  if (
    !Number.isInteger(fromYear) ||
    !Number.isInteger(fromMonth) ||
    fromMonth < 1 ||
    fromMonth > 12
  ) {
    return false;
  }

  const normalizedFrom = isoDate(fromYear, fromMonth - 1);
  const expectedTo = isoDate(fromYear, fromMonth);
  return (
    spec.from === normalizedFrom &&
    spec.to === expectedTo &&
    spec.name === `audit_log_y${fromYearText}m${fromMonthText}`
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function isoDate(year: number, monthIndex0: number): string {
  // monthIndex0 may overflow 11; Date normalizes it into the next year.
  const d = new Date(Date.UTC(year, monthIndex0, 1));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-01`;
}

/**
 * Monthly partition specs covering the UTC month containing `now` plus the
 * next `monthsAhead` months. Pure and deterministic — the cron route supplies
 * each lower bound to the bounded partition function. PostgreSQL interprets
 * those DATE boundaries in the historical migration calendar zone captured by
 * migration 054, which keeps old and new partitions contiguous.
 *
 * The naming and bounds match migration 001/032 exactly (`audit_log_yYYYYmMM`,
 * `[first-of-month, first-of-next-month)`) so the manager never collides with,
 * or leaves gaps against, the migration-seeded partitions, and the purge cron's
 * `audit_log_y(\d{4})m(\d{2})` regex keeps matching.
 */
export function auditLogPartitionSpecs(
  now: Date,
  monthsAhead: number = AUDIT_PARTITION_MONTHS_AHEAD,
): AuditPartitionSpec[] {
  const baseYear = now.getUTCFullYear();
  const baseMonth0 = now.getUTCMonth();
  const specs: AuditPartitionSpec[] = [];
  for (let i = 0; i <= monthsAhead; i++) {
    const from = isoDate(baseYear, baseMonth0 + i);
    const to = isoDate(baseYear, baseMonth0 + i + 1);
    const [y, m] = from.split('-');
    specs.push({ name: `audit_log_y${y}m${m}`, from, to });
  }
  return specs;
}
