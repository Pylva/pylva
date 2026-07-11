// Row factories for dashboard table tests (page-level RSC tests and, mirrored
// by value, the e2e fixture seed). Follows the `row(overrides)` builder style
// from tests/frontend/cost-sources-control.test.tsx.
//
// Edge fixtures exercised across suites: very long customer ids (from the bug
// report screenshots), Arabic ids/descriptions (RTL is a product constraint),
// zero values, null model/last_seen, and huge numbers.

import type {
  CustomerSummaryRow,
  ModelBreakdownRow,
} from '../../src/lib/clickhouse/dashboard-queries.js';
import type { InvoiceLineItem } from '@pylva/shared';
import type { VersionedPricingRow } from '../../src/lib/billing/pricing-versioning.js';

export const LONG_CUSTOMER_ID = 'pylva-cutover-1782093690217';
export const ARABIC_CUSTOMER_ID = 'عميل-الشركة-السعودية';

export function customerSummaryRow(
  overrides: Partial<CustomerSummaryRow> = {},
): CustomerSummaryRow {
  return {
    customer_id: 'acme-corp',
    total_spend_usd: 1234.5678,
    event_count: 4821,
    last_seen_at: '2026-07-08T10:00:00.000Z',
    ...overrides,
  };
}

export const longIdCustomerRow = (): CustomerSummaryRow =>
  customerSummaryRow({ customer_id: LONG_CUSTOMER_ID });

export const arabicCustomerRow = (): CustomerSummaryRow =>
  customerSummaryRow({ customer_id: ARABIC_CUSTOMER_ID, total_spend_usd: 42.5 });

export const zeroCustomerRow = (): CustomerSummaryRow =>
  customerSummaryRow({ customer_id: 'zero-usage', total_spend_usd: 0, event_count: 0, last_seen_at: null });

export const hugeCustomerRow = (): CustomerSummaryRow =>
  customerSummaryRow({ customer_id: 'whale-corp', total_spend_usd: 9876543.21, event_count: 12345678 });

export function modelBreakdownRow(overrides: Partial<ModelBreakdownRow> = {}): ModelBreakdownRow {
  return {
    provider: 'openai',
    model: 'gpt-4o',
    total_spend_usd: 12.3456789,
    tokens_in: 1234567,
    tokens_out: 98765,
    call_count: 4321,
    avg_usd_per_call: 0.0029,
    ...overrides,
  };
}

export const nullModelRow = (): ModelBreakdownRow =>
  modelBreakdownRow({ provider: 'other', model: null, total_spend_usd: 0.048, avg_usd_per_call: 0 });

export const hugeTokensRow = (): ModelBreakdownRow =>
  modelBreakdownRow({ provider: 'anthropic', model: 'claude-haiku-4-5', tokens_in: 1_234_567_890 });

// Drizzle select() shape for `invoices` — numerics come back as STRINGS
// (pg numeric), timestamps as Date. Only the columns the pages read.
export interface InvoiceFixtureRow {
  id: string;
  builder_id: string;
  customer_id: string;
  amount_usd: string;
  status: string;
  billing_cycle_id: string | null;
  has_unpriced_events: boolean;
  created_at: Date;
  period_start: Date;
  period_end: Date;
  pricing_version: number | null;
  stripe_invoice_id: string | null;
  line_items: InvoiceLineItem[];
}

export function invoiceRow(overrides: Partial<InvoiceFixtureRow> = {}): InvoiceFixtureRow {
  return {
    id: 'e2e00000-0000-4000-8000-000000000001',
    builder_id: 'builder-1',
    customer_id: 'c0ffee00-0000-4000-8000-000000000001',
    amount_usd: '42.50',
    status: 'paid',
    billing_cycle_id: null,
    has_unpriced_events: false,
    created_at: new Date('2026-06-15T12:00:00.000Z'),
    period_start: new Date('2026-06-01T00:00:00.000Z'),
    period_end: new Date('2026-07-01T00:00:00.000Z'),
    pricing_version: 2,
    stripe_invoice_id: null,
    line_items: [],
    ...overrides,
  };
}

export function lineItem(overrides: Partial<InvoiceLineItem> = {}): InvoiceLineItem {
  return {
    description: 'GPT-4o input tokens',
    metric: 'tokens_in',
    quantity: 1_250_000,
    unit_price_usd: 0.0000025,
    total_usd: 3.125,
    pricing_version: 2,
    ...overrides,
  };
}

export const arabicLineItem = (): InvoiceLineItem =>
  lineItem({ description: 'تكلفة الاستدعاءات', metric: 'api_calls', quantity: 120, total_usd: 6 });

export const zeroQuantityLineItem = (): InvoiceLineItem =>
  lineItem({ description: 'Unused credit pack', quantity: 0, total_usd: 0 });

export function pricingVersionRow(
  overrides: Partial<VersionedPricingRow> = {},
): VersionedPricingRow {
  return {
    id: 'ver00000-0000-4000-8000-000000000001',
    builder_id: 'builder-1',
    customer_id: 'c0ffee00-0000-4000-8000-000000000001',
    pricing_model: 'flat_rate',
    version: 1,
    effective_from: new Date('2026-05-01T00:00:00.000Z'),
    effective_to: new Date('2026-06-01T00:00:00.000Z'),
    flat_rate_usd: '99.00',
    per_unit_rates: null,
    pack_price_usd: null,
    included_credits: null,
    overage_rate_usd: null,
    markup_pct: null,
    base_fee_usd: null,
    billing_period: 'monthly',
    stripe_customer_id: null,
    ...overrides,
  };
}

export const openEndedPricingVersionRow = (): VersionedPricingRow =>
  pricingVersionRow({
    id: 'ver00000-0000-4000-8000-000000000002',
    version: 2,
    effective_from: new Date('2026-06-01T00:00:00.000Z'),
    effective_to: null,
  });
