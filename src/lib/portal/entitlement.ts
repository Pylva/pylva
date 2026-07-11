// SPDX-License-Identifier: Elastic-2.0
import type { NextResponse } from 'next/server.js';
import type { BuilderTier } from '@pylva/shared';
import { checkDashboardFeatureGate } from '../auth/dashboard-feature-gate.js';
import { checkFeatureGate } from '../auth/tier-enforcement.js';

export function checkPortalEntitlementForTier(tier: BuilderTier): NextResponse | null {
  return checkFeatureGate(tier, 'portal');
}

export async function checkPortalEntitlement(builderId: string): Promise<NextResponse | null> {
  return checkDashboardFeatureGate(builderId, 'portal');
}
