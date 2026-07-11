// B2b T2-B — formula correctness tests (I-T2-2).
//
// Drives all four formulas from the canonical contract fixture at
// tests/contracts/invoice-payload-contract.json. Every fixture's
// expected.amount_usd + line_items must match applyFormula() output
// exactly. If this test fails, either the formula regressed or the
// fixture was updated — investigate before touching either side.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyFormula, type UsageAggregate } from '../../src/lib/billing/formulas.js';
import type { CustomerPricing } from '@pylva/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, '..', 'contracts', 'invoice-payload-contract.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as {
  fixtures: Array<{
    name: string;
    description: string;
    pricing: Partial<CustomerPricing>;
    usage: UsageAggregate;
    expected: {
      amount_usd: number;
      line_items: Array<Record<string, unknown>>;
      has_unpriced_events: boolean;
    };
  }>;
};

// Fill in the DB-only fields with defaults so we can satisfy the full
// CustomerPricing shape without leaking test boilerplate into formulas.ts.
function toPricing(partial: Partial<CustomerPricing>): CustomerPricing {
  return {
    id: 'pricing-fixture',
    builder_id: 'builder-fixture',
    customer_id: 'customer-fixture',
    pricing_model: partial.pricing_model ?? 'flat',
    flat_rate_usd: partial.flat_rate_usd ?? null,
    per_unit_rates: partial.per_unit_rates ?? null,
    credit_balance: partial.credit_balance ?? null,
    billing_period: partial.billing_period ?? 'monthly',
    stripe_customer_id: partial.stripe_customer_id ?? null,
    version: partial.version ?? 1,
    effective_from: partial.effective_from ?? '2026-01-01T00:00:00.000Z',
    effective_to: partial.effective_to ?? null,
    pack_price_usd: partial.pack_price_usd ?? null,
    included_credits: partial.included_credits ?? null,
    overage_rate_usd: partial.overage_rate_usd ?? null,
    markup_pct: partial.markup_pct ?? null,
    base_fee_usd: partial.base_fee_usd ?? null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

describe('applyFormula() — contract fixture oracle (I-T2-2)', () => {
  for (const fx of fixture.fixtures) {
    it(`${fx.name}: ${fx.description}`, () => {
      const pricing = toPricing(fx.pricing);
      const result = applyFormula(pricing, fx.usage);

      expect(result.amount_usd).toBe(fx.expected.amount_usd);
      expect(result.has_unpriced_events).toBe(fx.expected.has_unpriced_events);
      expect(result.line_items).toHaveLength(fx.expected.line_items.length);

      fx.expected.line_items.forEach((expectedLine, i) => {
        expect(result.line_items[i]).toMatchObject(expectedLine);
      });
    });
  }
});
