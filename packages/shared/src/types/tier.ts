// Commercial plans and workspace entitlement lifecycle.
//
// A plan describes what a customer bought. Access state describes whether the
// workspace may use the product. Keeping those concepts separate prevents a
// missing or malformed plan from being interpreted as paid access.

export const BuilderPlan = {
  PRO: 'pro',
  SCALE: 'scale',
  ENTERPRISE: 'enterprise',
} as const;

export type BuilderPlan = (typeof BuilderPlan)[keyof typeof BuilderPlan];

export function isBuilderPlan(value: unknown): value is BuilderPlan {
  return typeof value === 'string' && Object.values(BuilderPlan).includes(value as BuilderPlan);
}

export const BuilderAccessState = {
  CHECKOUT_REQUIRED: 'checkout_required',
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
} as const;

export type BuilderAccessState = (typeof BuilderAccessState)[keyof typeof BuilderAccessState];

export function isBuilderAccessState(value: unknown): value is BuilderAccessState {
  return (
    typeof value === 'string' &&
    Object.values(BuilderAccessState).includes(value as BuilderAccessState)
  );
}

export const EntitlementSource = {
  STRIPE: 'stripe',
  ENTERPRISE_CONTRACT: 'enterprise_contract',
  SELF_HOSTED: 'self_hosted',
  ADMIN: 'admin',
} as const;

export type EntitlementSource = (typeof EntitlementSource)[keyof typeof EntitlementSource];

export function isEntitlementSource(value: unknown): value is EntitlementSource {
  return (
    typeof value === 'string' &&
    Object.values(EntitlementSource).includes(value as EntitlementSource)
  );
}

export type BuilderEntitlement =
  | {
      plan: null;
      access_state: typeof BuilderAccessState.CHECKOUT_REQUIRED;
      entitlement_source: null;
      has_product_access: false;
      legacy_free: boolean;
    }
  | {
      plan: null;
      access_state: typeof BuilderAccessState.SUSPENDED;
      entitlement_source: typeof EntitlementSource.STRIPE | typeof EntitlementSource.ADMIN | null;
      has_product_access: false;
      legacy_free: false;
    }
  | {
      plan: typeof BuilderPlan.PRO | typeof BuilderPlan.SCALE;
      access_state: typeof BuilderAccessState.ACTIVE;
      entitlement_source: typeof EntitlementSource.STRIPE | typeof EntitlementSource.ADMIN;
      has_product_access: true;
      legacy_free: false;
    }
  | {
      plan: typeof BuilderPlan.ENTERPRISE;
      access_state: typeof BuilderAccessState.ACTIVE;
      entitlement_source:
        typeof EntitlementSource.ENTERPRISE_CONTRACT | typeof EntitlementSource.ADMIN;
      has_product_access: true;
      legacy_free: false;
    }
  | {
      plan: null;
      access_state: typeof BuilderAccessState.ACTIVE;
      entitlement_source: typeof EntitlementSource.SELF_HOSTED;
      has_product_access: true;
      legacy_free: false;
    };

export const BuilderEntitlementErrorReason = {
  UNKNOWN_PLAN: 'unknown_plan',
  UNKNOWN_ACCESS_STATE: 'unknown_access_state',
  UNKNOWN_ENTITLEMENT_SOURCE: 'unknown_entitlement_source',
  MISSING_PLAN_LIMITS: 'missing_plan_limits',
  INVALID_COMBINATION: 'invalid_combination',
} as const;

export type BuilderEntitlementErrorReason =
  (typeof BuilderEntitlementErrorReason)[keyof typeof BuilderEntitlementErrorReason];

export type BuilderEntitlementResolution =
  | { ok: true; entitlement: BuilderEntitlement }
  | { ok: false; reason: BuilderEntitlementErrorReason };

export interface PersistedBuilderEntitlement {
  /** The database column remains named tier during the staged migration. */
  plan: unknown;
  access_state: unknown;
  entitlement_source: unknown;
}

/**
 * Parse the persisted entitlement tuple without granting access on inference.
 *
 * The sole compatibility case is an untouched legacy Free row. It resolves to
 * checkout_required, never to a paid plan. Migration 058 removes the database's
 * ability to persist that row after the rollout window.
 */
