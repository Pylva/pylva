import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InstrumentationTier, type TelemetryEvent } from '@pylva/shared';
import { llmKey, metricKey } from '../../src/lib/cost-calculator.js';

const mocks = vi.hoisted(() => ({
  logError: vi.fn(),
  resolveCostSourcePricing: vi.fn(),
  txExecute: vi.fn(),
  withRLS: vi.fn(),
}));

vi.mock('../../src/lib/db/rls.js', () => ({
  withRLS: mocks.withRLS,
}));

vi.mock('../../src/lib/ingest/cost-source-pricing.js', () => ({
  resolveCostSourcePricing: mocks.resolveCostSourcePricing,
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({
      error: mocks.logError,
    }),
  },
}));

const { lookupPricing, resetPricingCaches } =
  await import('../../src/lib/ingest/pricing-lookup.js');

const builderId = '00000000-0000-4000-8000-000000000001';

function queryText(callIndex: number): string {
  return JSON.stringify(mocks.txExecute.mock.calls[callIndex]?.[0], (_key, value) =>
    typeof value === 'function' ? undefined : value,
  );
}

function reportedEvent(metric: string): TelemetryEvent {
  return {
    timestamp: '2026-04-18T10:00:00.000Z',
    instrumentation_tier: InstrumentationTier.REPORTED,
    metric,
  } as TelemetryEvent;
}

function llmEvent(provider: string, model: string): TelemetryEvent {
  return {
    timestamp: '2026-04-18T10:00:00.000Z',
    instrumentation_tier: InstrumentationTier.SDK_WRAPPER,
    provider,
    model,
  } as TelemetryEvent;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPricingCaches();
  mocks.resolveCostSourcePricing.mockResolvedValue({
    pricePerUnit: null,
    tiers: null,
  });
  mocks.withRLS.mockImplementation(
    async (_builderId: string, cb: (tx: unknown) => Promise<unknown>) =>
      cb({ execute: mocks.txExecute }),
  );
});

