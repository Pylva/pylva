// Smoke coverage for listAnomalies + getAnomalyById — verifies the
// public contract (defaults, options forwarding) without the brittle
// chain-mock that drizzle's fluent API would otherwise require.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { inspect } from 'node:util';
import {
  AnomalyRecommendationAction,
  AnomalySeverity,
  AnomalySourceType,
  AnomalyStatus,
} from '@pylva/shared';

const fakeRow = {
  id: 'a-1',
  builder_id: 'b-1',
  customer_id: 'cust-1',
  source_type: AnomalySourceType.COST_SPIKE,
  status: AnomalyStatus.OPEN,
  severity: AnomalySeverity.WARN,
  period_start: new Date('2026-04-25T00:00:00Z'),
  period_end: new Date('2026-04-26T00:00:00Z'),
  actual_value: '120',
  baseline_value: '100',
  delta_pct: '20',
  diagnosis: { insufficient_revenue_data: true },
  recommendation: { action: AnomalyRecommendationAction.INVESTIGATE_DEEP_LINK },
  created_at: new Date('2026-04-26T00:30:00Z'),
  dismissed_at: null,
};

const limitMock = vi.fn();
const orderByMock = vi.fn();
const whereMock = vi.fn();

vi.mock('../../src/lib/db/rls.js', () => ({
  withRLS: async (_b: string, cb: (tx: unknown) => Promise<unknown>) => {
    return cb({
      select: () => ({
        from: () => ({
          where: (clause: unknown) => {
            whereMock(clause);
            return {
              orderBy: (...args: unknown[]) => {
                orderByMock(...args);
                return {
                  limit: (n: number) => {
                    limitMock(n);
                    return Promise.resolve([fakeRow]);
                  },
                };
              },
              limit: (n: number) => {
                limitMock(n);
                return Promise.resolve([fakeRow]);
              },
            };
          },
        }),
      }),
    });
  },
}));

const { listAnomalies, getAnomalyById } = await import('../../src/lib/anomaly/repository.js');

describe('listAnomalies', () => {
  beforeEach(() => {
    limitMock.mockReset();
    orderByMock.mockReset();
    whereMock.mockReset();
  });

  it('applies the default open status + 50 limit + ordered by created_at desc', async () => {
    const out = await listAnomalies('b-1');
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('a-1');
    expect(out[0]!.actual_value).toBe(120);
    expect(orderByMock).toHaveBeenCalledTimes(1);
    expect(limitMock).toHaveBeenCalledWith(50);
  });

  it('honors a custom limit', async () => {
    await listAnomalies('b-1', { status: AnomalyStatus.DISMISSED, limit: 10 });
    expect(limitMock).toHaveBeenCalledWith(10);
  });

  it('returns mapped numeric values (not strings)', async () => {
    const out = await listAnomalies('b-1');
    expect(typeof out[0]!.actual_value).toBe('number');
    expect(typeof out[0]!.baseline_value).toBe('number');
    expect(typeof out[0]!.delta_pct).toBe('number');
  });

  it('customerId="X" includes builder-level rows in the WHERE clause (bug_002)', async () => {
    // The docstring promises: passing a customer string returns
    // "this customer's anomalies AND builder-level ones (customer_id
    // IS NULL)". The previous implementation only added eq(...) which
    // dropped builder-level rows for any per-customer drilldown.
    // Inspect the assembled SQL to confirm both predicates are present.
    // `util.inspect` handles drizzle's circular table refs cleanly.
    await listAnomalies('b-1', { customerId: 'cust-acme' });
    expect(whereMock).toHaveBeenCalledTimes(1);
    const clause = whereMock.mock.calls[0]![0];
    const serialized = inspect(clause, { depth: null, breakLength: Infinity });
    expect(serialized).toMatch(/cust-acme/);
    expect(serialized.toLowerCase()).toMatch(/is null/);
  });

  it('customerId=null filters to builder-level rows only', async () => {
    await listAnomalies('b-1', { customerId: null });
    const clause = whereMock.mock.calls[0]![0];
    const serialized = inspect(clause, { depth: null, breakLength: Infinity }).toLowerCase();
    expect(serialized).toMatch(/is null/);
    // The null-path must not include an `or(...)` branch (which is
    // what bug_002's fix uses for the string path). Just `isNull(...)`.
    expect(serialized).not.toMatch(/'or'/);
  });
});

describe('getAnomalyById', () => {
  it('returns the mapped row when found', async () => {
    const out = await getAnomalyById('b-1', 'a-1');
    expect(out).not.toBeNull();
    expect(out!.id).toBe('a-1');
    expect(out!.delta_pct).toBe(20);
  });
});
