import {
  resolveBuilderEntitlement,
  type BuilderAccessState,
  type BuilderEntitlement,
  type BuilderEntitlementErrorReason,
  type BuilderPlan,
  type EntitlementSource,
  type PersistedBuilderEntitlement,
} from '@pylva/shared';

export interface NormalizedEntitlementContext {
  plan: BuilderPlan | null;
  accessState: BuilderAccessState;
  entitlementSource: EntitlementSource | null;
}

export class InvalidBuilderEntitlementError extends Error {
  constructor(public readonly reason: BuilderEntitlementErrorReason) {
    super(`Invalid builder entitlement: ${reason}`);
    this.name = 'InvalidBuilderEntitlementError';
  }
}

function contextFromEntitlement(entitlement: BuilderEntitlement): NormalizedEntitlementContext {
  return {
    plan: entitlement.plan,
    accessState: entitlement.access_state,
    entitlementSource: entitlement.entitlement_source,
  };
}

/**
 * Convert a persisted tuple into the only entitlement shape that may leave an
 * auth data-access boundary. The shared resolver owns the rolling-expand
 * compatibility rule: only legacy {free,null,null} is normalized to
 * checkout_required; every other malformed tuple is rejected.
 */
export function normalizeEntitlementContext(
  input: PersistedBuilderEntitlement,
): NormalizedEntitlementContext | null {
  const resolution = resolveBuilderEntitlement(input);
  return resolution.ok ? contextFromEntitlement(resolution.entitlement) : null;
}

export function requireEntitlementContext(
  input: PersistedBuilderEntitlement,
): NormalizedEntitlementContext {
  const resolution = resolveBuilderEntitlement(input);
  if (!resolution.ok) throw new InvalidBuilderEntitlementError(resolution.reason);
  return contextFromEntitlement(resolution.entitlement);
}
