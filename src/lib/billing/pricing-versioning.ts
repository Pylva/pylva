// SPDX-License-Identifier: Elastic-2.0
// B2b T2-B — versioned writes + reads for customer_pricing.
//
// I-T2-10 atomicity: every write inserts a new row with `version = prior + 1`
// and closes the prior row's `effective_to = NOW()` inside a single
// transaction. The partial unique index on `(builder_id, customer_id)
// WHERE effective_to IS NULL` guarantees at most one open version per pair.
//
// I-T2-12 undo window: `undoLastVersion` reverts the most recent version
// change if it happened within `maxAgeSeconds`. Past the window returns
// null so the route can emit 410.
//
// Invoice regeneration (I-T2-10 auto-split) reads via `getVersionsInPeriod`
// ordered by effective_from ASC. If N > 1 the generator splits.

import { and, desc, eq, gte, isNull, lt, or } from 'drizzle-orm';
import type { CustomerPricing } from '@pylva/shared';
import { withRLS } from '../db/rls.js';
import { customerPricing } from '../db/schema.js';
import type { PricingUpdateInput } from './pricing-validator.js';

export interface VersionedPricingRow {
  id: string;
  builder_id: string;
  customer_id: string;
  pricing_model: string;
  version: number;
  effective_from: Date;
  effective_to: Date | null;
  flat_rate_usd: string | null;
  per_unit_rates: Record<string, number> | null;
  pack_price_usd: string | null;
  included_credits: string | null;
  overage_rate_usd: string | null;
  markup_pct: string | null;
  base_fee_usd: string | null;
  billing_period: string;
  stripe_customer_id: string | null;
}

/**
 * Convert a DB row (numerics returned as strings by drizzle) into the
 * shared CustomerPricing shape with real numbers. Used by preview +
 * invoice generation. Defined here (not in the callsite) because both
 * the preview endpoint and the invoice generator need it.
 */
