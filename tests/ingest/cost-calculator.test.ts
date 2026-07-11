import { describe, it, expect } from 'vitest';
import {
  calculateCostUsd,
  emptyPricingMap,
  llmKey,
  metricKey,
  type MetricPriceRow,
  type PricingMap,
} from '../../src/lib/cost-calculator.js';
import { MAX_STORABLE_COST_USD } from '../../src/lib/clickhouse/decimal-limits.js';
import type { TelemetryEvent } from '@pylva/shared';

const baseLlm: TelemetryEvent = {
  schema_version: '1.6',
  run_id: '11111111-1111-4111-8111-111111111111',
  parent_run_id: null,
  trace_id: '22222222-2222-4222-8222-222222222222',
  span_id: '33333333-3333-4333-8333-333333333333',
  parent_span_id: null,
  customer_id: 'cust_1',
  step_name: 'answer',
  model: 'gpt-4o',
  provider: 'openai',
  tokens_in: 1000,
  tokens_out: 500,
  latency_ms: 100,
  tool_name: null,
  status: 'success',
  framework: 'none',
  instrumentation_tier: 'sdk_wrapper',
  cost_source: 'auto',
  metric: null,
  metric_value: null,
  stream_aborted: false,
  abort_savings_usd: 0,
  sdk_version: '0.0.1',
  timestamp: '2026-04-18T10:00:00.000Z',
};

function buildLlmMap(
  rate: { input_per_1m: number; output_per_1m: number },
  source: 'llm_pricing' | 'custom_pricing' = 'llm_pricing',
): PricingMap {
  const map = emptyPricingMap();
  map.llm.set(llmKey('openai', 'gpt-4o'), [
    {
      provider: 'openai',
      model: 'gpt-4o',
      input_per_1m_usd: rate.input_per_1m,
      output_per_1m_usd: rate.output_per_1m,
      effective_from: new Date('2026-01-01T00:00:00Z'),
      effective_to: null,
      source,
    },
  ]);
  return map;
}

describe('calculateCostUsd — LLM', () => {
  it('computes cost for GPT-4o at $2.50 input / $10.00 output per 1M', () => {
    const map = buildLlmMap({ input_per_1m: 2.5, output_per_1m: 10 });
    const result = calculateCostUsd(baseLlm, map);
    // 1000 * 2.5 / 1M + 500 * 10 / 1M = 0.0025 + 0.005 = 0.0075
    expect(result).toEqual({ cost_usd: 0.0075, pricing_status: 'priced' });
  });

  it('rounds to 6 decimal places', () => {
    const map = buildLlmMap({
      input_per_1m: 3.333333,
      output_per_1m: 9.999999,
    });
    const result = calculateCostUsd({ ...baseLlm, tokens_in: 1, tokens_out: 1 }, map);
    expect(result.pricing_status).toBe('priced');
    if (result.pricing_status === 'priced') {
      // 3.333333 / 1e6 + 9.999999 / 1e6 = 1.3333332e-5 → rounded: 0.000013
      expect(result.cost_usd).toBe(0.000013);
    }
  });

  it('returns needs_input when no pricing row exists', () => {
    const map = emptyPricingMap();
    const result = calculateCostUsd(baseLlm, map);
    expect(result).toEqual({ cost_usd: null, pricing_status: 'needs_input' });
  });

  it('returns needs_input when provider/model is null', () => {
    const map = buildLlmMap({ input_per_1m: 2.5, output_per_1m: 10 });
    const result = calculateCostUsd({ ...baseLlm, model: null }, map);
    expect(result).toEqual({ cost_usd: null, pricing_status: 'needs_input' });
  });

  it('skips rows with effective_to in the past', () => {
    const map = emptyPricingMap();
    map.llm.set(llmKey('openai', 'gpt-4o'), [
      {
        provider: 'openai',
        model: 'gpt-4o',
        input_per_1m_usd: 2.5,
        output_per_1m_usd: 10,
        effective_from: new Date('2020-01-01T00:00:00Z'),
        effective_to: new Date('2021-01-01T00:00:00Z'), // already expired
        source: 'llm_pricing',
      },
    ]);
    const result = calculateCostUsd(baseLlm, map);
    expect(result.pricing_status).toBe('needs_input');
  });

  it('prefers custom_pricing over llm_pricing when both present', () => {
    const map = emptyPricingMap();
    map.llm.set(llmKey('openai', 'gpt-4o'), [
      {
        provider: 'openai',
        model: 'gpt-4o',
        input_per_1m_usd: 100,
        output_per_1m_usd: 100,
        effective_from: new Date('2026-01-01T00:00:00Z'),
        effective_to: null,
        source: 'custom_pricing',
      },
      {
        provider: 'openai',
        model: 'gpt-4o',
        input_per_1m_usd: 2.5,
        output_per_1m_usd: 10,
        effective_from: new Date('2026-01-01T00:00:00Z'),
        effective_to: null,
        source: 'llm_pricing',
      },
    ]);
    const result = calculateCostUsd({ ...baseLlm, tokens_in: 1000, tokens_out: 1000 }, map);
    // custom row: (1000*100 + 1000*100)/1M = 0.2
    expect(result).toEqual({ cost_usd: 0.2, pricing_status: 'priced' });
  });
});

