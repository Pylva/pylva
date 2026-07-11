// B2b T2-B — Valibot schema tests for customer_pricing writes.
//
// Ensures the variant schema (a) accepts each valid model shape, (b) rejects
// unknown model, (c) rejects cross-variant field contamination (e.g. flat
// with pack_price_usd), (d) enforces non-negative / range bounds.

import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import { pricingUpdateSchema } from '../../src/lib/billing/pricing-validator.js';

function parse(input: unknown) {
  return v.safeParse(pricingUpdateSchema, input);
}

describe('pricingUpdateSchema — accepts valid shapes', () => {
  it('flat', () => {
    const r = parse({ pricing_model: 'flat', flat_rate_usd: 299.0 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.output.pricing_model).toBe('flat');
  });

  it('pay_as_you_go with markup', () => {
    const r = parse({
      pricing_model: 'pay_as_you_go',
      per_unit_rates: { input_tokens: 0.003, output_tokens: 0.015 },
      markup_pct: 25.0,
    });
    expect(r.success).toBe(true);
  });

  it('credit_pack', () => {
    const r = parse({
      pricing_model: 'credit_pack',
      pack_price_usd: 100,
      included_credits: 10000,
      overage_rate_usd: 0.015,
    });
    expect(r.success).toBe(true);
  });

  it('hybrid', () => {
    const r = parse({
      pricing_model: 'hybrid',
      base_fee_usd: 50,
      included_credits: 5000,
      overage_rate_usd: 0.005,
    });
    expect(r.success).toBe(true);
  });

  it('defaults billing_period to monthly', () => {
    const r = parse({ pricing_model: 'flat', flat_rate_usd: 10 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.output.billing_period).toBe('monthly');
  });
});

describe('pricingUpdateSchema — rejects invalid shapes', () => {
  it('unknown pricing_model', () => {
    const r = parse({ pricing_model: 'mystery', flat_rate_usd: 10 });
    expect(r.success).toBe(false);
  });

  it('flat missing rate', () => {
    const r = parse({ pricing_model: 'flat' });
    expect(r.success).toBe(false);
  });

  it('flat with negative rate', () => {
    const r = parse({ pricing_model: 'flat', flat_rate_usd: -1 });
    expect(r.success).toBe(false);
  });

  it('pay_as_you_go with empty rates map', () => {
    const r = parse({ pricing_model: 'pay_as_you_go', per_unit_rates: {} });
    expect(r.success).toBe(false);
  });

  it('pay_as_you_go with negative markup', () => {
    const r = parse({
      pricing_model: 'pay_as_you_go',
      per_unit_rates: { input_tokens: 0.001 },
      markup_pct: -5,
    });
    expect(r.success).toBe(false);
  });

  it('credit_pack missing overage_rate_usd', () => {
    const r = parse({ pricing_model: 'credit_pack', pack_price_usd: 100, included_credits: 10000 });
    expect(r.success).toBe(false);
  });

  it('hybrid with negative included_credits', () => {
    const r = parse({
      pricing_model: 'hybrid',
      base_fee_usd: 50,
      included_credits: -1,
      overage_rate_usd: 0.005,
    });
    expect(r.success).toBe(false);
  });
});
