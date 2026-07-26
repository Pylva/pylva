import { describe, expect, it } from 'vitest';
import {
  BuilderPlan,
  BuilderEntitlementErrorReason,
  EventCapWindowSource,
  EVENT_CAP_WARNING_RATIO,
  PLAN_LIMITS,
  RETENTION_INFINITY_SENTINEL_DAYS,
  SELF_HOSTED_LIMIT_DEFAULTS,
  TierLimitNotificationKind,
  billingRetentionDays,
  hasProductAccess,
  planLimitsFor,
  resolveBuilderEntitlement,
  telemetryRetentionDays,
  type EventCapWindowSource as EventCapWindowSourceValue,
  type TierLimitNotificationKind as TierLimitNotificationKindValue,
} from '@pylva/shared';

describe('shared plan retention helpers', () => {
  it('maps paid plan retention limits to ingest-stamped day counts', () => {
    expect(
      Object.fromEntries(
        Object.values(BuilderPlan).map((plan) => [
          plan,
          {
            telemetry: telemetryRetentionDays(plan),
            billing: billingRetentionDays(plan),
          },
        ]),
      ),
    ).toEqual({
      pro: { telemetry: 90, billing: 365 },
      scale: { telemetry: 365, billing: RETENTION_INFINITY_SENTINEL_DAYS },
      enterprise: {
        telemetry: RETENTION_INFINITY_SENTINEL_DAYS,
        billing: RETENTION_INFINITY_SENTINEL_DAYS,
      },
    });
  });

  it.each(['free', 'unknown', null, undefined])(
    'fails closed instead of assigning retention to an untrusted plan value %s',
    (plan) => {
      expect(() => telemetryRetentionDays(plan as BuilderPlan)).toThrow(
        /valid commercial plan limit mapping/i,
      );
      expect(() => billingRetentionDays(plan as BuilderPlan)).toThrow(
        /valid commercial plan limit mapping/i,
      );
    },
  );

  it('fails closed when a known commercial plan loses its runtime limit mapping', () => {
    const mutableLimits = PLAN_LIMITS as Partial<typeof PLAN_LIMITS>;
    const originalCatalog = { ...PLAN_LIMITS };
    const previouslyResolved = resolveBuilderEntitlement({
      plan: BuilderPlan.PRO,
      access_state: 'active',
      entitlement_source: 'stripe',
    });
    expect(previouslyResolved.ok).toBe(true);

    delete mutableLimits[BuilderPlan.PRO];
    try {
      expect(planLimitsFor(BuilderPlan.PRO)).toBeNull();
      expect(() => telemetryRetentionDays(BuilderPlan.PRO)).toThrow(
        /valid commercial plan limit mapping.*pro/i,
      );
      expect(() => billingRetentionDays(BuilderPlan.PRO)).toThrow(
        /valid commercial plan limit mapping.*pro/i,
      );
      expect(hasProductAccess(previouslyResolved)).toBe(false);
      expect(
        resolveBuilderEntitlement({
          plan: BuilderPlan.PRO,
          access_state: 'active',
          entitlement_source: 'stripe',
        }),
      ).toEqual({
        ok: false,
        reason: BuilderEntitlementErrorReason.MISSING_PLAN_LIMITS,
      });
    } finally {
      for (const key of Object.keys(mutableLimits) as BuilderPlan[]) delete mutableLimits[key];
      Object.assign(mutableLimits, originalCatalog);
    }
  });

  it('contains exactly the three commercial plans and a separate self-host policy', () => {
    expect(Object.values(BuilderPlan)).toEqual(['pro', 'scale', 'enterprise']);
    expect(Object.keys(PLAN_LIMITS)).toEqual(['pro', 'scale', 'enterprise']);
    expect(SELF_HOSTED_LIMIT_DEFAULTS).toEqual({
      monthly_events: 10_000_000,
      max_customers: 500,
      telemetry_retention_days: 365,
      billing_retention_days: 365,
    });
  });

  it('exports event-cap constants and notification kinds', () => {
    const kinds: TierLimitNotificationKindValue[] = [
      TierLimitNotificationKind.WARNING_80,
      TierLimitNotificationKind.EXCEEDED,
    ];
    const sources: EventCapWindowSourceValue[] = [
      EventCapWindowSource.BILLING_PERIOD,
      EventCapWindowSource.CALENDAR_MONTH,
    ];

    expect(RETENTION_INFINITY_SENTINEL_DAYS).toBe(18_250);
    expect(EVENT_CAP_WARNING_RATIO).toBe(0.8);
    expect(kinds).toEqual(['warning_80', 'exceeded']);
    expect(sources).toEqual(['billing_period', 'calendar_month']);
  });
});
