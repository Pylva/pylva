import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryCostEvents = vi.fn();

vi.mock('../../src/lib/clickhouse/client.js', () => ({
  queryCostEvents,
}));

const {
  BillingPeriodOpenError,
  BudgetProjectionPendingError,
  BudgetUsageAggregateError,
  getUsageForPeriod,
} = await import('../../src/lib/billing/clickhouse-usage.js');

describe('getUsageForPeriod', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses a non-shadowing metric alias so LLM token rows aggregate', async () => {
    queryCostEvents.mockResolvedValue([
      {
        metric_key: '',
        metric_value_sum: '0',
        tokens_in_sum: '2300',
        tokens_out_sum: '620',
        unpriced_count: '0',
        invalid_metric_count: '0',
      },
    ]);

    const usage = await getUsageForPeriod({
      builderId: 'builder-1',
      customerId: 'builder-1:customer-1',
      from: new Date('2026-06-01T00:00:00Z'),
      to: new Date('2026-06-02T00:00:00Z'),
    });

    const query = queryCostEvents.mock.calls[0]?.[1] as string;
    expect(query).toContain("ifNull(metric, '') AS metric_key");
    expect(query).toContain("sum(if(pricing_status = 'priced', ifNull(metric_value, 0), 0))");
    expect(query).toContain('isNull(metric)');
    expect(query).toContain('GROUP BY metric_key');
    expect(query).toContain('FROM cost_events_with_control');
    expect(query).toContain("parseDateTime64BestEffort({from:String}, 3, 'UTC')");
    expect(queryCostEvents.mock.calls[0]?.[2]).toEqual({
      customer_id: 'builder-1:customer-1',
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-02T00:00:00.000Z',
    });
    expect(usage.by_metric).toEqual({
      input_tokens: 2300,
      output_tokens: 620,
    });
    expect(usage.has_unpriced).toBe(false);
  });

  it('keeps reported metric usage separate from LLM token usage', async () => {
    queryCostEvents.mockResolvedValue([
      {
        metric_key: 'credits',
        metric_value_sum: '120',
        tokens_in_sum: '0',
        tokens_out_sum: '0',
        unpriced_count: '1',
        invalid_metric_count: '0',
      },
      {
        metric_key: '',
        metric_value_sum: '0',
        tokens_in_sum: '10',
        tokens_out_sum: '20',
        unpriced_count: '0',
        invalid_metric_count: '0',
      },
    ]);

    const usage = await getUsageForPeriod({
      builderId: 'builder-1',
      customerId: 'builder-1:customer-1',
      from: new Date('2026-06-01T00:00:00Z'),
      to: new Date('2026-06-02T00:00:00Z'),
    });

    expect(usage.by_metric).toEqual({
      credits: 120,
      input_tokens: 10,
      output_tokens: 20,
    });
    expect(usage.has_unpriced).toBe(true);
  });

  it('fails closed before querying billing usage when the controlled watermark has a gap', async () => {
    const projectionStore = {
      billingGate: vi.fn(async () => ({ closed: true, verified: false })),
    };
    await expect(
      getUsageForPeriod(
        {
          builderId: 'builder-1',
          customerId: 'builder-1:customer-1',
          from: new Date('2026-06-01T00:00:00Z'),
          to: new Date('2026-06-02T00:00:00Z'),
          requireAuthoritativeProjectionVerified: true,
        },
        { projectionStore },
      ),
    ).rejects.toBeInstanceOf(BudgetProjectionPendingError);
    expect(projectionStore.billingGate).toHaveBeenCalledWith(
      'builder-1',
      '2026-06-02T00:00:00.000Z',
    );
    expect(queryCostEvents).not.toHaveBeenCalled();
  });

  it('queries the unified read model after PostgreSQL verifies the closed period', async () => {
    queryCostEvents.mockResolvedValue([]);
    const projectionStore = {
      billingGate: vi.fn(async () => ({ closed: true, verified: true })),
    };
    await expect(
      getUsageForPeriod(
        {
          builderId: 'builder-1',
          customerId: 'builder-1:customer-1',
          from: new Date('2026-06-01T00:00:00Z'),
          to: new Date('2026-06-02T00:00:00Z'),
          requireAuthoritativeProjectionVerified: true,
        },
        { projectionStore },
      ),
    ).resolves.toEqual({ by_model: {}, by_metric: {}, has_unpriced: false });
    expect(queryCostEvents).toHaveBeenCalledOnce();
    const query = queryCostEvents.mock.calls[0]?.[1] as string;
    expect(query).toContain('FROM budget_cost_events_final');
    expect(query).toContain('AND payload_hash_count = 1');
  });

  it('rejects an open/future billing cutoff using the PostgreSQL clock', async () => {
    const projectionStore = {
      billingGate: vi.fn(async () => ({ closed: false, verified: false })),
    };
    await expect(
      getUsageForPeriod(
        {
          builderId: 'builder-1',
          customerId: 'builder-1:customer-1',
          from: new Date('2098-12-01T00:00:00.000Z'),
          to: new Date('2099-01-01T00:00:00.000Z'),
          requireAuthoritativeProjectionVerified: true,
        },
        { projectionStore },
      ),
    ).rejects.toBeInstanceOf(BillingPeriodOpenError);
    expect(queryCostEvents).not.toHaveBeenCalled();
  });

  it.each([
    ['NaN metric', { metric_key: 'credits', metric_value_sum: 'NaN' }],
    ['infinite metric', { metric_key: 'credits', metric_value_sum: 'Infinity' }],
    [
      'unsafe integer metric',
      { metric_key: 'credits', metric_value_sum: String(Number.MAX_SAFE_INTEGER + 1) },
    ],
    ['fractional token count', { metric_key: '', metric_value_sum: 0, tokens_in_sum: '1.5' }],
  ])('fails closed on a %s aggregate', async (_label, row) => {
    queryCostEvents.mockResolvedValue([
      {
        invalid_metric_count: 0,
        tokens_in_sum: 0,
        tokens_out_sum: 0,
        unpriced_count: 0,
        ...row,
      },
    ]);
    await expect(
      getUsageForPeriod({
        builderId: 'builder-1',
        customerId: 'builder-1:customer-1',
        from: new Date('2026-06-01T00:00:00.001Z'),
        to: new Date('2026-06-02T00:00:00.999Z'),
      }),
    ).rejects.toBeInstanceOf(BudgetUsageAggregateError);
  });

  it('fails closed when ClickHouse reports a non-finite priced metric row', async () => {
    queryCostEvents.mockResolvedValue([
      {
        metric_key: 'credits',
        metric_value_sum: null,
        tokens_in_sum: '0',
        tokens_out_sum: '0',
        unpriced_count: '0',
        invalid_metric_count: '1',
      },
    ]);

    await expect(
      getUsageForPeriod({
        builderId: 'builder-1',
        customerId: 'builder-1:customer-1',
        from: new Date('2026-06-01T00:00:00Z'),
        to: new Date('2026-06-02T00:00:00Z'),
      }),
    ).rejects.toBeInstanceOf(BudgetUsageAggregateError);
  });

  it.each([
    ['a missing aggregate field', { metric_key: '', metric_value_sum: '0' }],
    [
      'a non-string metric identity',
      {
        metric_key: { nested: true },
        metric_value_sum: '0',
        tokens_in_sum: '0',
        tokens_out_sum: '0',
        unpriced_count: '0',
        invalid_metric_count: '0',
      },
    ],
    [
      'a whitespace-padded count',
      {
        metric_key: '',
        metric_value_sum: '0',
        tokens_in_sum: ' 1',
        tokens_out_sum: '0',
        unpriced_count: '0',
        invalid_metric_count: '0',
      },
    ],
  ])('fails closed on %s', async (_label, row) => {
    queryCostEvents.mockResolvedValue([row]);
    await expect(
      getUsageForPeriod({
        builderId: 'builder-1',
        customerId: 'builder-1:customer-1',
        from: new Date('2026-06-01T00:00:00Z'),
        to: new Date('2026-06-02T00:00:00Z'),
      }),
    ).rejects.toBeInstanceOf(BudgetUsageAggregateError);
  });

  it('preserves adjacent millisecond boundaries in ClickHouse parameters', async () => {
    queryCostEvents.mockResolvedValue([]);
    await getUsageForPeriod({
      builderId: 'builder-1',
      customerId: 'builder-1:customer-1',
      from: new Date('2026-06-01T00:00:00.001Z'),
      to: new Date('2026-06-01T00:00:00.999Z'),
    });
    expect(queryCostEvents.mock.calls[0]?.[2]).toMatchObject({
      from: '2026-06-01T00:00:00.001Z',
      to: '2026-06-01T00:00:00.999Z',
    });
  });
});
