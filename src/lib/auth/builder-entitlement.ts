import {
  BuilderAccessState,
  hasProductAccess,
  resolveBuilderEntitlement,
  type BuilderEntitlementResolution,
} from '@pylva/shared';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { builders } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'auth.builder-entitlement' });

/**
 * Product capabilities that remain available outside normal workspace access.
 * All other builder-facing behavior is represented by `product`.
 */
export type WorkspaceCapability =
  | 'product'
  | 'account_recovery'
  | 'platform_billing'
  | 'invoices'
  | 'export';

export type BuilderEntitlementLookup =
  | {
      kind: 'resolved';
      resolution: BuilderEntitlementResolution;
    }
  | {
      kind: 'not_found' | 'lookup_failed';
    };

export interface BuilderCapabilityDecision {
  allowed: boolean;
  lookup: BuilderEntitlementLookup;
}

/**
 * Read the entitlement source of truth directly from PostgreSQL.
 *
 * This intentionally has no Redis or process-local cache. A checkout,
 * suspension, or reactivation must take effect on the next request, and an old
 * JWT/API-key cache entry must never be able to grant product access.
 */
export async function loadBuilderEntitlement(
  builderId: string,
): Promise<BuilderEntitlementLookup> {
  try {
    const rows = await db
      .select({
        plan: builders.tier,
        access_state: builders.access_state,
        entitlement_source: builders.entitlement_source,
      })
      .from(builders)
      .where(eq(builders.id, builderId))
      .limit(1);
    const row = rows[0];
    if (!row) return { kind: 'not_found' };

    const resolution = resolveBuilderEntitlement(row);
    if (!resolution.ok) {
      log.error(
        { builder_id: builderId, reason: resolution.reason },
        'invalid builder entitlement; access denied',
      );
    }
    return { kind: 'resolved', resolution };
  } catch (error) {
    log.error(
      {
        builder_id: builderId,
        error_type: error instanceof Error ? error.name : 'UnknownError',
      },
      'builder entitlement lookup failed; access denied',
    );
    return { kind: 'lookup_failed' };
  }
}

/**
 * Capability policy:
 * - active paid and active self-hosted workspaces have normal product access;
 * - checkout-required workspaces can only complete platform billing;
 * - suspended workspaces can manage billing/reactivation, read invoices, and export data;
 * - missing, corrupt, or unknown rows fail closed.
 */
export function entitlementAllowsCapability(
  resolution: BuilderEntitlementResolution,
  capability: WorkspaceCapability,
): boolean {
  if (hasProductAccess(resolution)) return true;
  if (!resolution.ok) return false;

  const state = resolution.entitlement.access_state;
  if (state === BuilderAccessState.CHECKOUT_REQUIRED) {
    return capability === 'account_recovery' || capability === 'platform_billing';
  }
  if (state === BuilderAccessState.SUSPENDED) {
    return (
      capability === 'account_recovery' ||
      capability === 'platform_billing' ||
      capability === 'invoices' ||
      capability === 'export'
    );
  }
  return false;
}

export async function authorizeBuilderCapability(
  builderId: string,
  capability: WorkspaceCapability,
): Promise<BuilderCapabilityDecision> {
  const lookup = await loadBuilderEntitlement(builderId);
  return {
    allowed:
      lookup.kind === 'resolved' &&
      entitlementAllowsCapability(lookup.resolution, capability),
    lookup,
  };
}

export function accessDeniedMessage(decision: BuilderCapabilityDecision): string {
  if (decision.lookup.kind !== 'resolved' || !decision.lookup.resolution.ok) {
    return 'Workspace access is unavailable';
  }
  return decision.lookup.resolution.entitlement.access_state ===
    BuilderAccessState.CHECKOUT_REQUIRED
    ? 'Choose a plan to continue'
    : 'Workspace access is suspended; reactivate billing to continue';
}
