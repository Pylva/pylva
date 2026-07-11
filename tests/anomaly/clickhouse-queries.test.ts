// Regression test for bug_011: builder-level diagnosis (`agg.all`)
// must hold one entry per (step / model / source) key, not one per
// (customer, key) pair. The CH queries `GROUP BY customer_id, key`,
// so without the collapseByKey pass the same step appears once per
// customer and `diffByKey` in margin-diagnosis.ts overwrites
// duplicates on the prior loop — wildly wrong deltas for builders
// with >1 customer per step/model.

import { describe, it, expect, vi } from 'vitest';
import type { PeriodSlices } from '../../src/lib/anomaly/clickhouse-queries.js';

vi.mock('../../src/lib/config.js', () => ({
  env: { CLICKHOUSE_URL: 'http://localhost:8123' },
}));
vi.mock('../../src/lib/clickhouse/client.js', () => ({
  queryCostEvents: vi.fn(),
}));

const { __test__, costForExternalCustomer } =
  await import('../../src/lib/anomaly/clickhouse-queries.js');
const { collapseByKey } = __test__;

describe('collapseByKey', () => {
  it('sums cost across customers for the same step_name', () => {
    const byCustomer = new Map<string | null, PeriodSlices>([
      [
        'cust-1',
        {
          steps: [{ step_name: 'summarize', cost_usd: 50, iterations: 10 }],
          models: [],
          sources: [],
        },
      ],
      [
        'cust-2',
        {
          steps: [{ step_name: 'summarize', cost_usd: 30, iterations: 6 }],
          models: [],
          sources: [],
        },
      ],
      [
        'cust-3',
        {
          steps: [{ step_name: 'summarize', cost_usd: 20, iterations: 4 }],
          models: [],
          sources: [],
        },
      ],
    ]);
    const all = collapseByKey(byCustomer);
    expect(all.steps).toHaveLength(1);
    expect(all.steps[0]).toEqual({ step_name: 'summarize', cost_usd: 100, iterations: 20 });
  });

  it('sums cost across customers for the same (provider, model)', () => {
    const byCustomer = new Map<string | null, PeriodSlices>([
      [
        'cust-1',
        { steps: [], models: [{ provider: 'openai', model: 'gpt-4o', cost_usd: 60 }], sources: [] },
      ],
      [
        'cust-2',
        { steps: [], models: [{ provider: 'openai', model: 'gpt-4o', cost_usd: 40 }], sources: [] },
      ],
    ]);
    const all = collapseByKey(byCustomer);
    expect(all.models).toHaveLength(1);
    expect(all.models[0]).toEqual({ provider: 'openai', model: 'gpt-4o', cost_usd: 100 });
  });

  it('keeps distinct (provider, model) pairs separate', () => {
    const byCustomer = new Map<string | null, PeriodSlices>([
      [
        'cust-1',
        {
          steps: [],
          models: [
            { provider: 'openai', model: 'gpt-4o', cost_usd: 60 },
            { provider: 'anthropic', model: 'claude-3-5-sonnet', cost_usd: 40 },
          ],
          sources: [],
        },
      ],
      [
        'cust-2',
        {
          steps: [],
          models: [{ provider: 'openai', model: 'gpt-4o', cost_usd: 30 }],
          sources: [],
        },
      ],
    ]);
    const all = collapseByKey(byCustomer);
    expect(all.models).toHaveLength(2);
    const openai = all.models.find((m) => m.provider === 'openai');
    const anthropic = all.models.find((m) => m.provider === 'anthropic');
    expect(openai?.cost_usd).toBe(90);
    expect(anthropic?.cost_usd).toBe(40);
  });

  it('sums cost across customers for the same source', () => {
    const byCustomer = new Map<string | null, PeriodSlices>([
      ['cust-1', { steps: [], models: [], sources: [{ source: 'auto', cost_usd: 25 }] }],
      ['cust-2', { steps: [], models: [], sources: [{ source: 'auto', cost_usd: 75 }] }],
    ]);
    const all = collapseByKey(byCustomer);
    expect(all.sources).toHaveLength(1);
    expect(all.sources[0]).toEqual({ source: 'auto', cost_usd: 100 });
  });

  it('treats null step_name / model / source as a distinct collision-proof bucket', () => {
    const byCustomer = new Map<string | null, PeriodSlices>([
      [
        'cust-1',
        { steps: [{ step_name: null, cost_usd: 10, iterations: 2 }], models: [], sources: [] },
      ],
      [
        'cust-2',
        { steps: [{ step_name: null, cost_usd: 20, iterations: 4 }], models: [], sources: [] },
      ],
      [
        'cust-3',
        {
          steps: [{ step_name: 'summarize', cost_usd: 30, iterations: 6 }],
          models: [],
          sources: [],
        },
      ],
    ]);
    const all = collapseByKey(byCustomer);
    expect(all.steps).toHaveLength(2);
    const nullBucket = all.steps.find((s) => s.step_name == null);
    const summarize = all.steps.find((s) => s.step_name === 'summarize');
    expect(nullBucket?.cost_usd).toBe(30);
    expect(summarize?.cost_usd).toBe(30);
  });

  it('returns empty arrays when byCustomer is empty', () => {
    const all = collapseByKey(new Map());
    expect(all).toEqual({ steps: [], models: [], sources: [] });
  });
});

describe('costForExternalCustomer', () => {
  const BUILDER = '00000000-0000-0000-0000-000000000001';
  // `costByCustomer` is keyed by the composite `<builderId>:<external>`,
  // exactly as fetchPeriodAggregates produces it.
  const agg = {
    total_cost_usd: 500,
    costByCustomer: new Map<string | null, number>([[`${BUILDER}:acme`, 120]]),
  };

  it('returns the builder-level total for a null customer', () => {
    expect(costForExternalCustomer(agg, BUILDER, null)).toBe(500);
  });

  it('re-composes the external id to the composite key before lookup', () => {
    // Passing the bare external id must hit the composite-keyed entry.
    expect(costForExternalCustomer(agg, BUILDER, 'acme')).toBe(120);
  });

  it('does NOT match when the external id is used as-is (regression guard)', () => {
    // The bare external id is not a key in the composite-keyed map; only
    // the re-composed lookup finds it. A miss yields 0, not a throw.
    expect(agg.costByCustomer.get('acme')).toBeUndefined();
    expect(costForExternalCustomer(agg, BUILDER, 'unknown')).toBe(0);
  });
});
