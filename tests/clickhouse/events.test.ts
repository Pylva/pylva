import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CostEventRow } from '../../src/lib/clickhouse/events.js';

const mocks = vi.hoisted(() => ({
  baseInsert: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock('../../src/lib/clickhouse/client.js', () => ({
  insertCostEvents: mocks.baseInsert,
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({
      error: mocks.logError,
      warn: mocks.logWarn,
    }),
  },
}));

const { insertCostEventsWithRetry } = await import('../../src/lib/clickhouse/events.js');

function row(overrides: Partial<CostEventRow> = {}): CostEventRow {
  return {
    timestamp: '2026-04-18T10:00:00.000Z',
    builder_id: '00000000-0000-4000-8000-000000000001',
    trace_id: '11111111-1111-4111-8111-111111111111',
    span_id: '22222222-2222-4222-8222-222222222222',
    parent_span_id: null,
    customer_id: '00000000-0000-4000-8000-000000000001:cust_1',
    provider: 'other',
    model: null,
    operation: 'reported',
    step_name: 'integration',
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 1.23,
    pricing_status: 'priced',
    latency_ms: 12,
    status: 'success',
    cost_source: 'configured',
    instrumentation_tier: 'reported',
    metric: 'search_query',
    metric_value: 1,
    stream_aborted: 0,
    abort_savings: 0,
    retention_days: 365,
    billing_retention_days: 365,
    metadata: '{}',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.baseInsert.mockResolvedValue(undefined);
});

describe('insertCostEventsWithRetry', () => {
  it('serializes ISO timestamps to ClickHouse DateTime format before insert', async () => {
    const events = [row()];

    await insertCostEventsWithRetry(events);

    expect(mocks.baseInsert).toHaveBeenCalledWith([
      expect.objectContaining({
        timestamp: '2026-04-18 10:00:00',
      }),
    ]);
    expect(events[0]?.timestamp).toBe('2026-04-18T10:00:00.000Z');
  });

  it('retries with the same serialized rows after a transient insert failure', async () => {
    mocks.baseInsert.mockRejectedValueOnce(new Error('transient')).mockResolvedValueOnce(undefined);

    await insertCostEventsWithRetry([row()]);

    expect(mocks.baseInsert).toHaveBeenCalledTimes(2);
    expect(mocks.baseInsert.mock.calls[0]?.[0]).toEqual(mocks.baseInsert.mock.calls[1]?.[0]);
    expect(mocks.baseInsert.mock.calls[1]?.[0]).toEqual([
      expect.objectContaining({
        timestamp: '2026-04-18 10:00:00',
      }),
    ]);
  });
});
