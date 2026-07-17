import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clickhouseQuery: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
  postSlackAlert: vi.fn(),
}));

vi.mock('../../src/lib/clickhouse/client.js', () => ({
  clickhouse: { query: mocks.clickhouseQuery },
}));

vi.mock('../../src/lib/alerts/slack.js', () => ({
  postSlackAlert: mocks.postSlackAlert,
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({ error: mocks.logError, info: mocks.logInfo }),
  },
}));

const { runReconcile } = await import('../../src/lib/pricing/reconcile.js');

function result(total: string) {
  return { json: vi.fn().mockResolvedValue([{ total }]) };
}

describe('authoritative pricing reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('binds the complete day window and compares the canonical view with both projections', async () => {
    mocks.clickhouseQuery
      .mockResolvedValueOnce(result('12.5'))
      .mockResolvedValueOnce(result('12.5'));

    await expect(runReconcile('2026-07-13')).resolves.toEqual({
      day: '2026-07-13',
      events_total: 12.5,
      mv_total: 12.5,
      delta: 0,
      drift_pct: 0,
      alert_fired: false,
    });

    expect(mocks.clickhouseQuery).toHaveBeenCalledTimes(2);
    for (const [request] of mocks.clickhouseQuery.mock.calls) {
      expect(request.query_params).toEqual({
        day_start: '2026-07-13T00:00:00.000Z',
        next_day_start: '2026-07-14T00:00:00.000Z',
      });
      expect(request.query).toContain("parseDateTime64BestEffort({day_start:String}, 3, 'UTC')");
      expect(request.query).toContain(
        "parseDateTime64BestEffort({next_day_start:String}, 3, 'UTC')",
      );
      expect(request.query).not.toContain('::Date');
    }

    const canonicalQuery = mocks.clickhouseQuery.mock.calls[0]?.[0].query as string;
    const projectedQuery = mocks.clickhouseQuery.mock.calls[1]?.[0].query as string;
    expect(canonicalQuery).toContain('FROM cost_events_with_control');
    expect(projectedQuery).toContain('FROM cost_daily_agg_v2');
    expect(projectedQuery).toContain('FROM budget_cost_events_final');
    expect(projectedQuery).toContain('WHERE payload_hash_count = 1');
    expect(mocks.postSlackAlert).not.toHaveBeenCalled();
  });

  it.each(['2026-02-30', '2026-7-1', 'not-a-day'])(
    'rejects malformed UTC day %s before querying ClickHouse',
    async (day) => {
      await expect(runReconcile(day)).rejects.toBeInstanceOf(TypeError);
      expect(mocks.clickhouseQuery).not.toHaveBeenCalled();
    },
  );
});
