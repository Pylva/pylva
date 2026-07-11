// Unit tests for the audit_log partition-runway generator.
//
// Regression guard for the partition time-bomb: audit_log is RANGE-partitioned
// and nothing was creating future partitions, so INSERTs (and therefore every
// state-changing API call, since audit writes share the business RLS txn) would
// 500 once the migration-seeded runway ran out. These tests pin the contract
// the ensure-audit-partitions cron + migration 040 rely on: a contiguous,
// gap-free, year-long rolling window whose names/bounds match migrations
// 001/032 exactly.

import { describe, it, expect } from 'vitest';
import {
  AUDIT_PARTITION_MONTHS_AHEAD,
  auditLogPartitionSpecs,
  isValidPartitionSpec,
} from '../../src/lib/db/audit-partitions.js';

describe('auditLogPartitionSpecs', () => {
  it('covers the current month plus a full year of runway', () => {
    const specs = auditLogPartitionSpecs(new Date('2026-06-09T12:00:00Z'));
    expect(specs).toHaveLength(AUDIT_PARTITION_MONTHS_AHEAD + 1);
    // First partition is the month containing `now`...
    expect(specs[0]).toEqual({
      name: 'audit_log_y2026m06',
      from: '2026-06-01',
      to: '2026-07-01',
    });
    // ...and crucially the very next month (where 001's runway ends) exists.
    expect(specs[1]).toEqual({
      name: 'audit_log_y2026m07',
      from: '2026-07-01',
      to: '2026-08-01',
    });
  });

  it('names and bounds match the migration convention (audit_log_yYYYYmMM, [1st, 1st-of-next))', () => {
    for (const spec of auditLogPartitionSpecs(new Date('2026-06-09T00:00:00Z'))) {
      expect(spec.name).toMatch(/^audit_log_y\d{4}m\d{2}$/);
      // Must satisfy the purge cron's regex too, or expired partitions never drop.
      expect(spec.name).toMatch(/audit_log_y(\d{4})m(\d{2})/);
      expect(spec.from).toMatch(/^\d{4}-\d{2}-01$/);
      expect(spec.to).toMatch(/^\d{4}-\d{2}-01$/);
    }
  });

  it('produces a contiguous, gap-free window (each upper bound is the next lower bound)', () => {
    const specs = auditLogPartitionSpecs(new Date('2026-11-15T00:00:00Z'));
    for (let i = 1; i < specs.length; i++) {
      expect(specs[i]!.from).toBe(specs[i - 1]!.to);
    }
  });

  it('rolls correctly across a year boundary', () => {
    const specs = auditLogPartitionSpecs(new Date('2026-12-20T00:00:00Z'), 2);
    expect(specs.map((s) => s.name)).toEqual([
      'audit_log_y2026m12',
      'audit_log_y2027m01',
      'audit_log_y2027m02',
    ]);
    expect(specs[0]).toEqual({
      name: 'audit_log_y2026m12',
      from: '2026-12-01',
      to: '2027-01-01',
    });
  });

  it('is deterministic regardless of day-of-month or time-of-day', () => {
    const first = auditLogPartitionSpecs(new Date('2026-06-01T00:00:00Z'));
    const last = auditLogPartitionSpecs(new Date('2026-06-30T23:59:59Z'));
    expect(first).toEqual(last);
  });
});

describe('isValidPartitionSpec', () => {
  it("accepts every spec the generator produces (the cron's interpolation guard)", () => {
    for (const spec of auditLogPartitionSpecs(new Date('2026-06-09T00:00:00Z'))) {
      expect(isValidPartitionSpec(spec)).toBe(true);
    }
  });

  it('rejects SQL-injection / malformed shapes so they never reach sql.raw', () => {
    expect(
      isValidPartitionSpec({
        name: 'audit_log_y2026m07',
        from: '2026-07-01',
        to: '2026-08-01',
      }),
    ).toBe(true);
    // Injection attempt in the identifier.
    expect(
      isValidPartitionSpec({
        name: 'audit_log_y2026m07"; DROP TABLE audit_log;--',
        from: '2026-07-01',
        to: '2026-08-01',
      }),
    ).toBe(false);
    // Wrong table prefix.
    expect(
      isValidPartitionSpec({
        name: 'users_y2026m07',
        from: '2026-07-01',
        to: '2026-08-01',
      }),
    ).toBe(false);
    // Non-first-of-month / injected bound.
    expect(
      isValidPartitionSpec({
        name: 'audit_log_y2026m07',
        from: '2026-07-15',
        to: '2026-08-01',
      }),
    ).toBe(false);
    expect(
      isValidPartitionSpec({
        name: 'audit_log_y2026m07',
        from: '2026-07-01',
        to: "2026-08-01'); DROP",
      }),
    ).toBe(false);
  });
});
