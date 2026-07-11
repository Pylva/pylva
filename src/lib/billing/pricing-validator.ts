// SPDX-License-Identifier: Elastic-2.0
// B2b T2-B — Valibot schema for CustomerPricing writes.
//
// Discriminated by `pricing_model` so each variant only accepts the fields
// relevant to its model. Used by POST /api/v1/customers/[id]/pricing to
// validate a new version before it hits `insertNewVersion`.
//
// Matches spec §3.1 (pricing model kinds) + migration 022 (column set) +
// the shape defined in packages/shared/src/types/billing.ts.

import * as v from 'valibot';
import { PricingModel } from '@pylva/shared';

// All rates + amounts must be non-negative. Upper bounds match PG column
// precision: DECIMAL(10,2) = up to $99,999,999.99; DECIMAL(18,4)/DECIMAL(18,10)
// are narrower in scale but wider in magnitude — we pick reasonable max
// product-sensible limits, not column limits.
const nonNegativeUsd = v.pipe(v.number(), v.minValue(0), v.maxValue(10_000_000));
const nonNegativeCredits = v.pipe(v.number(), v.minValue(0), v.maxValue(1e12));
const pct0to1000 = v.pipe(v.number(), v.minValue(0), v.maxValue(1000)); // 1000% cap
const overageRate = v.pipe(v.number(), v.minValue(0), v.maxValue(10_000)); // per-unit

const billingPeriod = v.picklist(['monthly', 'weekly', 'custom'] as const);

// Shared shape: every variant carries model + billing_period. The rest are
// variant-specific and enforced by the `v.variant` discriminator below.
const flatSchema = v.object({
  pricing_model: v.literal(PricingModel.FLAT),
  billing_period: v.optional(billingPeriod, 'monthly'),
  flat_rate_usd: nonNegativeUsd,
});

const payAsYouGoSchema = v.object({
  pricing_model: v.literal(PricingModel.PAY_AS_YOU_GO),
  billing_period: v.optional(billingPeriod, 'monthly'),
  per_unit_rates: v.pipe(
    v.record(v.string(), overageRate),
    v.check((m) => Object.keys(m).length > 0, 'per_unit_rates must have ≥1 metric'),
  ),
  markup_pct: v.optional(pct0to1000, 0),
});

const creditPackSchema = v.object({
  pricing_model: v.literal(PricingModel.CREDIT_PACK),
  billing_period: v.optional(billingPeriod, 'monthly'),
  pack_price_usd: nonNegativeUsd,
  included_credits: nonNegativeCredits,
  overage_rate_usd: overageRate,
});

const hybridSchema = v.object({
  pricing_model: v.literal(PricingModel.HYBRID),
  billing_period: v.optional(billingPeriod, 'monthly'),
  base_fee_usd: nonNegativeUsd,
  included_credits: nonNegativeCredits,
  overage_rate_usd: overageRate,
});

export const pricingUpdateSchema = v.variant('pricing_model', [
  flatSchema,
  payAsYouGoSchema,
  creditPackSchema,
  hybridSchema,
]);

export type PricingUpdateInput = v.InferOutput<typeof pricingUpdateSchema>;