describe('calculateCostUsd — non-LLM (reported)', () => {
  const baseReported: TelemetryEvent = {
    ...baseLlm,
    instrumentation_tier: 'reported',
    cost_source: 'configured',
    model: null,
    provider: null,
    tokens_in: 0,
    tokens_out: 0,
    metric: 'search_query',
    metric_value: 5,
  };

  it('computes non-LLM cost from metric_value * price_per_unit', () => {
    const map = emptyPricingMap();
    map.metric.set(metricKey('search_query'), [
      {
        metric: 'search_query',
        price_per_unit_usd: 0.01,
        effective_from: new Date('2026-01-01T00:00:00Z'),
        effective_to: null,
        source: 'custom_pricing',
      },
    ]);
    const result = calculateCostUsd(baseReported, map);
    expect(result).toEqual({ cost_usd: 0.05, pricing_status: 'priced' });
  });

  it('returns needs_input when metric is unpriced', () => {
    const map = emptyPricingMap();
    const result = calculateCostUsd(baseReported, map);
    expect(result).toEqual({ cost_usd: null, pricing_status: 'needs_input' });
  });

  // Decimal(10,6) overflow guard: a storable cost is <= 9999.999999. A larger
  // computed cost cannot be inserted into ClickHouse and would poison-pill the
  // whole batch, so it must route to needs_input instead of being returned.
  it('routes a reported cost above the Decimal(10,6) max to needs_input', () => {
    const map = emptyPricingMap();
    map.metric.set(metricKey('search_query'), [
      {
        metric: 'search_query',
        price_per_unit_usd: 0.01,
        effective_from: new Date('2026-01-01T00:00:00Z'),
        effective_to: null,
        source: 'custom_pricing',
      },
    ]);
    // 1e9 units * $0.01 = $10,000,000 — far beyond 9999.999999.
    const result = calculateCostUsd({ ...baseReported, metric_value: 1_000_000_000 }, map);
    expect(result).toEqual({ cost_usd: null, pricing_status: 'needs_input' });
  });

  it('keeps a reported cost exactly at the Decimal(10,6) max priced', () => {
    const map = emptyPricingMap();
    map.metric.set(metricKey('search_query'), [
      {
        metric: 'search_query',
        price_per_unit_usd: 1,
        effective_from: new Date('2026-01-01T00:00:00Z'),
        effective_to: null,
        source: 'custom_pricing',
      },
    ]);
    const result = calculateCostUsd({ ...baseReported, metric_value: MAX_STORABLE_COST_USD }, map);
    expect(result).toEqual({
      cost_usd: MAX_STORABLE_COST_USD,
      pricing_status: 'priced',
    });
  });

  it('routes a negative reported cost to needs_input', () => {
    const map = emptyPricingMap();
    map.metric.set(metricKey('search_query'), [
      {
        metric: 'search_query',
        price_per_unit_usd: -0.01,
        effective_from: new Date('2026-01-01T00:00:00Z'),
        effective_to: null,
        source: 'cost_sources',
      },
    ]);
    const result = calculateCostUsd(baseReported, map);
    expect(result).toEqual({ cost_usd: null, pricing_status: 'needs_input' });
  });

  it('routes a tiny negative reported cost to needs_input before rounding', () => {
    const map = emptyPricingMap();
    map.metric.set(metricKey('search_query'), [
      {
        metric: 'search_query',
        price_per_unit_usd: -0.00000001,
        effective_from: new Date('2026-01-01T00:00:00Z'),
        effective_to: null,
        source: 'cost_sources',
      },
    ]);
    const result = calculateCostUsd({ ...baseReported, metric_value: 1 }, map);
    expect(result).toEqual({ cost_usd: null, pricing_status: 'needs_input' });
  });

  it('routes a non-finite reported cost to needs_input', () => {
    const map = emptyPricingMap();
    map.metric.set(metricKey('search_query'), [
      {
        metric: 'search_query',
        price_per_unit_usd: Number.POSITIVE_INFINITY,
        effective_from: new Date('2026-01-01T00:00:00Z'),
        effective_to: null,
        source: 'cost_sources',
      },
    ]);
    const result = calculateCostUsd(baseReported, map);
    expect(result).toEqual({ cost_usd: null, pricing_status: 'needs_input' });
  });

  it('routes a tiered reported cost above the Decimal(10,6) max to needs_input', () => {
    const map = emptyPricingMap();
    const row: MetricPriceRow = {
      metric: 'search_query',
      price_per_unit_usd: 0,
      tiers: [{ from: 0, to: null, price: MAX_STORABLE_COST_USD }],
      effective_from: new Date('2026-01-01T00:00:00Z'),
      effective_to: null,
      source: 'cost_sources',
    };
    map.metric.set(metricKey('search_query'), [row]);
    const result = calculateCostUsd({ ...baseReported, metric_value: 2 }, map);
    expect(result).toEqual({ cost_usd: null, pricing_status: 'needs_input' });
  });

  it('routes a reported cost that is just over the max to needs_input before rounding', () => {
    const map = emptyPricingMap();
    map.metric.set(metricKey('search_query'), [
      {
        metric: 'search_query',
        price_per_unit_usd: 1,
        effective_from: new Date('2026-01-01T00:00:00Z'),
        effective_to: null,
        source: 'cost_sources',
      },
    ]);
    const result = calculateCostUsd(
      { ...baseReported, metric_value: MAX_STORABLE_COST_USD + 0.0000004 },
      map,
    );
    expect(result).toEqual({ cost_usd: null, pricing_status: 'needs_input' });
  });
});