export function rowToCustomerPricing(row: VersionedPricingRow): CustomerPricing {
  return {
    id: row.id,
    builder_id: row.builder_id,
    customer_id: row.customer_id,
    pricing_model: row.pricing_model as CustomerPricing['pricing_model'],
    flat_rate_usd: row.flat_rate_usd !== null ? Number(row.flat_rate_usd) : null,
    per_unit_rates: row.per_unit_rates,
    credit_balance: null,
    billing_period: row.billing_period as CustomerPricing['billing_period'],
    stripe_customer_id: row.stripe_customer_id,
    version: row.version,
    effective_from: new Date(row.effective_from).toISOString(),
    effective_to: row.effective_to ? new Date(row.effective_to).toISOString() : null,
    pack_price_usd: row.pack_price_usd !== null ? Number(row.pack_price_usd) : null,
    included_credits: row.included_credits !== null ? Number(row.included_credits) : null,
    overage_rate_usd: row.overage_rate_usd !== null ? Number(row.overage_rate_usd) : null,
    markup_pct: row.markup_pct !== null ? Number(row.markup_pct) : null,
    base_fee_usd: row.base_fee_usd !== null ? Number(row.base_fee_usd) : null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

function projectFieldsForModel(input: PricingUpdateInput): Record<string, unknown> {
  // Start with every model-specific column set to null, then populate the ones
  // this variant carries. Simpler than a switch per column.
  const base = {
    flat_rate_usd: null as string | null,
    per_unit_rates: null as Record<string, number> | null,
    pack_price_usd: null as string | null,
    included_credits: null as string | null,
    overage_rate_usd: null as string | null,
    markup_pct: null as string | null,
    base_fee_usd: null as string | null,
  };

  switch (input.pricing_model) {
    case 'flat':
      return { ...base, flat_rate_usd: String(input.flat_rate_usd) };
    case 'pay_as_you_go':
      return {
        ...base,
        per_unit_rates: input.per_unit_rates,
        markup_pct: String(input.markup_pct ?? 0),
      };
    case 'credit_pack':
      return {
        ...base,
        pack_price_usd: String(input.pack_price_usd),
        included_credits: String(input.included_credits),
        overage_rate_usd: String(input.overage_rate_usd),
      };
    case 'hybrid':
      return {
        ...base,
        base_fee_usd: String(input.base_fee_usd),
        included_credits: String(input.included_credits),
        overage_rate_usd: String(input.overage_rate_usd),
      };
  }
}

/**
 * Insert a new pricing version, closing the prior open row atomically.
 * Returns the new version row (as stored). Throws on RLS violation.
 */
export async function insertNewVersion(params: {
  builderId: string;
  customerId: string;
  input: PricingUpdateInput;
}): Promise<{ version: number; id: string }> {
  const now = new Date();
  return withRLS(params.builderId, async (tx) => {
    const prior = await tx
      .select({
        version: customerPricing.version,
        stripe_customer_id: customerPricing.stripe_customer_id,
      })
      .from(customerPricing)
      .where(
        and(
          eq(customerPricing.builder_id, params.builderId),
          eq(customerPricing.customer_id, params.customerId),
          isNull(customerPricing.effective_to),
        ),
      )
      .limit(1);
    const priorVersion = prior[0]?.version ?? 0;
    const stripeCustomerId = prior[0]?.stripe_customer_id ?? null;

    if (prior.length > 0) {
      await tx
        .update(customerPricing)
        .set({ effective_to: now, updated_at: now })
        .where(
          and(
            eq(customerPricing.builder_id, params.builderId),
            eq(customerPricing.customer_id, params.customerId),
            isNull(customerPricing.effective_to),
          ),
        );
    }

    const fields = projectFieldsForModel(params.input);
    const inserted = await tx
      .insert(customerPricing)
      .values({
        builder_id: params.builderId,
        customer_id: params.customerId,
        pricing_model: params.input.pricing_model,
        billing_period: params.input.billing_period ?? 'monthly',
        version: priorVersion + 1,
        effective_from: now,
        effective_to: null,
        stripe_customer_id: stripeCustomerId,
        created_at: now,
        updated_at: now,
        ...fields,
      })
      .returning({ id: customerPricing.id, version: customerPricing.version });

    return { version: inserted[0]!.version, id: inserted[0]!.id };
  });
}

/** Return the version active at `at` (default: now). Null if none. */
export async function getActiveVersion(params: {
  builderId: string;
  customerId: string;
  at?: Date;
}): Promise<VersionedPricingRow | null> {
  const at = params.at ?? new Date();
  return withRLS(params.builderId, async (tx) => {
    const rows = await tx
      .select()
      .from(customerPricing)
      .where(
        and(
          eq(customerPricing.builder_id, params.builderId),
          eq(customerPricing.customer_id, params.customerId),
          lt(customerPricing.effective_from, at),
          or(isNull(customerPricing.effective_to), gte(customerPricing.effective_to, at)),
        ),
      )
      .orderBy(desc(customerPricing.effective_from))
      .limit(1);
    return (rows[0] as VersionedPricingRow | undefined) ?? null;
  });
}

/**
 * Return every version that overlaps the period [start, end). Ordered by
 * effective_from ASC — the invoice-generator walks this list and, if
 * length > 1, emits auto-split drafts.
 */
export async function getVersionsInPeriod(params: {
  builderId: string;
  customerId: string;
  start: Date;
  end: Date;
}): Promise<VersionedPricingRow[]> {
  return withRLS(params.builderId, async (tx) => {
    const rows = await tx
      .select()
      .from(customerPricing)
      .where(
        and(
          eq(customerPricing.builder_id, params.builderId),
          eq(customerPricing.customer_id, params.customerId),
          lt(customerPricing.effective_from, params.end),
          or(isNull(customerPricing.effective_to), gte(customerPricing.effective_to, params.start)),
        ),
      )
      .orderBy(customerPricing.effective_from);
    return rows as VersionedPricingRow[];
  });
}

/** Full version history for a customer (UI + audit). Newest first. */
export async function getAllVersions(params: {
  builderId: string;
  customerId: string;
  limit?: number;
}): Promise<VersionedPricingRow[]> {
  const limit = params.limit ?? 100;
  return withRLS(params.builderId, async (tx) => {
    const rows = await tx
      .select()
      .from(customerPricing)
      .where(
        and(
          eq(customerPricing.builder_id, params.builderId),
          eq(customerPricing.customer_id, params.customerId),
        ),
      )
      .orderBy(desc(customerPricing.version))
      .limit(limit);
    return rows as VersionedPricingRow[];
  });
}

/**
 * I-T2-12: Revert the most-recent version change within `maxAgeSeconds`.
 * If the newest version's `effective_from` is older than the window → returns
 * null (route emits 410 gone). Otherwise deletes the newest row and reopens
 * the prior one (effective_to = NULL), all transactional.
 */
export async function undoLastVersion(params: {
  builderId: string;
  customerId: string;
  maxAgeSeconds: number;
  now?: Date;
}): Promise<{ restoredVersion: number | null } | null> {
  const now = params.now ?? new Date();
  return withRLS(params.builderId, async (tx) => {
    const latest = await tx
      .select({
        id: customerPricing.id,
        version: customerPricing.version,
        effective_from: customerPricing.effective_from,
      })
      .from(customerPricing)
      .where(
        and(
          eq(customerPricing.builder_id, params.builderId),
          eq(customerPricing.customer_id, params.customerId),
        ),
      )
      .orderBy(desc(customerPricing.version))
      .limit(1);

    if (latest.length === 0) return null;
    const newest = latest[0]!;

    const ageSeconds = (now.getTime() - new Date(newest.effective_from).getTime()) / 1000;
    if (ageSeconds > params.maxAgeSeconds) return null;

    await tx.delete(customerPricing).where(eq(customerPricing.id, newest.id));

    if (newest.version > 1) {
      // Reopen the prior version.
      const priorVersion = newest.version - 1;
      await tx
        .update(customerPricing)
        .set({ effective_to: null, updated_at: now })
        .where(
          and(
            eq(customerPricing.builder_id, params.builderId),
            eq(customerPricing.customer_id, params.customerId),
            eq(customerPricing.version, priorVersion),
          ),
        );
      return { restoredVersion: priorVersion };
    }

    // No prior — we deleted the only row. Caller may want to treat this as
    // "pricing cleared"; we surface `null` so the UI can decide.
    return { restoredVersion: null };
  });
}
