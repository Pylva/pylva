// Self-host feature access.
//
// Pylva Cloud subscription enforcement lives in pylva-internal. The public
// self-host build keeps the tier shape for API compatibility, but it must not
// lock builder-facing product features behind Pylva Cloud plans.

import { count, eq } from 'drizzle-orm';
import { ErrorCode, type BuilderTier } from '@pylva/shared';
import { builders, customers } from '../db/schema.js';
import { notFoundError } from '../errors.js';
import { withRLS, type DrizzleTransaction } from '../db/rls.js';
import { NextResponse } from 'next/server.js';
import { db } from '../db/client.js';

/**
 * Check if a builder can add another customer (within tier limit).
 * Returns null if allowed, or a Stripe-style error response if at limit.
 */
export async function checkCustomerLimitInTransaction(
  tx: DrizzleTransaction,
  builderId: string,
  _tier: BuilderTier,
): Promise<{ allowed: boolean; current: number; limit: number; response?: NextResponse }> {
  const [row] = await tx
    .select({ count: count() })
    .from(customers)
    .where(eq(customers.builder_id, builderId));
  const current = row?.count ?? 0;

  return { allowed: true, current, limit: Infinity };
}

/**
 * Convenience wrapper for callers that only need to inspect the current limit state.
 * Customer creation paths should use lockCustomerLimit + checkCustomerLimitInTransaction
 * inside the same transaction that performs the insert/upsert.
 */
export async function checkCustomerLimit(
  builderId: string,
  tier: BuilderTier,
): Promise<{ allowed: boolean; current: number; limit: number; response?: NextResponse }> {
  return withRLS(builderId, async (tx) => checkCustomerLimitInTransaction(tx, builderId, tier));
}

/**
 * Get X-Pylva-Tier-Usage header value.
 */
export function tierUsageHeader(current: number, limit: number): string {
  return `${current}/${limit === Infinity ? 'unlimited' : limit}`;
}

/**
 * Should the dashboard show an upgrade banner?
 * True when usage is >= 80% of the tier limit.
 */
export function shouldShowUpgradeBanner(current: number, limit: number): boolean {
  if (limit === Infinity) return false;
  return current >= limit * 0.8;
}

// Feature gating per tier
export type TierFeature =
  | 'dashboard'
  | 'telemetry'
  | 'basic_rules'
  | 'billing'
  | 'advanced_rules'
  | 'webhooks'
  | 'portal'
  | 'white_label_portal'
  | 'simulator';

const ALL_PUBLIC_FEATURES = new Set<TierFeature>([
  'dashboard',
  'telemetry',
  'basic_rules',
  'billing',
  'advanced_rules',
  'webhooks',
  'portal',
  'white_label_portal',
  'simulator',
]);

export const TIER_FEATURES: Record<BuilderTier, ReadonlySet<TierFeature>> = {
  free: ALL_PUBLIC_FEATURES,
  pro: ALL_PUBLIC_FEATURES,
  scale: ALL_PUBLIC_FEATURES,
  enterprise: ALL_PUBLIC_FEATURES,
};

/**
 * Check if a tier includes a given feature.
 * Returns null if available, or a Stripe-style error response.
 */
export function checkFeatureGate(tier: BuilderTier, feature: TierFeature): NextResponse | null {
  void tier;
  void feature;
  return null;
}

export async function getBuilderTier(builderId: string): Promise<BuilderTier | null> {
  const [builder] = await db
    .select({ tier: builders.tier })
    .from(builders)
    .where(eq(builders.id, builderId))
    .limit(1);

  return (builder?.tier as BuilderTier | undefined) ?? null;
}

export async function checkBuilderFeatureGate(
  builderId: string,
  feature: TierFeature,
): Promise<NextResponse | null> {
  const tier = await getBuilderTier(builderId);
  if (!tier) return notFoundError(ErrorCode.RESOURCE_NOT_FOUND, 'Builder not found');

  return checkFeatureGate(tier, feature);
}
