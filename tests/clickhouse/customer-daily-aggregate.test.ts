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

describe('dashboard customer daily aggregate reads', () => {
  let queries: typeof import('../../src/lib/clickhouse/dashboard-queries.js');

  beforeEach(async () => {
    vi.resetModules();
    queryCostEventsMock.mockReset();
    queries = await import('../../src/lib/clickhouse/dashboard-queries.js');
  });

  it('checks real-event existence from the demo-aware customer aggregate', async () => {
    queryCostEventsMock.mockResolvedValue([{ has_real: 1 }]);

    const result = await queries.hasAnyRealEvents(BUILDER_ID);

    expect(result).toBe(true);
    const sql = queryCostEventsMock.mock.calls[0]?.[1] as string;
    expect(sql).toContain('FROM cost_customer_daily_agg');
    expect(sql).toContain('is_demo = 0');
    expect(sql).not.toContain('FROM cost_events');
    expect(queryCostEventsMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to raw events before the customer aggregate is backfilled', async () => {
    queryCostEventsMock.mockResolvedValueOnce([]).mockResolvedValueOnce([{ has_real: 1 }]);

    const result = await queries.hasAnyRealEvents(BUILDER_ID);

    expect(result).toBe(true);
    const aggregateSql = queryCostEventsMock.mock.calls[0]?.[1] as string;
    const rawSql = queryCostEventsMock.mock.calls[1]?.[1] as string;
    const rawOptions = queryCostEventsMock.mock.calls[1]?.[3] as { queryLabel?: string };
    expect(aggregateSql).toContain('FROM cost_customer_daily_agg');
    expect(rawSql).toContain('FROM cost_events');
    expect(rawSql).toContain('is_demo = 0');
    expect(rawOptions.queryLabel).toBe('dashboard.has_any_real_events_raw_fallback');
  });

  it('combines top end-user aggregates with exact boundary timestamp reads', async () => {
    queryCostEventsMock.mockResolvedValue([
      { customer_id: COMPOSITE_ID, total_spend_usd: '5.00', event_count: '10' },
    ]);

    const rows = await queries.getTopEndUsers(BUILDER_ID, RANGE, 5, { includeDemo: false });

    expect(rows[0]).toMatchObject({ customer_id: EXTERNAL_ID, total_spend_usd: 5 });
    const sql = queryCostEventsMock.mock.calls[0]?.[1] as string;
    expect(sql).toContain('FROM cost_customer_daily_agg');
    expect(sql).toContain('FROM cost_events');
    expect(sql).toContain('day > toDate({from:DateTime})');
    expect(sql).toContain('day < toDate({to:DateTime})');
    expect(sql).toContain('timestamp >= {from:DateTime}');
    expect(sql).toContain('timestamp <= {to:DateTime}');
    expect(sql).toContain('toDate(timestamp) = toDate({from:DateTime})');
    expect(sql).toContain('toDate(timestamp) = toDate({to:DateTime})');
    expect(sql).not.toContain('day >= toDate({from:DateTime})');
    expect(sql).not.toContain('day <= toDate({to:DateTime})');
    expect(sql).toContain('is_demo = 0');
  });

  it('combines full-day aggregates with exact boundary timestamp reads', async () => {
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
    expect(sql).toContain('FROM cost_customer_daily_agg');
    expect(sql).toContain('FROM cost_events');
    expect(sql).toContain('day > toDate({from:DateTime})');
    expect(sql).toContain('day < toDate({to:DateTime})');
    expect(sql).toContain('timestamp >= {from:DateTime}');
    expect(sql).toContain('timestamp <= {to:DateTime}');
    expect(sql).toContain('toDate(timestamp) = toDate({from:DateTime})');
    expect(sql).toContain('toDate(timestamp) = toDate({to:DateTime})');
    expect(sql).not.toContain('day >= toDate({from:DateTime})');
    expect(sql).not.toContain('day <= toDate({to:DateTime})');
    expect(sql).toContain('OFFSET {offset:UInt32}');
    expect(params).toMatchObject({ limit: 100, offset: 20 });
  });
});

describe('dashboard model daily aggregate reads', () => {
  let queries: typeof import('../../src/lib/clickhouse/dashboard-queries.js');

  beforeEach(async () => {
    vi.resetModules();
    queryCostEventsMock.mockReset();
    queries = await import('../../src/lib/clickhouse/dashboard-queries.js');
  });

  it('combines trusted full-day model aggregates with exact boundary timestamp reads', async () => {
    queryCostEventsMock.mockResolvedValueOnce([{ status: 'trusted' }]).mockResolvedValueOnce([
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
    const trustSql = queryCostEventsMock.mock.calls[0]?.[1] as string;
    const trustOptions = queryCostEventsMock.mock.calls[0]?.[3] as {
      queryLabel?: string;
      timeoutMs?: number;
    };
    const sql = queryCostEventsMock.mock.calls[1]?.[1] as string;
    const options = queryCostEventsMock.mock.calls[1]?.[3] as {
      queryLabel?: string;
      queryId?: string;
      timeoutMs?: number;
    };
    expect(trustSql).toContain('FROM cost_model_daily_agg_backfill_status');
    expect(trustOptions).toMatchObject({
      queryLabel: 'dashboard.model_breakdown_aggregate_trust',
      timeoutMs: 8_000,
    });
    expect(sql).toContain('FROM cost_model_daily_agg');
    expect(sql).toContain('FROM cost_events');
    expect(sql).toContain('day > toDate({from:DateTime})');
    expect(sql).toContain('day < toDate({to:DateTime})');
    expect(sql).toContain('timestamp >= {from:DateTime}');
    expect(sql).toContain('timestamp <= {to:DateTime}');
    expect(sql).toContain('toDate(timestamp) = toDate({from:DateTime})');
    expect(sql).toContain('toDate(timestamp) = toDate({to:DateTime})');
    expect(sql).toContain('is_demo = 0');
    expect(sql).not.toContain('cost_daily_agg_v2');
    expect(options).toMatchObject({
      queryLabel: 'dashboard.model_breakdown',
      timeoutMs: 8_000,
    });
    expect(options.queryId).toMatch(/^dashboard\.model_breakdown\./);
  });

  it('falls back to exact raw events when the model aggregate is untrusted', async () => {
    queryCostEventsMock.mockResolvedValueOnce([{ status: 'untrusted' }]).mockResolvedValueOnce([
      {
        provider: 'anthropic',
        model: 'claude-3-haiku',
        total_spend_usd: '4.00',
        tokens_in: '20',
        tokens_out: '10',
        call_count: '2',
      },
    ]);

    const rows = await queries.getModelBreakdown(BUILDER_ID, RANGE, { includeDemo: false });

    expect(rows[0]).toMatchObject({
      provider: 'anthropic',
      model: 'claude-3-haiku',
      total_spend_usd: 4,
      tokens_in: 20,
      tokens_out: 10,
      call_count: 2,
      avg_usd_per_call: 2,
    });
    const sql = queryCostEventsMock.mock.calls[1]?.[1] as string;
    const options = queryCostEventsMock.mock.calls[1]?.[3] as {
      queryLabel?: string;
      queryId?: string;
      timeoutMs?: number;
    };
    expect(sql).toContain('FROM cost_events');
    expect(sql).not.toContain('FROM cost_model_daily_agg');
    expect(sql).toContain('timestamp >= {from:DateTime}');
    expect(sql).toContain('timestamp <= {to:DateTime}');
    expect(sql).not.toContain('toDate(timestamp) = toDate({from:DateTime})');
    expect(sql).not.toContain('toDate(timestamp) = toDate({to:DateTime})');
    expect(sql).toContain('is_demo = 0');
    expect(options).toMatchObject({
      queryLabel: 'dashboard.model_breakdown',
      timeoutMs: 8_000,
    });
    expect(options.queryId).toMatch(/^dashboard\.model_breakdown\./);
  });

  it('falls back to exact raw events when the trust marker is missing', async () => {
    queryCostEventsMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await queries.getModelBreakdown(BUILDER_ID, RANGE, { includeDemo: false });

    const sql = queryCostEventsMock.mock.calls[1]?.[1] as string;
    expect(sql).toContain('FROM cost_events');
    expect(sql).not.toContain('FROM cost_model_daily_agg');
  });

  it('falls back to exact raw events when the trust probe fails', async () => {
    queryCostEventsMock
      .mockRejectedValueOnce(new Error('status table missing'))
      .mockResolvedValueOnce([]);

    await queries.getModelBreakdown(BUILDER_ID, RANGE, { includeDemo: false });

    const sql = queryCostEventsMock.mock.calls[1]?.[1] as string;
    expect(sql).toContain('FROM cost_events');
    expect(sql).not.toContain('FROM cost_model_daily_agg');
  });

  it('does not apply the real-data filter when demo rows are explicitly included', async () => {
    queryCostEventsMock.mockResolvedValueOnce([{ status: 'trusted' }]).mockResolvedValueOnce([]);

    await queries.getModelBreakdown(BUILDER_ID, RANGE, { includeDemo: true });

    const sql = queryCostEventsMock.mock.calls[1]?.[1] as string;
    expect(sql).toContain('FROM cost_model_daily_agg');
    expect(sql).not.toContain('is_demo = 0');
  });
});
