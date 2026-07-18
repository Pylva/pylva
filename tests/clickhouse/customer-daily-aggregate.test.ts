import { beforeEach, describe, expect, it, vi } from 'vitest';

const BUILDER_ID = 'builderA';
const EXTERNAL_ID = 'alice';
const COMPOSITE_ID = `${BUILDER_ID}:${EXTERNAL_ID}`;
const RANGE = {
  from: new Date('2026-06-01T12:00:00Z'),
  to: new Date('2026-06-07T12:00:00Z'),
};

const queryCostEventsMock = vi.fn();

vi.mock('../../src/lib/clickhouse/client.js', () => ({
  queryCostEvents: queryCostEventsMock,
}));

describe('dashboard canonical legacy-plus-controlled reads', () => {
  let queries: typeof import('../../src/lib/clickhouse/dashboard-queries.js');

  beforeEach(async () => {
    vi.resetModules();
    queryCostEventsMock.mockReset();
    queries = await import('../../src/lib/clickhouse/dashboard-queries.js');
  });

  it('checks real-event existence once against the canonical mixed view', async () => {
    queryCostEventsMock.mockResolvedValue([{ has_real: 1 }]);

    await expect(queries.hasAnyRealEvents(BUILDER_ID)).resolves.toBe(true);

    const sql = queryCostEventsMock.mock.calls[0]?.[1] as string;
    expect(sql).toContain('FROM cost_events_with_control');
    expect(sql).toContain('is_demo = 0');
    expect(sql).toContain('LIMIT 1');
    expect(sql).not.toContain('cost_customer_daily_agg');
    expect(queryCostEventsMock).toHaveBeenCalledTimes(1);
  });

  it('returns false without consulting a legacy-only aggregate fallback', async () => {
    queryCostEventsMock.mockResolvedValue([]);

    await expect(queries.hasAnyRealEvents(BUILDER_ID)).resolves.toBe(false);
    expect(queryCostEventsMock).toHaveBeenCalledTimes(1);
  });

  it('reads top end-users over the exact timestamp window from mixed events', async () => {
    queryCostEventsMock.mockResolvedValue([
      { customer_id: COMPOSITE_ID, total_spend_usd: '5.00', event_count: '10' },
    ]);

    const rows = await queries.getTopEndUsers(BUILDER_ID, RANGE, 5, { includeDemo: false });

    expect(rows[0]).toMatchObject({ customer_id: EXTERNAL_ID, total_spend_usd: 5 });
    const sql = queryCostEventsMock.mock.calls[0]?.[1] as string;
    expect(sql).toContain('FROM cost_events_with_control');
    expect(sql).toContain("timestamp >= parseDateTime64BestEffort({from:String}, 3, 'UTC')");
    expect(sql).toContain("timestamp <= parseDateTime64BestEffort({to:String}, 3, 'UTC')");
    expect(sql).toContain('is_demo = 0');
    expect(sql).not.toContain('cost_customer_daily_agg');
  });

  it('reads paginated customer summaries from the same canonical view', async () => {
    queryCostEventsMock.mockResolvedValue([
      {
        customer_id: COMPOSITE_ID,
        total_spend_usd: '12.50',
        event_count: '42',
        last_seen_at: '2026-06-06 10:00:00',
      },
    ]);

    const rows = await queries.getCustomerCostSummary(BUILDER_ID, RANGE, {
      includeDemo: false,
      limit: 100,
      offset: 20,
    });

    expect(rows[0]).toMatchObject({
      customer_id: EXTERNAL_ID,
      total_spend_usd: 12.5,
      event_count: 42,
      last_seen_at: '2026-06-06 10:00:00',
    });
    const sql = queryCostEventsMock.mock.calls[0]?.[1] as string;
    const params = queryCostEventsMock.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(sql).toContain('FROM cost_events_with_control');
    expect(sql).toContain('OFFSET {offset:UInt32}');
    expect(sql).not.toContain('cost_customer_daily_agg');
    expect(params).toMatchObject({ limit: 100, offset: 20 });
  });

  it('reads the model breakdown once without a legacy aggregate trust probe', async () => {
    queryCostEventsMock.mockResolvedValue([
      {
        provider: 'openai',
        model: 'gpt-4o-mini',
        total_spend_usd: '12.50',
        tokens_in: '100',
        tokens_out: '50',
        call_count: '5',
      },
    ]);

    const rows = await queries.getModelBreakdown(BUILDER_ID, RANGE, { includeDemo: false });

    expect(rows[0]).toMatchObject({
      provider: 'openai',
      model: 'gpt-4o-mini',
      total_spend_usd: 12.5,
      tokens_in: 100,
      tokens_out: 50,
      call_count: 5,
      avg_usd_per_call: 2.5,
    });
    const sql = queryCostEventsMock.mock.calls[0]?.[1] as string;
    const options = queryCostEventsMock.mock.calls[0]?.[3] as {
      queryLabel?: string;
      queryId?: string;
      timeoutMs?: number;
    };
    expect(sql).toContain('FROM cost_events_with_control');
    expect(sql).not.toContain('cost_model_daily_agg');
    expect(sql).toContain('is_demo = 0');
    expect(options).toMatchObject({ queryLabel: 'dashboard.model_breakdown', timeoutMs: 8_000 });
    expect(options.queryId).toMatch(/^dashboard\.model_breakdown\./);
    expect(queryCostEventsMock).toHaveBeenCalledTimes(1);
  });

  it('omits only the demo predicate when demo rows are explicitly requested', async () => {
    queryCostEventsMock.mockResolvedValue([]);

    await queries.getModelBreakdown(BUILDER_ID, RANGE, { includeDemo: true });

    const sql = queryCostEventsMock.mock.calls[0]?.[1] as string;
    expect(sql).toContain('FROM cost_events_with_control');
    expect(sql).not.toContain('is_demo = 0');
  });
});
