// Pins the cost-simulation math in src/lib/simulator/engine.ts.
//
// Only the I/O seams are mocked: queryCostEvents (ClickHouse) and the
// drizzle db client (Postgres pricing lookup). The tenant guard
// (assertBuilderId), chTimestamp, and the aggregation/collapse logic all run
// for real.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OTHERS_CUSTOMER_ID } from '@pylva/shared';
import { BuilderIdMismatchError } from '../../src/lib/clickhouse/query-guard.js';
import type { ValidatedSimulatorRequest } from '../../src/lib/simulator/validator.js';

const mocks = vi.hoisted(() => ({
  queryCostEvents: vi.fn(),
  dbSelect: vi.fn(),
}));

vi.mock('../../src/lib/clickhouse/client.js', () => ({
  queryCostEvents: mocks.queryCostEvents,
}));

vi.mock('../../src/lib/db/client.js', () => ({
  db: { select: mocks.dbSelect },
}));

const { runSimulation } = await import('../../src/lib/simulator/engine.js');

const BUILDER_ID = 'builder-1';

function request(overrides: Partial<ValidatedSimulatorRequest> = {}): ValidatedSimulatorRequest {
  return {
    customer_id: null,
    period_start: '2026-01-01T00:00:00.000Z',
    period_end: '2026-01-31T00:00:00.000Z',
    model_swaps: [
      {
        from_provider: 'openai',
        from_model: 'gpt-4o',
        to_provider: 'anthropic',
        to_model: 'claude-haiku',
      },
    ],
    ...overrides,
  };
}

// ClickHouse JSON rows arrive as strings; the engine must Number() them.
function aggRow(overrides: Record<string, string | null> = {}) {
  return {
    customer_id: 'cust-1',
    provider: 'openai',
    model: 'gpt-4o',
    step_name: 'chat',
    tokens_in: '1000000',
    tokens_out: '500000',
    original_cost_usd: '12.5',
    event_count: '10',
    ...overrides,
  };
}

function primeQueries(aggRows: unknown[], freshnessRows: unknown[] = []) {
  mocks.queryCostEvents.mockImplementation(async (_builderId: string, query: string) =>
    query.includes('max(day)') ? freshnessRows : aggRows,
  );
}

function primePricing(rows: unknown[]) {
  mocks.dbSelect.mockReturnValue({
    from: () => ({ where: () => Promise.resolve(rows) }),
  });
}

const HAIKU_PRICING = {
  provider: 'anthropic',
  model: 'claude-haiku',
  // decimal columns come back as strings; the engine must Number() them
  input_per_1m: '0.25',
  output_per_1m: '1.25',
};

beforeEach(() => {
  vi.clearAllMocks();
  primeQueries([], []);
  primePricing([]);
});

describe('runSimulation — tenant guard', () => {
  it('throws BuilderIdMismatchError before querying when builder ids diverge', async () => {
    await expect(runSimulation('builder-a', 'builder-b', request())).rejects.toThrow(
      BuilderIdMismatchError,
    );
    expect(mocks.queryCostEvents).not.toHaveBeenCalled();
    expect(mocks.dbSelect).not.toHaveBeenCalled();
  });
});

describe('runSimulation — query construction', () => {
  it('queries the agg table with chTimestamp bounds and no customer filter by default', async () => {
    await runSimulation(BUILDER_ID, BUILDER_ID, request());

    const [builderArg, sql, params] = mocks.queryCostEvents.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(builderArg).toBe(BUILDER_ID);
    expect(sql).toContain('FROM cost_daily_agg_v2');
    expect(sql).toContain('builder_id = {builder_id:String}');
    expect(sql).not.toContain('AND customer_id = {customer_id:String}');
    expect(params).toEqual({ from: '2026-01-01 00:00:00', to: '2026-01-31 00:00:00' });
  });

  it('adds the customer filter and param when customer_id is set', async () => {
    await runSimulation(BUILDER_ID, BUILDER_ID, request({ customer_id: 'cust-9' }));

    const [, sql, params] = mocks.queryCostEvents.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(sql).toContain('AND customer_id = {customer_id:String}');
    expect(params).toEqual({
      from: '2026-01-01 00:00:00',
      to: '2026-01-31 00:00:00',
      customer_id: 'cust-9',
    });
  });

  it('skips the pricing lookup entirely when there are no swaps', async () => {
    await runSimulation(BUILDER_ID, BUILDER_ID, request({ model_swaps: [] }));
    expect(mocks.dbSelect).not.toHaveBeenCalled();
  });
});