describe('calculateCostUsd — Decimal(10,6) overflow guard (LLM)', () => {
  it('routes an LLM cost above the Decimal(10,6) max to needs_input', () => {
    // $1000 / 1M output tokens * 100M tokens = $100,000 — overflows.
    const map = buildLlmMap({ input_per_1m: 0, output_per_1m: 1000 });
    const result = calculateCostUsd({ ...baseLlm, tokens_in: 0, tokens_out: 100_000_000 }, map);
    expect(result).toEqual({ cost_usd: null, pricing_status: 'needs_input' });
  });

  it('keeps an LLM cost exactly at the Decimal(10,6) max priced', () => {
    const map = buildLlmMap({
      input_per_1m: 0,
      output_per_1m: MAX_STORABLE_COST_USD,
    });
    const result = calculateCostUsd({ ...baseLlm, tokens_in: 0, tokens_out: 1_000_000 }, map);
    expect(result).toEqual({
      cost_usd: MAX_STORABLE_COST_USD,
      pricing_status: 'priced',
    });
  });

  it('routes a negative LLM cost to needs_input', () => {
    const map = buildLlmMap({ input_per_1m: 0, output_per_1m: -1 });
    const result = calculateCostUsd({ ...baseLlm, tokens_in: 0, tokens_out: 1_000_000 }, map);
    expect(result).toEqual({ cost_usd: null, pricing_status: 'needs_input' });
  });
});
