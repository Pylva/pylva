import { eq } from 'drizzle-orm';
import type { NextResponse } from 'next/server.js';
import { ErrorCode, type BuilderTier } from '@pylva/shared';
import { checkFeatureGate, type TierFeature } from './tier-enforcement.js';
import { db } from '../db/client.js';
import { builders } from '../db/schema.js';
import { notFoundError } from '../errors.js';

export async function getBuilderTierGate(builderId: string): Promise<BuilderTier | NextResponse> {
  const [builder] = await db
    .select({ tier: builders.tier })
    .from(builders)
    .where(eq(builders.id, builderId))
    .limit(1);

  if (!builder) return notFoundError(ErrorCode.RESOURCE_NOT_FOUND, 'Builder not found');
  return builder.tier as BuilderTier;
}

export async function checkDashboardFeatureGate(
  builderId: string,
  feature: TierFeature,
): Promise<NextResponse | null> {
  const tier = await getBuilderTierGate(builderId);
  if (tier instanceof Response) return tier;
  return checkFeatureGate(tier, feature);
}