describe('runSimulation — cost math', () => {
  it('returns an all-zero result for zero traffic', async () => {
    primeQueries([], []);

    const result = await runSimulation(BUILDER_ID, BUILDER_ID, request());

    expect(result).toEqual({
      original_cost_usd: 0,
      simulated_cost_usd: 0,
      savings_usd: 0,
      savings_percent: 0, // division-by-zero guard: not NaN
      breakdown: [],
      period_start: '2026-01-01T00:00:00.000Z',
      period_end: '2026-01-31T00:00:00.000Z',
      freshness_timestamp: null,
      warnings: [],
    });
  });

  it('reprices swapped rows from the price table and leaves other rows untouched', async () => {
    primeQueries(
      [
        aggRow(), // matches the swap: 1M in, 0.5M out, $12.50 original
        aggRow({
          customer_id: 'cust-2',
          provider: 'anthropic',
          model: 'claude-3',
          step_name: '', // ClickHouse empty string maps to null
          tokens_in: '10',
          tokens_out: '10',
          original_cost_usd: '5',
          event_count: '3',
        }),
      ],
      [{ freshness: '2026-01-30' }],
    );
    primePricing([HAIKU_PRICING]);

    const result = await runSimulation(BUILDER_ID, BUILDER_ID, request());

    // (1_000_000 * 0.25 + 500_000 * 1.25) / 1_000_000 = 0.875
    expect(result.breakdown).toEqual([
      {
        customer_id: 'cust-1',
        provider: 'openai',
        step_name: 'chat',
        original_model: 'gpt-4o',
        simulated_model: 'claude-haiku',
        original_cost_usd: 12.5,
        simulated_cost_usd: 0.875,
        event_count: 10,
      },
      {
        customer_id: 'cust-2',
        provider: 'anthropic',
        step_name: null,
        original_model: 'claude-3',
        simulated_model: 'claude-3',
        original_cost_usd: 5,
        simulated_cost_usd: 5,
        event_count: 3,
      },
    ]);
    expect(result.original_cost_usd).toBe(17.5);
    expect(result.simulated_cost_usd).toBe(5.875);
    expect(result.savings_usd).toBe(11.625);
    expect(result.savings_percent).toBe(66.43); // 66.4285... rounded to 2dp
    expect(result.freshness_timestamp).toBe('2026-01-30');
    expect(result.warnings).toEqual([]);
  });

  it('reports negative savings when the target model is more expensive', async () => {
    primeQueries([
      aggRow({ tokens_in: '1000000', tokens_out: '0', original_cost_usd: '1', event_count: '1' }),
    ]);
    primePricing([{ ...HAIKU_PRICING, input_per_1m: '100', output_per_1m: '0' }]);

    const result = await runSimulation(BUILDER_ID, BUILDER_ID, request());

    expect(result.simulated_cost_usd).toBe(100);
    expect(result.savings_usd).toBe(-99);
    expect(result.savings_percent).toBe(-9900);
  });

  it('treats unknown target pricing as $0, warns once, and still relabels the model', async () => {
    primeQueries([
      aggRow(),
      aggRow({ customer_id: 'cust-2', original_cost_usd: '7.5', event_count: '2' }),
    ]);
    primePricing([]); // no pricing rows for the target model

    const result = await runSimulation(BUILDER_ID, BUILDER_ID, request());

    expect(result.warnings).toEqual(['Unknown pricing for anthropic/claude-haiku']);
    expect(result.breakdown.map((b) => b.simulated_cost_usd)).toEqual([0, 0]);
    expect(result.breakdown.map((b) => b.simulated_model)).toEqual([
      'claude-haiku',
      'claude-haiku',
    ]);
    expect(result.original_cost_usd).toBe(20);
    expect(result.simulated_cost_usd).toBe(0);
    expect(result.savings_percent).toBe(100);
  });

  it('lets the last swap win when two swaps share the same from-model', async () => {
    primeQueries([aggRow({ tokens_in: '1000000', tokens_out: '0' })]);
    primePricing([
      { provider: 'anthropic', model: 'model-a', input_per_1m: '1', output_per_1m: '0' },
      { provider: 'anthropic', model: 'model-b', input_per_1m: '2', output_per_1m: '0' },
    ]);

    const result = await runSimulation(
      BUILDER_ID,
      BUILDER_ID,
      request({
        model_swaps: [
          { from_provider: 'openai', from_model: 'gpt-4o', to_provider: 'anthropic', to_model: 'model-a' },
          { from_provider: 'openai', from_model: 'gpt-4o', to_provider: 'anthropic', to_model: 'model-b' },
        ],
      }),
    );

    expect(result.breakdown[0]?.simulated_model).toBe('model-b');
    expect(result.breakdown[0]?.simulated_cost_usd).toBe(2);
  });

  it('does not chain swaps: rows already on the target model are not re-swapped', async () => {
    primeQueries([
      aggRow({ provider: 'anthropic', model: 'claude-haiku', original_cost_usd: '3' }),
    ]);
    primePricing([HAIKU_PRICING]);

    const result = await runSimulation(BUILDER_ID, BUILDER_ID, request());

    expect(result.breakdown[0]?.simulated_model).toBe('claude-haiku');
    expect(result.breakdown[0]?.simulated_cost_usd).toBe(3); // original cost kept
  });

  it('uses the first pricing row when the price table has duplicates', async () => {
    primeQueries([aggRow({ tokens_in: '1000000', tokens_out: '0' })]);
    primePricing([
      { ...HAIKU_PRICING, input_per_1m: '1', output_per_1m: '0' },
      { ...HAIKU_PRICING, input_per_1m: '999', output_per_1m: '0' },
    ]);

    const result = await runSimulation(BUILDER_ID, BUILDER_ID, request());

    expect(result.breakdown[0]?.simulated_cost_usd).toBe(1);
  });
});

