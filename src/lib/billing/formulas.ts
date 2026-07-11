// SPDX-License-Identifier: Elastic-2.0
// B2b T2-B — pricing formulas. Pure, side-effect-free.
//
// Each function takes (pricing row, usage aggregate) and returns the invoice
// amount + line items. Oracle truth: tests/contracts/invoice-payload-contract.json.
//
// I-T2-2 (formula correctness): tested with ≥3 fixtures per pricing model +
// edges (0-value, boundary of included_credits, float-precision).
//
// Float handling: all boundary rounding uses `roundUsd(x)` = Math.round(x*100)/100.
// PG column is DECIMAL(10,2); Stripe invoice amounts are integer cents — the
// conversion happens at the persistence boundary, not here.

import type { CustomerPricing, InvoiceLineItem } from '@pylva/shared';

export interface UsageAggregate {
  /** usage keyed by provider/model pair — reserved for future per-model pricing. */
  by_model: Record<string, number>;
  /** usage keyed by metric (e.g. input_tokens, output_tokens, credits). */
  by_metric: Record<string, number>;
  /** true if any event in the period had pricing_status != 'priced'. */
  has_unpriced: boolean;
}

export interface FormulaResult {
  amount_usd: number;
  line_items: InvoiceLineItem[];
  has_unpriced_events: boolean;
}

/** Round to 2 decimal places (cents). Stable across the test fixtures. */
export function roundUsd(x: number): number {
  return Math.round(x * 100) / 100;
}

function withVersion(
  line: Omit<InvoiceLineItem, 'pricing_version'>,
  version: number,
): InvoiceLineItem {
  return { ...line, pricing_version: version };
}

/** Flat: single monthly fee, ignores usage. */
export function computeFlat(pricing: CustomerPricing, usage: UsageAggregate): FormulaResult {
  const rate = pricing.flat_rate_usd ?? 0;
  const amount = roundUsd(rate);
  return {
    amount_usd: amount,
    line_items: [
      withVersion(
        {
          description: 'Flat monthly fee',
          metric: 'base',
          quantity: 1,
          unit_price_usd: amount,
          total_usd: amount,
        },
        pricing.version,
      ),
    ],
    has_unpriced_events: usage.has_unpriced,
  };
}

/** Pay-as-you-go: Σ (qty × rate per metric) + optional markup. */
export function computePayAsYouGo(pricing: CustomerPricing, usage: UsageAggregate): FormulaResult {
  const rates = pricing.per_unit_rates ?? {};
  const markupPct = pricing.markup_pct ?? 0;

  const lines: InvoiceLineItem[] = [];
  let subtotal = 0;

  for (const [metric, quantity] of Object.entries(usage.by_metric)) {
    const unit = rates[metric];
    if (unit === undefined || quantity === 0) continue;
    const total = roundUsd(quantity * unit);
    subtotal += total;
    lines.push(
      withVersion(
        { description: metric, metric, quantity, unit_price_usd: unit, total_usd: total },
        pricing.version,
      ),
    );
  }

  let amount = roundUsd(subtotal);
  if (markupPct > 0 && subtotal > 0) {
    const markupAmount = roundUsd(subtotal * (markupPct / 100));
    amount = roundUsd(subtotal + markupAmount);
    lines.push(
      withVersion(
        {
          description: `Markup (${markupPct}%)`,
          metric: 'markup',
          quantity: 1,
          unit_price_usd: markupAmount,
          total_usd: markupAmount,
        },
        pricing.version,
      ),
    );
  }

  return { amount_usd: amount, line_items: lines, has_unpriced_events: usage.has_unpriced };
}

/** Credit pack: fixed pack price + overage if usage > included credits. */
export function computeCreditPack(pricing: CustomerPricing, usage: UsageAggregate): FormulaResult {
  const packPrice = pricing.pack_price_usd ?? 0;
  const included = pricing.included_credits ?? 0;
  const overageRate = pricing.overage_rate_usd ?? 0;
  const used = usage.by_metric['credits'] ?? 0;

  const lines: InvoiceLineItem[] = [
    withVersion(
      {
        description: `Credit pack (${included} credits)`,
        metric: 'pack',
        quantity: 1,
        unit_price_usd: roundUsd(packPrice),
        total_usd: roundUsd(packPrice),
      },
      pricing.version,
    ),
  ];

  let amount = roundUsd(packPrice);
  if (used > included) {
    const overQty = used - included;
    const overTotal = roundUsd(overQty * overageRate);
    amount = roundUsd(packPrice + overTotal);
    lines.push(
      withVersion(
        {
          description: `Overage (${overQty} credits @ $${overageRate})`,
          metric: 'overage',
          quantity: overQty,
          unit_price_usd: overageRate,
          total_usd: overTotal,
        },
        pricing.version,
      ),
    );
  }

  return { amount_usd: amount, line_items: lines, has_unpriced_events: usage.has_unpriced };
}

/** Hybrid: base fee + included credits + overage. Base always a line item. */
export function computeHybrid(pricing: CustomerPricing, usage: UsageAggregate): FormulaResult {
  const baseFee = pricing.base_fee_usd ?? 0;
  const included = pricing.included_credits ?? 0;
  const overageRate = pricing.overage_rate_usd ?? 0;
  const used = usage.by_metric['credits'] ?? 0;

  const lines: InvoiceLineItem[] = [
    withVersion(
      {
        description: 'Base fee',
        metric: 'base',
        quantity: 1,
        unit_price_usd: roundUsd(baseFee),
        total_usd: roundUsd(baseFee),
      },
      pricing.version,
    ),
  ];

  let amount = roundUsd(baseFee);
  if (used > included) {
    const overQty = used - included;
    const overTotal = roundUsd(overQty * overageRate);
    amount = roundUsd(baseFee + overTotal);
    lines.push(
      withVersion(
        {
          description: `Overage (${overQty} credits @ $${overageRate})`,
          metric: 'overage',
          quantity: overQty,
          unit_price_usd: overageRate,
          total_usd: overTotal,
        },
        pricing.version,
      ),
    );
  }

  return { amount_usd: amount, line_items: lines, has_unpriced_events: usage.has_unpriced };
}

/** Dispatch by pricing_model. Single entry point used by invoice-generator + preview. */
export function applyFormula(pricing: CustomerPricing, usage: UsageAggregate): FormulaResult {
  switch (pricing.pricing_model) {
    case 'flat':
      return computeFlat(pricing, usage);
    case 'pay_as_you_go':
      return computePayAsYouGo(pricing, usage);
    case 'credit_pack':
      return computeCreditPack(pricing, usage);
    case 'hybrid':
      return computeHybrid(pricing, usage);
  }
}
