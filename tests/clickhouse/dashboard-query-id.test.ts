// Regression: dashboard read queries must send a UNIQUE ClickHouse query_id
// per execution. Each query carried a static query_id (e.g. `dashboard.overview`).
// ClickHouse rejects a second query that reuses a query_id already in flight
// with QUERY_WITH_SAME_ID_IS_ALREADY_RUNNING (code 216) — replace_running_query
// defaults to 0 and is set nowhere. So whenever the same logical query ran
// concurrently (two builders loading dashboards at once, the dashboard RSC
// render racing the /api/v1/costs poll, or the 30s SSE feed-stream refresh
// overlapping across connected streams) the second query failed, surfacing as
// a 503 on the hot path — and getting worse with concurrency.
//
// Fix: query_id is now `dashboard.<label>.<uuid>` (greppable prefix + unique
// suffix); queryLabel stays the stable label for our structured logs.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const BUILDER_ID = 'builderA';
const RANGE = {
  from: new Date('2020-01-01T00:00:00Z'),
  to: new Date('2020-01-07T00:00:00Z'),
};

const queryCostEventsMock = vi.fn();

vi.mock('../../src/lib/clickhouse/client.js', () => ({
  queryCostEvents: queryCostEventsMock,
}));

type CapturedOptions = { queryId?: string; queryLabel?: string };

function capturedOptions(): CapturedOptions[] {
  return queryCostEventsMock.mock.calls.map((call) => (call[3] ?? {}) as CapturedOptions);
}

describe('dashboard query_id uniqueness', () => {
  let queries: typeof import('../../src/lib/clickhouse/dashboard-queries.js');

  beforeEach(async () => {
    vi.resetModules();
    queryCostEventsMock.mockReset();
    queryCostEventsMock.mockResolvedValue([
      { total_spend_usd: '1.23', event_count: '10', customer_count: '2' },
    ]);
    queries = await import('../../src/lib/clickhouse/dashboard-queries.js');
  });

  it('never sends a bare static query_id (would collide across concurrent callers)', async () => {
    await queries.getOverview(BUILDER_ID, RANGE, { includeDemo: false, hasRealEvents: true });

    for (const opts of capturedOptions()) {
      // The bug shipped exactly these bare labels — assert they never appear as
      // the full query_id again.
      expect(opts.queryId).not.toBe('dashboard.overview');
      expect(opts.queryId).not.toBe(opts.queryLabel);
      expect(opts.queryId).toMatch(/^dashboard\.[a-z_]+\.[0-9a-f-]{36}$/);
      // The stable label is still present for our own logs.
      expect(opts.queryLabel).toMatch(/^dashboard\.[a-z_]+$/);
    }
  });

  it('emits a distinct query_id on every execution of the same query', async () => {
    await queries.getOverview(BUILDER_ID, RANGE, { includeDemo: false, hasRealEvents: true });
    await queries.getOverview(BUILDER_ID, RANGE, { includeDemo: false, hasRealEvents: true });

    const overviewIds = capturedOptions()
      .filter((o) => o.queryLabel === 'dashboard.overview')
      .map((o) => o.queryId);

    expect(overviewIds).toHaveLength(2);
    expect(new Set(overviewIds).size).toBe(2); // two runs → two distinct ids
  });

  it('keeps query_id unique across different query types in one request', async () => {
    queryCostEventsMock.mockResolvedValue([]);
    await queries.getCustomerDetail(BUILDER_ID, 'cust-1', RANGE, { includeDemo: false });

    const ids = capturedOptions().map((o) => o.queryId);
    expect(ids.length).toBeGreaterThanOrEqual(4);
    expect(new Set(ids).size).toBe(ids.length); // all distinct
  });
});
