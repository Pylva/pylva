// Pricing tiers — spec Section 10

export const BuilderTier = {
  FREE: 'free',
  PRO: 'pro',
  SCALE: 'scale',
  ENTERPRISE: 'enterprise',
} as const;

export type BuilderTier = (typeof BuilderTier)[keyof typeof BuilderTier];

export function isBuilderTier(value: unknown): value is BuilderTier {
  return typeof value === 'string' && Object.values(BuilderTier).includes(value as BuilderTier);
}

export const TierLimitNotificationKind = {
  WARNING_80: 'warning_80',
  EXCEEDED: 'exceeded',
} as const;

export type TierLimitNotificationKind =
  (typeof TierLimitNotificationKind)[keyof typeof TierLimitNotificationKind];

export const EventCapWindowSource = {
  BILLING_PERIOD: 'billing_period',
  CALENDAR_MONTH: 'calendar_month',
} as const;

export type EventCapWindowSource =
  (typeof EventCapWindowSource)[keyof typeof EventCapWindowSource];

export const EVENT_CAP_WARNING_RATIO = 0.8;

// cost_events.timestamp is ClickHouse DateTime (32-bit; max 2106-02-07).
// 18,250 days is the largest "unlimited" sentinel we can safely stamp without
// risking interval wrap into the past on modern rows.
export const RETENTION_INFINITY_SENTINEL_DAYS = 18_250;

// Unknown or unresolved tiers preserve today's 1-year behavior. Error states
// must never mint long-retention rows.
export const RETENTION_FALLBACK_DAYS = 365;

export interface TierLimits {
  monthly_events: number;
  max_customers: number;
  telemetry_retention_days: number;
  billing_retention_days: number;
}

export const TIER_LIMITS: Record<BuilderTier, TierLimits> = {
  [BuilderTier.FREE]: {
    monthly_events: 100_000,
    max_customers: 10,
    telemetry_retention_days: 30,
    billing_retention_days: 90,
  },
  [BuilderTier.PRO]: {
    monthly_events: 1_000_000,
    max_customers: 50,
    telemetry_retention_days: 90,
    billing_retention_days: 365,
  },
  [BuilderTier.SCALE]: {
    monthly_events: 10_000_000,
    max_customers: 500,
    telemetry_retention_days: 365,
    billing_retention_days: Infinity,
  },
  [BuilderTier.ENTERPRISE]: {
    monthly_events: Infinity,
    max_customers: Infinity,
    telemetry_retention_days: Infinity,
    billing_retention_days: Infinity,
  },
} as const;

function retentionDays(limit: number): number {
  return Number.isFinite(limit) ? limit : RETENTION_INFINITY_SENTINEL_DAYS;
}

export function telemetryRetentionDays(tier: BuilderTier): number {
  return retentionDays(TIER_LIMITS[tier].telemetry_retention_days);
}

export function billingRetentionDays(tier: BuilderTier): number {
  return retentionDays(TIER_LIMITS[tier].billing_retention_days);
}

export interface TierLimitResponse {
  tier: BuilderTier;
  current_count: number;
  limit: number;
  upgrade_url?: string;
}
