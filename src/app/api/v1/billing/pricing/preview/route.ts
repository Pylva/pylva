// SPDX-License-Identifier: Elastic-2.0
// B2b T2-B — GET /api/v1/billing/pricing/preview
//
// I-T2-11 side-effect-free: no DB writes, no Stripe calls. Reads last-30-day
// priced usage from cost_events, applies the active version and a proposed
// version, returns delta.
//
// Query params:
//   customer_id — UUID
//   proposed    — base64-encoded JSON matching pricingUpdateSchema
//
// Decision D11: inline panel (not modal). The client component fetches this
// on every form change; endpoint must stay fast (<200ms typical).

import { NextResponse, type NextRequest } from 'next/server.js';
import * as v from 'valibot';
import { ErrorCode, type PricingPreviewResponse, type CustomerPricing } from '@pylva/shared';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { checkBuilderFeatureGate } from '@/lib/auth/tier-enforcement';
import { validationError, notFoundError, internalError } from '@/lib/errors';
import { applyFormula } from '@/lib/billing/formulas';
import { getUsageForPeriod } from '@/lib/billing/clickhouse-usage';
import { pricingUpdateSchema, type PricingUpdateInput } from '@/lib/billing/pricing-validator';
import { getActiveVersion, rowToCustomerPricing } from '@/lib/billing/pricing-versioning';
import { resolveCustomerComposite } from '@/lib/clickhouse/customer-id';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'billing.preview' });

const PREVIEW_WINDOW_DAYS = 30;
const PREVIEW_END_GRACE_MS = 1_000;

function decodeProposed(raw: string): PricingUpdateInput | null {
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf-8');
    const obj = JSON.parse(decoded) as unknown;
    const parsed = v.safeParse(pricingUpdateSchema, obj);
    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
}

function proposedToCustomerPricing(
  input: PricingUpdateInput,
  baseVersion: number,
): CustomerPricing {
  const skeleton: CustomerPricing = {
    id: 'preview-proposed',
    builder_id: 'preview',
    customer_id: 'preview',
    pricing_model: input.pricing_model,
    flat_rate_usd: null,
    per_unit_rates: null,
    credit_balance: null,
    billing_period: input.billing_period ?? 'monthly',
    stripe_customer_id: null,
    version: baseVersion + 1,
    effective_from: new Date().toISOString(),
    effective_to: null,
    pack_price_usd: null,
    included_credits: null,
    overage_rate_usd: null,
    markup_pct: null,
    base_fee_usd: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
  switch (input.pricing_model) {
    case 'flat':
      return { ...skeleton, flat_rate_usd: input.flat_rate_usd };
    case 'pay_as_you_go':
      return {
        ...skeleton,
        per_unit_rates: input.per_unit_rates,
        markup_pct: input.markup_pct ?? 0,
      };
    case 'credit_pack':
      return {
        ...skeleton,
        pack_price_usd: input.pack_price_usd,
        included_credits: input.included_credits,
        overage_rate_usd: input.overage_rate_usd,
      };
    case 'hybrid':
      return {
        ...skeleton,
        base_fee_usd: input.base_fee_usd,
        included_credits: input.included_credits,
        overage_rate_usd: input.overage_rate_usd,
      };
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;
  const tierGate = await checkBuilderFeatureGate(ctx.builderId, 'billing');
  if (tierGate) return tierGate;

  const url = new URL(request.url);
  const customerId = url.searchParams.get('customer_id');
  const proposedRaw = url.searchParams.get('proposed');

  if (!customerId || !v.is(v.pipe(v.string(), v.uuid()), customerId)) {
    return validationError('Missing or invalid customer_id', 'customer_id');
  }
  if (!proposedRaw) {
    return validationError('Missing proposed pricing (base64 JSON)', 'proposed');
  }
  const proposed = decodeProposed(proposedRaw);
  if (!proposed) {
    return validationError('proposed pricing failed schema validation', 'proposed');
  }

  try {
    // ClickHouse stores cost_events.timestamp as DateTime seconds and
    // getUsageForPeriod uses an exclusive upper bound. Include the current
    // second so a preview requested immediately after ingest does not look
    // empty until the clock ticks.
    const to = new Date(Date.now() + PREVIEW_END_GRACE_MS);
    const from = new Date(to.getTime() - PREVIEW_WINDOW_DAYS * 86_400_000);

    const [activeRow, compositeCustomerId] = await Promise.all([
      getActiveVersion({ builderId: ctx.builderId, customerId }),
      resolveCustomerComposite(ctx.builderId, customerId),
    ]);

    if (!activeRow) {
      return notFoundError(
        ErrorCode.NOT_FOUND,
        'No active pricing for this customer — configure a baseline first',
      );
    }
    if (!compositeCustomerId) {
      return notFoundError(ErrorCode.NOT_FOUND, 'Customer not found');
    }

    const usage = await getUsageForPeriod({
      builderId: ctx.builderId,
      customerId: compositeCustomerId,
      from,
      to,
    });

    const currentPricing = rowToCustomerPricing(activeRow);
    const proposedPricing = proposedToCustomerPricing(proposed, activeRow.version);

    const currentResult = applyFormula(currentPricing, usage);
    const proposedResult = applyFormula(proposedPricing, usage);

    const response: PricingPreviewResponse = {
      current: { amount_usd: currentResult.amount_usd, line_items: currentResult.line_items },
      proposed: { amount_usd: proposedResult.amount_usd, line_items: proposedResult.line_items },
      delta_usd: Math.round((proposedResult.amount_usd - currentResult.amount_usd) * 100) / 100,
      sample_period_start: from.toISOString(),
      sample_period_end: to.toISOString(),
    };

    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { builder_id: ctx.builderId, customer_id: customerId, error: message },
      'preview failed',
    );
    return internalError('Failed to compute pricing preview');
  }
}
