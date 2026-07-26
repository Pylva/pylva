import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BuilderPlan, PLAN_LIMITS, resolveBuilderEntitlement } from '@pylva/shared';

const testEnv = vi.hoisted(() => ({
  PYLVA_DEPLOYMENT_MODE: 'self_hosted',
  SELF_HOSTED_MONTHLY_EVENTS_LIMIT: 123_456,
  SELF_HOSTED_MAX_CUSTOMERS: 321,
  SELF_HOSTED_TELEMETRY_RETENTION_DAYS: 90,
  SELF_HOSTED_BILLING_RETENTION_DAYS: 730,
}));
const logError = vi.hoisted(() => vi.fn());

vi.mock('../../src/lib/config.js', () => ({ env: testEnv }));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { child: () => ({ error: logError }) },
}));

const {
  configuredSelfHostedLimits,
  limitsForEntitlement,
  retentionStampForLimits,
} = await import('../../src/lib/auth/workspace-limits.js');

function entitlement(input: {
  plan: unknown;
  access_state: unknown;
  entitlement_source: unknown;
}) {
  const resolution = resolveBuilderEntitlement(input);
  if (!resolution.ok) throw new Error(`invalid test entitlement: ${resolution.reason}`);
  return resolution.entitlement;
}

describe('workspace limit policy', () => {
  beforeEach(() => {
    testEnv.PYLVA_DEPLOYMENT_MODE = 'self_hosted';
    testEnv.SELF_HOSTED_MONTHLY_EVENTS_LIMIT = 123_456;
    testEnv.SELF_HOSTED_MAX_CUSTOMERS = 321;
    testEnv.SELF_HOSTED_TELEMETRY_RETENTION_DAYS = 90;
    testEnv.SELF_HOSTED_BILLING_RETENTION_DAYS = 730;
    logError.mockReset();
  });

  it('uses every operator override for a planless active self-host entitlement', () => {
    const selfHosted = entitlement({
      plan: null,
      access_state: 'active',
      entitlement_source: 'self_hosted',
    });

    expect(configuredSelfHostedLimits()).toEqual({
      monthly_events: 123_456,
      max_customers: 321,
      telemetry_retention_days: 90,
      billing_retention_days: 730,
    });
    const limits = limitsForEntitlement(selfHosted);
    expect(limits).toEqual(configuredSelfHostedLimits());
    expect(retentionStampForLimits(limits!)).toEqual({
      retention_days: 90,
      billing_retention_days: 730,
    });
  });

  it('never consumes self-host policy in hosted mode', () => {
    testEnv.PYLVA_DEPLOYMENT_MODE = 'hosted';

    expect(
      limitsForEntitlement(
        entitlement({
          plan: null,
          access_state: 'active',
          entitlement_source: 'self_hosted',
        }),
      ),
    ).toBeNull();
  });

  it('keeps commercial plan limits independent of deployment policy', () => {
    testEnv.PYLVA_DEPLOYMENT_MODE = 'hosted';

    expect(
      limitsForEntitlement(
        entitlement({
          plan: 'pro',
          access_state: 'active',
          entitlement_source: 'stripe',
        }),
      ),
    ).toEqual({
      monthly_events: 1_000_000,
      max_customers: 50,
      telemetry_retention_days: 90,
      billing_retention_days: 365,
    });
  });

  it('returns null and emits a high-signal error if a resolved plan loses its mapping', () => {
    testEnv.PYLVA_DEPLOYMENT_MODE = 'hosted';
    const paid = entitlement({
      plan: BuilderPlan.PRO,
      access_state: 'active',
      entitlement_source: 'stripe',
    });
    const mutableLimits = PLAN_LIMITS as Partial<typeof PLAN_LIMITS>;
    const originalCatalog = { ...PLAN_LIMITS };

    delete mutableLimits[BuilderPlan.PRO];
    try {
      expect(limitsForEntitlement(paid)).toBeNull();
    } finally {
      for (const key of Object.keys(mutableLimits) as BuilderPlan[]) delete mutableLimits[key];
      Object.assign(mutableLimits, originalCatalog);
    }

    expect(logError).toHaveBeenCalledWith(
      {
        event: 'commercial_plan_limits_missing',
        plan: BuilderPlan.PRO,
        access_state: 'active',
        entitlement_source: 'stripe',
        deployment_mode: 'hosted',
      },
      'commercial plan entitlement has no valid limit mapping; access denied',
    );
  });

  it.each([
    {
      plan: null,
      access_state: 'checkout_required',
      entitlement_source: null,
    },
    {
      plan: null,
      access_state: 'suspended',
      entitlement_source: 'stripe',
    },
  ])('returns no limits for non-active state %#', (input) => {
    expect(limitsForEntitlement(entitlement(input))).toBeNull();
  });
});