export function resolveBuilderEntitlement(
  input: PersistedBuilderEntitlement,
): BuilderEntitlementResolution {
  if (input.plan === 'free' && input.access_state === null && input.entitlement_source === null) {
    return {
      ok: true,
      entitlement: {
        plan: null,
        access_state: BuilderAccessState.CHECKOUT_REQUIRED,
        entitlement_source: null,
        has_product_access: false,
        legacy_free: true,
      },
    };
  }

  if (input.plan !== null && !isBuilderPlan(input.plan)) {
    return { ok: false, reason: BuilderEntitlementErrorReason.UNKNOWN_PLAN };
  }
  if (input.plan !== null && planLimitsFor(input.plan) === null) {
    return { ok: false, reason: BuilderEntitlementErrorReason.MISSING_PLAN_LIMITS };
  }
  if (!isBuilderAccessState(input.access_state)) {
    return { ok: false, reason: BuilderEntitlementErrorReason.UNKNOWN_ACCESS_STATE };
  }
  if (input.entitlement_source !== null && !isEntitlementSource(input.entitlement_source)) {
    return { ok: false, reason: BuilderEntitlementErrorReason.UNKNOWN_ENTITLEMENT_SOURCE };
  }

  const plan = input.plan;
  const accessState = input.access_state;
  const source = input.entitlement_source;

  if (accessState === BuilderAccessState.CHECKOUT_REQUIRED && plan === null && source === null) {
    return {
      ok: true,
      entitlement: {
        plan,
        access_state: accessState,
        entitlement_source: source,
        has_product_access: false,
        legacy_free: false,
      },
    };
  }

  if (
    accessState === BuilderAccessState.SUSPENDED &&
    plan === null &&
    (source === null || source === EntitlementSource.STRIPE || source === EntitlementSource.ADMIN)
  ) {
    return {
      ok: true,
      entitlement: {
        plan,
        access_state: accessState,
        entitlement_source: source,
        has_product_access: false,
        legacy_free: false,
      },
    };
  }

  if (
    accessState === BuilderAccessState.ACTIVE &&
    (plan === BuilderPlan.PRO || plan === BuilderPlan.SCALE) &&
    (source === EntitlementSource.STRIPE || source === EntitlementSource.ADMIN)
  ) {
    return {
      ok: true,
      entitlement: {
        plan,
        access_state: accessState,
        entitlement_source: source,
        has_product_access: true,
        legacy_free: false,
      },
    };
  }

  if (
    accessState === BuilderAccessState.ACTIVE &&
    plan === BuilderPlan.ENTERPRISE &&
    (source === EntitlementSource.ENTERPRISE_CONTRACT || source === EntitlementSource.ADMIN)
  ) {
    return {
      ok: true,
      entitlement: {
        plan,
        access_state: accessState,
        entitlement_source: source,
        has_product_access: true,
        legacy_free: false,
      },
    };
  }

  if (
    accessState === BuilderAccessState.ACTIVE &&
    plan === null &&
    source === EntitlementSource.SELF_HOSTED
  ) {
    return {
      ok: true,
      entitlement: {
        plan,
        access_state: accessState,
        entitlement_source: source,
        has_product_access: true,
        legacy_free: false,
      },
    };
  }

  return { ok: false, reason: BuilderEntitlementErrorReason.INVALID_COMBINATION };
}

export function hasProductAccess(resolution: BuilderEntitlementResolution): boolean {
  if (!resolution.ok || !resolution.entitlement.has_product_access) return false;
  const plan = resolution.entitlement.plan;
  return plan === null || planLimitsFor(plan) !== null;
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

export type EventCapWindowSource = (typeof EventCapWindowSource)[keyof typeof EventCapWindowSource];

export const EVENT_CAP_WARNING_RATIO = 0.8;

// cost_events.timestamp is ClickHouse DateTime (32-bit; max 2106-02-07).
// 18,250 days is the largest "unlimited" sentinel we can safely stamp without
// risking interval wrap into the past on modern rows.
export const RETENTION_INFINITY_SENTINEL_DAYS = 18_250;

export interface PlanLimits {
  monthly_events: number;
  max_customers: number;
  telemetry_retention_days: number;
  billing_retention_days: number;
}

export const PLAN_LIMITS: Record<BuilderPlan, PlanLimits> = {
  [BuilderPlan.PRO]: {
    monthly_events: 1_000_000,
    max_customers: 50,
    telemetry_retention_days: 90,
    billing_retention_days: 365,
  },
  [BuilderPlan.SCALE]: {
    monthly_events: 10_000_000,
    max_customers: 500,
    telemetry_retention_days: 365,
    billing_retention_days: Infinity,
  },
  [BuilderPlan.ENTERPRISE]: {
    monthly_events: Infinity,
    max_customers: Infinity,
    telemetry_retention_days: Infinity,
    billing_retention_days: Infinity,
  },
} as const;

/**
 * Deployment-level defaults for the public self-host distribution.
 *
 * These values are deliberately independent of Pro/Scale/Enterprise and do
 * not assign a commercial plan. Operators can override every value through
 * the validated SELF_HOSTED_* environment variables.
 */
export const SELF_HOSTED_LIMIT_DEFAULTS: Readonly<PlanLimits> = {
  monthly_events: 10_000_000,
  max_customers: 500,
  telemetry_retention_days: 365,
  billing_retention_days: 365,
} as const;

function validLimitValue(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    !Number.isNaN(value) &&
    value > 0 &&
    (Number.isFinite(value) || value === Infinity)
  );
}

/**
 * Resolve a commercial plan through one guarded runtime lookup.
 *
 * `Record<BuilderPlan, PlanLimits>` is a compile-time guarantee only. A bad
 * build, overlay, module mock, or runtime mutation can still remove or corrupt
 * an entry. Returning null makes every caller choose an explicit fail-closed
 * path instead of accidentally treating `undefined` as unlimited.
 */
export function planLimitsFor(plan: unknown): PlanLimits | null {
  if (!isBuilderPlan(plan)) return null;

  const limits = (PLAN_LIMITS as Partial<Record<BuilderPlan, PlanLimits>>)[plan];
  if (
    limits === undefined ||
    !validLimitValue(limits.monthly_events) ||
    !validLimitValue(limits.max_customers) ||
    !validLimitValue(limits.telemetry_retention_days) ||
    !validLimitValue(limits.billing_retention_days)
  ) {
    return null;
  }
  return limits;
}

function retentionDays(limit: number): number {
  return Number.isFinite(limit) ? limit : RETENTION_INFINITY_SENTINEL_DAYS;
}

function limitsForPlan(plan: BuilderPlan): PlanLimits {
  const limits = planLimitsFor(plan);
  if (limits === null) {
    throw new Error(`Cannot resolve a valid commercial plan limit mapping for: ${String(plan)}`);
  }
  return limits;
}

export function telemetryRetentionDays(plan: BuilderPlan): number {
  return retentionDays(limitsForPlan(plan).telemetry_retention_days);
}

export function billingRetentionDays(plan: BuilderPlan): number {
  return retentionDays(limitsForPlan(plan).billing_retention_days);
}

export interface PlanLimitResponse {
  plan: BuilderPlan;
  current_count: number;
  limit: number;
  upgrade_url?: string;
}
