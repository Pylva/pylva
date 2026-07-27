import type { NextResponse } from 'next/server.js';
import { checkBuilderFeatureGate, type PlanFeature } from './tier-enforcement.js';
import {
  accessDeniedMessage,
  authorizeBuilderCapability,
  type WorkspaceCapability,
} from './builder-entitlement.js';
import { ErrorCode } from '@pylva/shared';
import { forbiddenError, internalError, notFoundError } from '../errors.js';

export function checkDashboardFeatureGate(
  builderId: string,
  feature: PlanFeature,
): Promise<NextResponse | null> {
  return checkBuilderFeatureGate(builderId, feature);
}

/**
 * Gate a lifecycle-scoped dashboard capability without treating it as normal
 * product access. Route handlers use this in addition to middleware so a
 * direct invocation cannot bypass the authoritative database check.
 */
export async function checkDashboardCapabilityGate(
  builderId: string,
  capability: WorkspaceCapability,
): Promise<NextResponse | null> {
  const decision = await authorizeBuilderCapability(builderId, capability);
  if (decision.allowed) return null;
  if (decision.lookup.kind === 'not_found') {
    return notFoundError(ErrorCode.RESOURCE_NOT_FOUND, 'Builder not found');
  }
  if (decision.lookup.kind !== 'resolved' || !decision.lookup.resolution.ok) {
    return internalError('Workspace entitlement could not be verified');
  }
  return forbiddenError(ErrorCode.FEATURE_NOT_AVAILABLE, accessDeniedMessage(decision));
}
