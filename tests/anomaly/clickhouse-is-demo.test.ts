// Regression: the anomaly cron's cost_events reads omitted the `is_demo = 0`
// filter that previewRule, aggregateSpendForRule (PR #229), and every
// dashboard query apply. Seeded demo rows (is_demo=1, never purged) therefore
// fed the cost_spike / cost_drop baselines and the builder-discovery /
// cold-start sweep. As static demo rows age out of the trailing-24h window but
// stay in the 30-day baseline, currentCost collapses to ~0 while the baseline
// stays inflated → a FALSE cost_drop fires, and real spikes get masked by the
// demo-padded baseline. Anomaly detection must act on REAL traffic only.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const queryMock = vi.fn();

vi.mock('../../src/lib/clickhouse/client.js', () => ({
  queryCostEvents: queryMock,
}));

vi.mock('../../src/lib/clickhouse/datetime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/clickhouse/datetime.js')>();
  return { ...actual, chTimestamp: (d: Date) => d.toISOString() };
});

const {
  fetchPeriodAggregates,
  listBuildersWithEvents,
  fetchSourceLastSeen,
  fetchDeployValidationSignal,
} = await import('../../src/lib/anomaly/clickhouse-queries.js');

const NOW = new Date('2026-06-15T12:00:00Z');

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue([]);
});

function allSql(): string[] {
  return queryMock.mock.calls.map((c) => c[1] as string);
}

describe('anomaly clickhouse-queries — exclude demo events', () => {
  it('filters is_demo = 0 in all four fetchPeriodAggregates reads', async () => {
    await fetchPeriodAggregates('b1', NOW.toISOString(), NOW.toISOString());

    const sqls = allSql();
    expect(sqls).toHaveLength(4);
    for (const sql of sqls) {
      expect(sql).toContain('is_demo = 0');
      // The demo predicate must not crowd out the mandatory tenant pin (R7).
      expect(sql).toContain('builder_id = {builder_id:String}');
    }
  });

  it('filters is_demo = 0 in the builder-discovery / cold-start sweep', async () => {
    await listBuildersWithEvents(NOW);
    const sql = allSql()[0]!;
    expect(sql).toContain('is_demo = 0');
  });

  it('filters is_demo = 0 in the source-silence read', async () => {
    await fetchSourceLastSeen('b1', NOW);
    const sql = allSql()[0]!;
    expect(sql).toContain('is_demo = 0');
    expect(sql).toContain('builder_id = {builder_id:String}');
  });

  it('filters is_demo = 0 in the deploy-validation-signal read', async () => {
    await fetchDeployValidationSignal('b1', NOW);
    const sql = allSql()[0]!;
    expect(sql).toContain('is_demo = 0');
    expect(sql).toContain('builder_id = {builder_id:String}');
  });
});
