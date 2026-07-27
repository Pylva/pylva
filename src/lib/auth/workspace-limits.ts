import {
  EntitlementSource,
  RETENTION_INFINITY_SENTINEL_DAYS,
  SELF_HOSTED_LIMIT_DEFAULTS,
  planLimitsFor,
  type BuilderEntitlement,
  type PlanLimits,
} from '@pylva/shared';
import { env } from '../config.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'auth.workspace-limits' });

export interface RetentionStamp {
  retention_days: number;
  billing_retention_days: number;
}

/**
 * Return the validated, deployment-level self-host policy.
 *
 * The nullish fallbacks keep narrow unit-test env mocks deterministic; the
 * real config parser always materializes and validates all four values.
 */
export function configuredSelfHostedLimits(): PlanLimits {
  return {
    monthly_events:
      env.SELF_HOSTED_MONTHLY_EVENTS_LIMIT ?? SELF_HOSTED_LIMIT_DEFAULTS.monthly_events,
    max_customers: env.SELF_HOSTED_MAX_CUSTOMERS ?? SELF_HOSTED_LIMIT_DEFAULTS.max_customers,
    telemetry_retention_days:
      env.SELF_HOSTED_TELEMETRY_RETENTION_DAYS ??
      SELF_HOSTED_LIMIT_DEFAULTS.telemetry_retention_days,
    billing_retention_days:
      env.SELF_HOSTED_BILLING_RETENTION_DAYS ?? SELF_HOSTED_LIMIT_DEFAULTS.billing_retention_days,
  };
}

/**
 * Resolve limits only after the entitlement tuple has been validated.
 *
 * A hosted process can never consume SELF_HOSTED_* policy, even if a corrupt
 * row claims the self_hosted source. Its caller must fail closed on null.
 */
export function limitsForEntitlement(entitlement: BuilderEntitlement): PlanLimits | null {
  if (!entitlement.has_product_access) return null;
  if (entitlement.plan !== null) {
    const limits = planLimitsFor(entitlement.plan);
    if (limits === null) {
      log.error(
        {
          event: 'commercial_plan_limits_missing',
          plan: entitlement.plan,
          access_state: entitlement.access_state,
          entitlement_source: entitlement.entitlement_source,
          deployment_mode: env.PYLVA_DEPLOYMENT_MODE ?? 'self_hosted',
        },
        'commercial plan entitlement has no valid limit mapping; access denied',
      );
    }
    return limits;
  }
  if (
    entitlement.entitlement_source === EntitlementSource.SELF_HOSTED &&
    (env.PYLVA_DEPLOYMENT_MODE ?? 'self_hosted') === 'self_hosted'
  ) {
    return configuredSelfHostedLimits();
  }
  return null;
}

function retentionDays(value: number): number {
  return Number.isFinite(value) ? value : RETENTION_INFINITY_SENTINEL_DAYS;
}

export function retentionStampForLimits(limits: PlanLimits): RetentionStamp {
  return {
    retention_days: retentionDays(limits.telemetry_retention_days),
    billing_retention_days: retentionDays(limits.billing_retention_days),
  };
}
