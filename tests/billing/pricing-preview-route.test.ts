import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  builderId: '00000000-0000-4000-8000-000000000001',
  customerId: '11111111-1111-4111-8111-111111111111',
  externalId: 'lg_invoice_recon_cust_1',
  resolveCustomerComposite: vi.fn(),
  getActiveVersion: vi.fn(),
  getUsageForPeriod: vi.fn(),
}));

vi.mock('@/lib/auth/builder-context', () => ({
  readBuilderContextFromDashboard: () => ({
    builderId: mocks.builderId,
    userId: null,
    role: 'owner',
  }),
}));

vi.mock('@/lib/auth/tier-enforcement', () => ({
  checkBuilderFeatureGate: () => Promise.resolve(null),
}));

vi.mock('@/lib/clickhouse/customer-id', () => ({
  resolveCustomerComposite: mocks.resolveCustomerComposite,
}));

vi.mock('@/lib/billing/pricing-versioning', () => {
  return {
    getActiveVersion: mocks.getActiveVersion,
    rowToCustomerPricing: (row: Record<string, unknown>) => ({
      id: row['id'],
      builder_id: row['builder_id'],
      customer_id: row['customer_id'],
      pricing_model: row['pricing_model'],
      flat_rate_usd:
        row['flat_rate_usd'] === null || row['flat_rate_usd'] === undefined
          ? null
          : Number(row['flat_rate_usd']),
      per_unit_rates: row['per_unit_rates'],
      credit_balance: null,
      billing_period: row['billing_period'],
      stripe_customer_id: row['stripe_customer_id'],
      version: row['version'],
      effective_from: new Date(row['effective_from'] as Date).toISOString(),
      effective_to: row['effective_to'] ? new Date(row['effective_to'] as Date).toISOString() : null,
      pack_price_usd:
        row['pack_price_usd'] === null || row['pack_price_usd'] === undefined
          ? null
          : Number(row['pack_price_usd']),
      included_credits:
        row['included_credits'] === null || row['included_credits'] === undefined
          ? null
          : Number(row['included_credits']),
      overage_rate_usd:
        row['overage_rate_usd'] === null || row['overage_rate_usd'] === undefined
          ? null
          : Number(row['overage_rate_usd']),
      markup_pct:
        row['markup_pct'] === null || row['markup_pct'] === undefined
          ? null
          : Number(row['markup_pct']),
      base_fee_usd:
        row['base_fee_usd'] === null || row['base_fee_usd'] === undefined
          ? null
          : Number(row['base_fee_usd']),
      created_at: new Date(),
      updated_at: new Date(),
    }),
  };
});

vi.mock('@/lib/billing/clickhouse-usage', () => ({
  getUsageForPeriod: mocks.getUsageForPeriod,
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    child: () => ({
      error: () => undefined,
    }),
  },
}));

const { GET } = await import('../../src/app/api/v1/billing/pricing/preview/route.js');

function makeRequest(proposed: Record<string, unknown>) {
  const url = new URL('http://localhost/api/v1/billing/pricing/preview');
  url.searchParams.set('customer_id', mocks.customerId);
  url.searchParams.set('proposed', Buffer.from(JSON.stringify(proposed)).toString('base64'));
  return new Request(url) as unknown as import('next/server.js').NextRequest;
}

function activePayAsYouGoRow() {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    builder_id: mocks.builderId,
    customer_id: mocks.customerId,
    pricing_model: 'pay_as_you_go',
    version: 1,
    effective_from: new Date('2026-06-01T00:00:00Z'),
    effective_to: null,
    flat_rate_usd: null,
    per_unit_rates: { input_tokens: 0.01, output_tokens: 0.02 },
    pack_price_usd: null,
    included_credits: null,
    overage_rate_usd: null,
    markup_pct: '10',
    base_fee_usd: null,
    billing_period: 'monthly',
    stripe_customer_id: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveCustomerComposite.mockResolvedValue(`${mocks.builderId}:${mocks.externalId}`);
  mocks.getActiveVersion.mockResolvedValue(activePayAsYouGoRow());
  mocks.getUsageForPeriod.mockResolvedValue({
    by_model: {},
    by_metric: {
      input_tokens: 2300,
      output_tokens: 620,
    },
    has_unpriced: false,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/v1/billing/pricing/preview', () => {
  it('resolves internal customer ids to ClickHouse composite ids before usage lookup', async () => {
    const res = await GET(
      makeRequest({
        pricing_model: 'pay_as_you_go',
        billing_period: 'monthly',
        per_unit_rates: { input_tokens: 0.02, output_tokens: 0.04 },
        markup_pct: 0,
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mocks.resolveCustomerComposite).toHaveBeenCalledWith(mocks.builderId, mocks.customerId);
    expect(mocks.getUsageForPeriod).toHaveBeenCalledWith(
      expect.objectContaining({
        builderId: mocks.builderId,
        customerId: `${mocks.builderId}:${mocks.externalId}`,
      }),
    );
    expect(body.current.amount_usd).toBe(38.94);
    expect(body.proposed.amount_usd).toBe(70.8);
    expect(body.delta_usd).toBe(31.86);
  });

  it('extends the preview window by one second to include current-second ClickHouse rows', async () => {
    const now = new Date('2026-06-25T12:00:00.900Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const res = await GET(
      makeRequest({
        pricing_model: 'pay_as_you_go',
        billing_period: 'monthly',
        per_unit_rates: { input_tokens: 0.02, output_tokens: 0.04 },
        markup_pct: 0,
      }),
    );

    expect(res.status).toBe(200);
    const usageParams = mocks.getUsageForPeriod.mock.calls[0]?.[0] as { from: Date; to: Date };
    expect(usageParams.to.toISOString()).toBe('2026-06-25T12:00:01.900Z');
    expect(usageParams.from.toISOString()).toBe('2026-05-26T12:00:01.900Z');
  });
});
