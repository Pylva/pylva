import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InstrumentationTier, type TelemetryEvent } from '@pylva/shared';
import { calculateCostUsd } from '../../src/lib/cost-calculator.js';

const mocks = vi.hoisted(() => ({
  txExecute: vi.fn(),
  withRLS: vi.fn(),
}));

vi.mock('../../src/lib/db/rls.js', () => ({
  withRLS: mocks.withRLS,
}));

vi.mock('../../src/lib/ingest/cost-source-pricing.js', () => ({
  resolveCostSourcePricing: vi.fn().mockResolvedValue({ pricePerUnit: null, tiers: null }),
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({
      error: vi.fn(),
    }),
  },
}));

const { lookupPricing, resetPricingCaches } =
  await import('../../src/lib/ingest/pricing-lookup.js');

const builderId = '00000000-0000-4000-8000-000000000001';

function queryText(query: unknown): string {
  return JSON.stringify(query, (_key, value) => (typeof value === 'function' ? undefined : value));
}

function llmEvent(timestamp: string): TelemetryEvent {
  return {
    timestamp,
    instrumentation_tier: InstrumentationTier.SDK_WRAPPER,
    provider: 'openai',
    model: 'gpt-versioned',
    tokens_in: 1_000_000,
    tokens_out: 0,
  } as TelemetryEvent;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPricingCaches();
  mocks.withRLS.mockImplementation(
    async (_builderId: string, cb: (tx: unknown) => Promise<unknown>) =>
      cb({ execute: mocks.txExecute }),
  );
});

describe('billing price-version cache', () => {
  it('keeps historical custom prices cached when a current event warms the key first', async () => {
    const oldCustom = {
      provider: 'openai',
      model: 'gpt-versioned',
      price_per_unit_usd: null,
      input_per_1m_usd: '10',
      output_per_1m_usd: '10',
      effective_from: '2026-05-01T00:00:00.000Z',
      effective_to: '2026-06-01T00:00:00.000Z',
    };
    const currentCustom = {
      ...oldCustom,
      input_per_1m_usd: '20',
      output_per_1m_usd: '20',
      effective_from: '2026-06-01T00:00:00.000Z',
      effective_to: null,
    };
    const globalFallback = {
      provider: 'openai',
      model: 'gpt-versioned',
      input_per_1m_usd: '5',
      output_per_1m_usd: '5',
      effective_from: '2026-01-01T00:00:00.000Z',
      effective_to: null,
    };

    mocks.txExecute.mockImplementation((query: unknown) => {
      const text = queryText(query);
      if (text.includes('FROM custom_pricing')) {
        // Model PostgreSQL faithfully: the old implementation bounded this
        // query to the current event and therefore cached only currentCustom.
        return Promise.resolve(
          text.includes('effective_from &lt;=') || text.includes('effective_from <=')
            ? [currentCustom]
            : [oldCustom, currentCustom],
        );
      }
      if (text.includes('FROM llm_pricing')) return Promise.resolve([globalFallback]);
      return Promise.resolve([]);
    });

    await lookupPricing(builderId, [llmEvent('2026-06-15T12:00:00.000Z')]);
    const historical = llmEvent('2026-05-15T12:00:00.000Z');
    const cachedPricing = await lookupPricing(builderId, [historical]);

    // The delayed May event must use the builder's May override ($10/M),
    // not fall through to the public catalog price ($5/M).
    expect(calculateCostUsd(historical, cachedPricing)).toEqual({
      cost_usd: 10,
      pricing_status: 'priced',
    });
    expect(mocks.txExecute).toHaveBeenCalledTimes(2);
  });
});