describe('runSimulation — top-N collapse', () => {
  function customerRows(count: number) {
    // cust-01 costs $1 ... cust-N costs $N; none match the swap.
    return Array.from({ length: count }, (_, i) =>
      aggRow({
        customer_id: `cust-${String(i + 1).padStart(2, '0')}`,
        model: 'untouched-model',
        tokens_in: '0',
        tokens_out: '0',
        original_cost_usd: String(i + 1),
        event_count: '1',
      }),
    );
  }

  it('keeps the breakdown as-is at exactly 20 customers', async () => {
    primeQueries(customerRows(20));

    const result = await runSimulation(BUILDER_ID, BUILDER_ID, request());

    expect(result.breakdown).toHaveLength(20);
    expect(result.breakdown.some((b) => b.customer_id === OTHERS_CUSTOMER_ID)).toBe(false);
  });

  it('collapses customers beyond the top 20 by original cost into the others bucket', async () => {
    primeQueries(customerRows(22));

    const result = await runSimulation(BUILDER_ID, BUILDER_ID, request());

    // Top 20 by cost are cust-03..cust-22; cust-01 ($1) and cust-02 ($2) collapse.
    expect(result.breakdown).toHaveLength(21);
    expect(result.breakdown.map((b) => b.customer_id)).not.toContain('cust-01');
    expect(result.breakdown.map((b) => b.customer_id)).not.toContain('cust-02');
    expect(result.breakdown[20]).toEqual({
      customer_id: OTHERS_CUSTOMER_ID,
      provider: '',
      step_name: null,
      original_model: '',
      simulated_model: '',
      original_cost_usd: 3,
      simulated_cost_usd: 3,
      event_count: 2,
    });
    // Totals are computed over the collapsed breakdown, so nothing is lost.
    expect(result.original_cost_usd).toBe(253); // 1 + 2 + ... + 22
    expect(result.simulated_cost_usd).toBe(253);
    expect(result.savings_usd).toBe(0);
    expect(result.savings_percent).toBe(0);
  });
});
