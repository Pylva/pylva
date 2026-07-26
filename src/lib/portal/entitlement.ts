// SPDX-License-Identifier: Elastic-2.0
import type { NextResponse } from 'next/server.js';
import { checkDashboardFeatureGate } from '../auth/dashboard-feature-gate.js';

export async function checkPortalEntitlement(builderId: string): Promise<NextResponse | null> {
  return checkDashboardFeatureGate(builderId, 'portal');
}
