// Track 2 PR 2.4 — cost_sources pricing fallback for REPORTED events.
//
// Per internal design notes (O17):
// when an event's `metric` doesn't match a custom_pricing row, fall back
// to the builder-owned `cost_sources` row matched by metric (or slug).
//
// Cache TTL = 60 seconds (per O17). D9 future-only semantics make this
// window safe without pub/sub invalidation. We treat tiered pricing as
// a v2 follow-up: the inline `tiered_unsupported` branch returns null
// so the event continues to fall back to custom_pricing → needs_pricing.

import { sql } from 'drizzle-orm';
import { withRLS } from '../db/rls.js';
import { unwrapRows } from '../db/query-utils.js';
import { logger } from '../logger.js';
import type { PricingTier } from '@pylva/shared';

const log = logger.child({ module: 'ingest.cost-source-pricing' });

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  pricePerUnit: number | null;
  tiers: PricingTier[] | null;
  expiresAt: number;
}

// Key: `${builderId}:${metric}`
const cache = new Map<string, CacheEntry>();

export function resetCostSourcePricingCache(): void {
  cache.clear();
}

export interface CostSourcePricingResult {
  /** Flat price per unit, when configured. */
  pricePerUnit: number | null;
  /** Tier table (sorted by `from`), when configured. Resolves via priceForUnits. */
  tiers: PricingTier[] | null;
}

/**
 * Resolve cost-source pricing for one (builder, metric) pair. Returns
 * { pricePerUnit: null, tiers: null } when no row matches. Cached at 60s
 * TTL per O17.
 */
export async function resolveCostSourcePricing(
  builderId: string,
  metric: string,
): Promise<CostSourcePricingResult> {
  const key = `${builderId}:${metric}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { pricePerUnit: cached.pricePerUnit, tiers: cached.tiers };
  }

  let result: CostSourcePricingResult = { pricePerUnit: null, tiers: null };
  try {
    await withRLS(builderId, async (tx) => {
      const rows = unwrapRows<{
        price_per_unit: string | null;
        pricing_tiers: unknown;
      }>(
        await tx.execute<{
          price_per_unit: string | null;
          pricing_tiers: unknown;
        }>(sql`
          SELECT price_per_unit::text AS price_per_unit, pricing_tiers
          FROM cost_sources
          WHERE builder_id = ${builderId}::uuid
            AND (metric = ${metric} OR slug = ${metric})
          LIMIT 1
        `),
      );
      const row = rows[0];
      if (!row) return;
      if (row.price_per_unit !== null) {
        const n = Number(row.price_per_unit);
        if (Number.isFinite(n)) result = { pricePerUnit: n, tiers: null };
        return;
      }
      if (Array.isArray(row.pricing_tiers) && row.pricing_tiers.length > 0) {
        result = { pricePerUnit: null, tiers: row.pricing_tiers as PricingTier[] };
      }
    });
  } catch (err) {
    log.warn(
      { builder_id: builderId, metric, error: err instanceof Error ? err.message : String(err) },
      'cost_sources pricing lookup failed — returning no-match',
    );
    return { pricePerUnit: null, tiers: null };
  }

  cache.set(key, { ...result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

// priceForUnits moved to ./tier-walk.js to keep it dependency-free for
// unit tests. Re-export here for legacy callers.
export { priceForUnits } from './tier-walk.js';