describe('lookupPricing', () => {
  it('finds custom metric pricing for a single reported metric using an IN list', async () => {
    mocks.txExecute.mockResolvedValueOnce([
      {
        metric: 'search_query',
        price_per_unit_usd: '0.01',
        effective_from: '2026-01-01T00:00:00.000Z',
        effective_to: null,
      },
    ]);

    const pricing = await lookupPricing(builderId, [reportedEvent('search_query')]);
    const rows = pricing.metric.get(metricKey('search_query'));

    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.price_per_unit_usd).toBe(0.01);
    expect(queryText(0)).toContain('builder_id =');
    expect(queryText(0)).toContain('metric IN');
    expect(queryText(0)).not.toContain('ANY');
    expect(mocks.resolveCostSourcePricing).not.toHaveBeenCalled();
  });

  it('falls back to cost_sources flat pricing when no custom_pricing row matches', async () => {
    // custom_pricing query returns nothing for this metric. The builder priced
    // it via cost_sources instead — that fallback MUST fire, or every event is
    // marked needs_input (cost_usd = null) and the usage goes unbilled.
    mocks.txExecute.mockResolvedValueOnce([]);
    mocks.resolveCostSourcePricing.mockResolvedValueOnce({
      pricePerUnit: 0.05,
      tiers: null,
    });

    const pricing = await lookupPricing(builderId, [reportedEvent('pages_processed')]);

    expect(mocks.resolveCostSourcePricing).toHaveBeenCalledWith(builderId, 'pages_processed');
    const rows = pricing.metric.get(metricKey('pages_processed'));
    expect(rows).toHaveLength(1);
    expect(rows?.[0]).toMatchObject({
      price_per_unit_usd: 0.05,
      source: 'cost_sources',
    });
  });

  it('falls back to cost_sources when a custom_pricing miss is served from cache', async () => {
    mocks.txExecute.mockResolvedValueOnce([]);
    mocks.resolveCostSourcePricing
      .mockResolvedValueOnce({
        pricePerUnit: 0.05,
        tiers: null,
      })
      .mockResolvedValueOnce({
        pricePerUnit: 0.07,
        tiers: null,
      });

    const firstPricing = await lookupPricing(builderId, [reportedEvent('pages_processed')]);

    expect(firstPricing.metric.get(metricKey('pages_processed'))?.[0]).toMatchObject({
      price_per_unit_usd: 0.05,
      source: 'cost_sources',
    });
    expect(mocks.txExecute).toHaveBeenCalledTimes(1);
    expect(mocks.resolveCostSourcePricing).toHaveBeenCalledTimes(1);

    const secondPricing = await lookupPricing(builderId, [reportedEvent('pages_processed')]);

    expect(mocks.txExecute).toHaveBeenCalledTimes(1);
    expect(mocks.resolveCostSourcePricing).toHaveBeenCalledTimes(2);
    expect(mocks.resolveCostSourcePricing).toHaveBeenLastCalledWith(builderId, 'pages_processed');
    expect(secondPricing.metric.get(metricKey('pages_processed'))?.[0]).toMatchObject({
      price_per_unit_usd: 0.07,
      source: 'cost_sources',
    });
  });

  it('falls back to cost_sources tiered pricing when no custom_pricing row matches', async () => {
    mocks.txExecute.mockResolvedValueOnce([]);
    const tiers = [
      { from: 0, to: 100, price: 0.1 },
      { from: 100, to: null, price: 0.05 },
    ];
    mocks.resolveCostSourcePricing.mockResolvedValueOnce({
      pricePerUnit: null,
      tiers,
    });

    const pricing = await lookupPricing(builderId, [reportedEvent('pages_processed')]);

    expect(mocks.resolveCostSourcePricing).toHaveBeenCalledWith(builderId, 'pages_processed');
    const rows = pricing.metric.get(metricKey('pages_processed'));
    expect(rows).toHaveLength(1);
    expect(rows?.[0]).toMatchObject({ tiers, source: 'cost_sources' });
  });

  it('does NOT consult cost_sources when custom_pricing already matched', async () => {
    mocks.txExecute.mockResolvedValueOnce([
      {
        metric: 'search_query',
        price_per_unit_usd: '0.01',
        effective_from: '2026-01-01T00:00:00.000Z',
        effective_to: null,
      },
    ]);

    await lookupPricing(builderId, [reportedEvent('search_query')]);

    expect(mocks.resolveCostSourcePricing).not.toHaveBeenCalled();
  });

  it('finds custom metric pricing for multiple reported metrics using one IN list', async () => {
    mocks.txExecute.mockResolvedValueOnce([
      {
        metric: 'search_query',
        price_per_unit_usd: '0.01',
        effective_from: '2026-01-01T00:00:00.000Z',
        effective_to: null,
      },
      {
        metric: 'workflow_step',
        price_per_unit_usd: '0.2',
        effective_from: '2026-01-01T00:00:00.000Z',
        effective_to: null,
      },
    ]);

    const pricing = await lookupPricing(builderId, [
      reportedEvent('search_query'),
      reportedEvent('workflow_step'),
    ]);

    expect(pricing.metric.get(metricKey('search_query'))?.[0]?.price_per_unit_usd).toBe(0.01);
    expect(pricing.metric.get(metricKey('workflow_step'))?.[0]?.price_per_unit_usd).toBe(0.2);
    expect(queryText(0)).toContain('builder_id =');
    expect(queryText(0)).toContain('metric IN');
    expect(queryText(0)).not.toContain('ANY');
    expect(mocks.resolveCostSourcePricing).not.toHaveBeenCalled();
  });

  it('finds LLM custom and global pricing with pair-safe provider/model matching', async () => {
    mocks.txExecute
      .mockResolvedValueOnce([
        {
          provider: 'openai',
          model: 'gpt-4o',
          price_per_unit_usd: null,
          input_per_1m_usd: '2',
          output_per_1m_usd: '8',
          effective_from: '2026-01-01T00:00:00.000Z',
          effective_to: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          provider: 'anthropic',
          model: 'claude-3-5-sonnet',
          input_per_1m_usd: '3',
          output_per_1m_usd: '15',
          effective_from: '2026-01-01T00:00:00.000Z',
          effective_to: null,
        },
      ]);

    const pricing = await lookupPricing(builderId, [
      llmEvent('openai', 'gpt-4o'),
      llmEvent('anthropic', 'claude-3-5-sonnet'),
    ]);

    expect(pricing.llm.get(llmKey('openai', 'gpt-4o'))?.[0]).toMatchObject({
      input_per_1m_usd: 2,
      output_per_1m_usd: 8,
      source: 'custom_pricing',
    });
    expect(pricing.llm.get(llmKey('anthropic', 'claude-3-5-sonnet'))?.[0]).toMatchObject({
      input_per_1m_usd: 3,
      output_per_1m_usd: 15,
      source: 'llm_pricing',
    });
    expect(queryText(0)).toContain('(provider, model) IN');
    expect(queryText(1)).toContain('(provider, model) IN');
    expect(queryText(0)).toContain('builder_id =');
    expect(queryText(0)).not.toContain('ANY');
    expect(queryText(1)).not.toContain('ANY');
  });
});
