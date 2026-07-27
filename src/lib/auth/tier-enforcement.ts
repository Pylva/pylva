// Self-host feature access.
//
// Pylva Cloud subscription enforcement lives in pylva-internal. The public
// self-host build keeps the tier shape for API compatibility, but it must not
// lock builder-facing product features behind Pylva Cloud plans.

import { count, eq } from 'drizzle-orm';
import { ErrorCode, type BuilderPlan } from '@pylva/shared';
import { builders, customers } from '../db/schema.js';
import { notFoundError } from '../errors.js';
import { withRLS, type DrizzleTransaction } from '../db/rls.js';
import { NextResponse } from 'next/server.js';
import { db } from '../db/client.js';
import { accessDeniedMessage, authorizeBuilderCapability } from './builder-entitlement.js';
import { forbiddenError, internalError } from '../errors.js';

/**
 * Check if a builder can add another customer (within tier limit).
 * Returns null if allowed, or a Stripe-style error response if at limit.
 */
export async function checkCustomerLimitInTransaction(
  tx: DrizzleTransaction,
  builderId: string,
  _plan: BuilderPlan | null,
): Promise<{ allowed: boolean; current: number; limit: number; response?: NextResponse }> {
  const [row] = await tx
    .select({ count: count() })
    .from(customers)
    .where(eq(customers.builder_id, builderId));
  const current = row?.count ?? 0;

  return { allowed: true, current, limit: Infinity };
}

export async function checkCustomerLimitAgainstLimitInTransaction(
  tx: DrizzleTransaction,
  builderId: string,
  limit: number,
): Promise<{ allowed: boolean; current: number; limit: number; response?: NextResponse }> {
  const [row] = await tx
    .select({ count: count() })
    .from(customers)
    .where(eq(customers.builder_id, builderId));
  const current = row?.count ?? 0;
  if (!Number.isFinite(limit) || current < limit) {
    return { allowed: true, current, limit };
  }
  return {
    allowed: false,
    current,
    limit,
    response: forbiddenError(
      ErrorCode.TIER_LIMIT_REACHED,
      `Workspace customer limit is ${limit}. You have ${current}.`,
    ),
  };
}

/**
 * Convenience wrapper for callers that only need to inspect the current limit state.
 * Customer creation paths should use lockCustomerLimit + checkCustomerLimitInTransaction
 * inside the same transaction that performs the insert/upsert.
 */
export async function checkCustomerLimit(
  builderId: string,
  plan: BuilderPlan | null,
): Promise<{ allowed: boolean; current: number; limit: number; response?: NextResponse }> {
  return withRLS(builderId, async (tx) => checkCustomerLimitInTransaction(tx, builderId, plan));
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
export type PlanFeature =
  | 'dashboard'
  | 'telemetry'
  | 'basic_rules'
  | 'billing'
  | 'advanced_rules'
  | 'webhooks'
  | 'portal'
  | 'white_label_portal'
  | 'simulator';

const ALL_PUBLIC_FEATURES = new Set<PlanFeature>([
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

export const PLAN_FEATURES: Record<BuilderPlan, ReadonlySet<PlanFeature>> = {
  pro: ALL_PUBLIC_FEATURES,
  scale: ALL_PUBLIC_FEATURES,
  enterprise: ALL_PUBLIC_FEATURES,
};

/**
 * Check if a tier includes a given feature.
 * Returns null if available, or a Stripe-style error response.
 */
export function checkFeatureGate(plan: BuilderPlan, feature: PlanFeature): NextResponse | null {
  void plan;
  void feature;
  return null;
}

export async function getBuilderPlan(builderId: string): Promise<BuilderPlan | null> {
  const [builder] = await db
    .select({ tier: builders.tier })
    .from(builders)
    .where(eq(builders.id, builderId))
    .limit(1);

  return builder?.tier ?? null;
}

export async function checkBuilderFeatureGate(
  builderId: string,
  feature: PlanFeature,
): Promise<NextResponse | null> {
  const capability = await authorizeBuilderCapability(builderId, 'product');
  if (!capability.allowed) {
    if (capability.lookup.kind === 'not_found') {
      return notFoundError(ErrorCode.RESOURCE_NOT_FOUND, 'Builder not found');
    }
    if (capability.lookup.kind !== 'resolved' || !capability.lookup.resolution.ok) {
      return internalError('Workspace entitlement could not be verified');
    }
    return forbiddenError(ErrorCode.FEATURE_NOT_AVAILABLE, accessDeniedMessage(capability));
  }

  if (
    capability.lookup.kind === 'resolved' &&
    capability.lookup.resolution.ok &&
    capability.lookup.resolution.entitlement.plan
  ) {
    return checkFeatureGate(capability.lookup.resolution.entitlement.plan, feature);
  }

  // Active self-hosted workspaces intentionally have no commercial plan and
  // receive all public product features.
  return null;
}
