// Regression test: getOverview must never report seeded demo events as real
// spend. cost_daily_agg_v2 mirrors the legacy aggregate and has no is_demo
// dimension, so it cannot exclude demo rows. For the default
// includeDemo:false path it MUST read cost_events directly (with
// `is_demo = 0`) for every range — including historical-only ranges that
// exclude today — exactly like every sibling dashboard query.
//
// The bug: getOverview routed any range that excluded today to
// cost_daily_agg_v2, summing demo spend as real total_spend_usd and returning
// demo_only:false (banner suppressed). Reachable via
// GET /api/v1/costs?from=..&to=<before today>.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const BUILDER_ID = 'builderA';

// A historical-only range: both endpoints are well in the past so
// rangeIncludesToday() is false regardless of when the suite runs.
const HISTORICAL_RANGE = {
  from: new Date('2020-01-01T00:00:00Z'),
  to: new Date('2020-01-07T00:00:00Z'),
};

const queryCostEventsMock = vi.fn();

vi.mock('../../src/lib/clickhouse/client.js', () => ({
  queryCostEvents: queryCostEventsMock,
}));

describe('getOverview — demo isolation on historical ranges', () => {
  let getOverview: Awaited<
    typeof import('../../src/lib/clickhouse/dashboard-queries.js')
  >['getOverview'];

  beforeEach(async () => {
    vi.resetModules();
    queryCostEventsMock.mockReset();
    // Shape satisfies the overview SELECT. hasAnyRealEvents is stubbed
    // explicitly in tests that need the demo_only branch.
    queryCostEventsMock.mockResolvedValue([
      {
        total_spend_usd: '1.23',
        event_count: '10',
        customer_count: '2',
      },
    ]);
    ({ getOverview } = await import('../../src/lib/clickhouse/dashboard-queries.js'));
  });

  it('reads cost_events with is_demo filter for historical includeDemo:false', async () => {
    await getOverview(BUILDER_ID, HISTORICAL_RANGE, { includeDemo: false });

    const sql = queryCostEventsMock.mock.calls[0]?.[1] as string;
    expect(sql).toContain('FROM cost_events');
    expect(sql).toContain('is_demo = 0');
    expect(sql).not.toContain('cost_daily_agg');
  });

  it('does not suppress the demo banner on the historical path', async () => {
    // hasAnyRealEvents returns false (no rows) → builder has only demo data.
    queryCostEventsMock.mockReset();
    queryCostEventsMock
      .mockResolvedValueOnce([{ total_spend_usd: '0', event_count: '0', customer_count: '0' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await getOverview(BUILDER_ID, HISTORICAL_RANGE, {
      includeDemo: false,
    });

    expect(result.demo_only).toBe(true);
    const rawFallbackSql = queryCostEventsMock.mock.calls[2]?.[1] as string;
    expect(rawFallbackSql).toContain('FROM cost_events');
    expect(rawFallbackSql).toContain('is_demo = 0');
  });

  it('uses a bounded existence probe for real-event detection', async () => {
    queryCostEventsMock.mockReset();
    queryCostEventsMock.mockResolvedValue([{ has_real: 1 }]);
    const { hasAnyRealEvents } = await import('../../src/lib/clickhouse/dashboard-queries.js');

    const result = await hasAnyRealEvents('builder-for-existence-probe');

    expect(result).toBe(true);
    const sql = queryCostEventsMock.mock.calls[0]?.[1] as string;
    const options = queryCostEventsMock.mock.calls[0]?.[3] as {
      queryId?: string;
      timeoutMs?: number;
    };
    expect(sql).toContain('SELECT 1 AS has_real');
    expect(sql).toContain('LIMIT 1');
    expect(sql).not.toContain('count()');
    expect(options).toMatchObject({
      queryLabel: 'dashboard.has_any_real_events',
      timeoutMs: 8_000,
    });
    // query_id is unique per execution (label prefix + UUID), never the bare
    // static label — see dashboard-query-id.test.ts for the collision regression.
    expect(options.queryId).toMatch(/^dashboard\.has_any_real_events\.[0-9a-f-]{36}$/);
  });

  it('still uses cost_daily_agg_v2 for historical includeDemo:true', async () => {
    await getOverview(BUILDER_ID, HISTORICAL_RANGE, { includeDemo: true });

    const sql = queryCostEventsMock.mock.calls[0]?.[1] as string;
    expect(sql).toContain('cost_daily_agg_v2');
  });
});
