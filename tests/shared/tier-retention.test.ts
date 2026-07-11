import { describe, expect, it } from 'vitest';
import {
  BuilderTier,
  EventCapWindowSource,
  EVENT_CAP_WARNING_RATIO,
  RETENTION_INFINITY_SENTINEL_DAYS,
  TierLimitNotificationKind,
  billingRetentionDays,
  telemetryRetentionDays,
  type EventCapWindowSource as EventCapWindowSourceValue,
  type TierLimitNotificationKind as TierLimitNotificationKindValue,
} from '@pylva/shared';

describe('shared tier retention helpers', () => {
  it('maps tier retention limits to ingest-stamped day counts', () => {
    expect(
      Object.fromEntries(
        Object.values(BuilderTier).map((tier) => [
          tier,
          {
            telemetry: telemetryRetentionDays(tier),
            billing: billingRetentionDays(tier),
          },
        ]),
      ),
    ).toEqual({
      free: { telemetry: 30, billing: 90 },
      pro: { telemetry: 90, billing: 365 },
      scale: { telemetry: 365, billing: RETENTION_INFINITY_SENTINEL_DAYS },
      enterprise: {
        telemetry: RETENTION_INFINITY_SENTINEL_DAYS,
        billing: RETENTION_INFINITY_SENTINEL_DAYS,
      },
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
