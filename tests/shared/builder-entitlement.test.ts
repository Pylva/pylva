import { describe, expect, it } from 'vitest';
import {
  BuilderAccessState,
  BuilderEntitlementErrorReason,
  BuilderPlan,
  EntitlementSource,
  hasProductAccess,
  resolveBuilderEntitlement,
} from '@pylva/shared';

const plans = [
  null,
  BuilderPlan.PRO,
  BuilderPlan.SCALE,
  BuilderPlan.ENTERPRISE,
  'free',
  'unknown_plan',
] as const;
const accessStates = [
  null,
  BuilderAccessState.CHECKOUT_REQUIRED,
  BuilderAccessState.ACTIVE,
  BuilderAccessState.SUSPENDED,
  'unknown_state',
] as const;
const entitlementSources = [
  null,
  EntitlementSource.STRIPE,
  EntitlementSource.ENTERPRISE_CONTRACT,
  EntitlementSource.SELF_HOSTED,
  EntitlementSource.ADMIN,
  'unknown_source',
] as const;

type MatrixPlan = (typeof plans)[number];
type MatrixAccessState = (typeof accessStates)[number];
type MatrixEntitlementSource = (typeof entitlementSources)[number];

interface ExpectedValidTuple {
  plan: BuilderPlan | null;
  accessState: BuilderAccessState;
  entitlementSource: EntitlementSource | null;
  hasProductAccess: boolean;
  legacyFree: boolean;
}

function expectedValidTuple(
  plan: MatrixPlan,
  accessState: MatrixAccessState,
  entitlementSource: MatrixEntitlementSource,
): ExpectedValidTuple | null {
  if (plan === 'free' && accessState === null && entitlementSource === null) {
    return {
      plan: null,
      accessState: BuilderAccessState.CHECKOUT_REQUIRED,
      entitlementSource: null,
      hasProductAccess: false,
      legacyFree: true,
    };
  }

  if (
    plan === null &&
    accessState === BuilderAccessState.CHECKOUT_REQUIRED &&
    entitlementSource === null
  ) {
    return {
      plan,
      accessState,
      entitlementSource,
      hasProductAccess: false,
      legacyFree: false,
    };
  }

  if (
    plan === null &&
    accessState === BuilderAccessState.SUSPENDED &&
    (entitlementSource === null ||
      entitlementSource === EntitlementSource.STRIPE ||
      entitlementSource === EntitlementSource.ADMIN)
  ) {
    return {
      plan,
      accessState,
      entitlementSource,
      hasProductAccess: false,
      legacyFree: false,
    };
  }

  if (
    (plan === BuilderPlan.PRO || plan === BuilderPlan.SCALE) &&
    accessState === BuilderAccessState.ACTIVE &&
    (entitlementSource === EntitlementSource.STRIPE ||
      entitlementSource === EntitlementSource.ADMIN)
  ) {
    return {
      plan,
      accessState,
      entitlementSource,
      hasProductAccess: true,
      legacyFree: false,
    };
  }

  if (
    plan === BuilderPlan.ENTERPRISE &&
    accessState === BuilderAccessState.ACTIVE &&
    (entitlementSource === EntitlementSource.ENTERPRISE_CONTRACT ||
      entitlementSource === EntitlementSource.ADMIN)
  ) {
    return {
      plan,
      accessState,
      entitlementSource,
      hasProductAccess: true,
      legacyFree: false,
    };
  }

  if (
    plan === null &&
    accessState === BuilderAccessState.ACTIVE &&
    entitlementSource === EntitlementSource.SELF_HOSTED
  ) {
    return {
      plan,
      accessState,
      entitlementSource,
      hasProductAccess: true,
      legacyFree: false,
    };
  }

  return null;
}

function expectedFailureReason(
  plan: MatrixPlan,
  accessState: MatrixAccessState,
  entitlementSource: MatrixEntitlementSource,
): BuilderEntitlementErrorReason {
  if (plan === 'free' || plan === 'unknown_plan') {
    return BuilderEntitlementErrorReason.UNKNOWN_PLAN;
  }
  if (accessState === null || accessState === 'unknown_state') {
    return BuilderEntitlementErrorReason.UNKNOWN_ACCESS_STATE;
  }
  if (entitlementSource === 'unknown_source') {
    return BuilderEntitlementErrorReason.UNKNOWN_ENTITLEMENT_SOURCE;
  }
  return BuilderEntitlementErrorReason.INVALID_COMBINATION;
}

const entitlementMatrix = plans.flatMap((plan) =>
  accessStates.flatMap((accessState) =>
    entitlementSources.map((entitlementSource) => ({
      name: `${String(plan)}/${String(accessState)}/${String(entitlementSource)}`,
      plan,
      accessState,
      entitlementSource,
    })),
  ),
);

describe('builder entitlement resolution', () => {
  it('covers the complete persisted entitlement Cartesian product', () => {
    expect(entitlementMatrix).toHaveLength(6 * 5 * 6);
    expect(
      entitlementMatrix.filter(({ plan, accessState, entitlementSource }) =>
        expectedValidTuple(plan, accessState, entitlementSource),
      ),
    ).toHaveLength(12);
  });

  it.each(entitlementMatrix)(
    'resolves $name with the exact fail-closed capability matrix',
    ({ plan, accessState, entitlementSource }) => {
      const expected = expectedValidTuple(plan, accessState, entitlementSource);
      const resolution = resolveBuilderEntitlement({
        plan,
        access_state: accessState,
        entitlement_source: entitlementSource,
      });

      if (expected === null) {
        expect(resolution).toEqual({
          ok: false,
          reason: expectedFailureReason(plan, accessState, entitlementSource),
        });
        expect(hasProductAccess(resolution)).toBe(false);
        return;
      }

      expect(resolution.ok).toBe(true);
      expect(hasProductAccess(resolution)).toBe(expected.hasProductAccess);
      if (resolution.ok) {
        expect(resolution.entitlement).toEqual({
          plan: expected.plan,
          access_state: expected.accessState,
          entitlement_source: expected.entitlementSource,
          has_product_access: expected.hasProductAccess,
          legacy_free: expected.legacyFree,
        });
      }
    },
  );
});
