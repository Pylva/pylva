// Rules validator — discriminated Valibot union per RuleType. Returns a typed
// config the repository can persist directly. B4-0a widens the union to
// accept model_routing + reliability_failover (the SDK pre-call engine in
// B4-T1 consumes them).

import * as v from 'valibot';
import {
  RuleEnforcement,
  RulePeriod,
  RuleScope,
  RuleType,
  customerIdSchema,
  modelSchema,
  providerSchema,
  stepNameSchema,
  type ModelRoutingConfig,
  type ReliabilityFailoverConfig,
} from '@pylva/shared';

const periodEnum = v.picklist([RulePeriod.HOUR, RulePeriod.DAY, RulePeriod.WEEK, RulePeriod.MONTH]);

const scopeEnum = v.picklist([RuleScope.PER_CUSTOMER, RuleScope.POOLED]);

const costThresholdConfig = v.object({
  threshold_usd: v.pipe(v.number(), v.minValue(0.0001)),
  period: periodEnum,
  scope: v.optional(scopeEnum, RuleScope.PER_CUSTOMER),
});

const budgetLimitConfig = v.object({
  limit_usd: v.pipe(v.number(), v.minValue(0.0001)),
  period: periodEnum,
  hard_stop: v.boolean(),
  scope: scopeEnum,
});

const marginProtectionConfig = v.object({
  margin_threshold_pct: v.pipe(v.number(), v.minValue(0), v.maxValue(100)),
  period: periodEnum,
  scope: scopeEnum,
  insufficient_revenue_data_treatment: v.optional(v.picklist(['skip', 'alert']), 'skip'),
  ab_suggestion_traffic_pct: v.optional(v.pipe(v.number(), v.minValue(1), v.maxValue(50)), 10),
});

// --- Model routing ---

// Reuses the ingest-layer schemas from `@pylva/shared/types/telemetry`.
// Single source of truth so a rule authored here can never reference an
// identifier the ingest layer would later reject.

const modelRoutingMatch = v.object({
  customer_id: v.optional(customerIdSchema),
  step_name: v.optional(stepNameSchema),
  provider: v.optional(providerSchema),
  model: v.optional(modelSchema),
});

const modelRoutingTarget = v.object({
  provider: providerSchema,
  model: modelSchema,
});

const modelRoutingFallback = v.object({
  on_cross_provider_auth_error: v.boolean(),
  on_access_denied: v.boolean(),
  on_model_not_found: v.boolean(),
  use_original_model: v.boolean(),
  skip_same_provider_401: v.boolean(),
});

// Match must include at least one selector — empty match would route every
// call which is almost certainly an authoring mistake.
function nonEmptyMatch(value: v.InferOutput<typeof modelRoutingMatch>): boolean {
  return Boolean(value.customer_id || value.step_name || value.provider || value.model);
}

// Explicit GenericSchema annotation breaks the cross-package portability
// trap (TS-2883) — see ruleCreateSchema below.
const modelRoutingConfig: v.GenericSchema<unknown, ModelRoutingConfig> = v.pipe(
  v.object({
    scope: scopeEnum,
    match: modelRoutingMatch,
    route_to: modelRoutingTarget,
    fallback: modelRoutingFallback,
    // D41: optional metadata link to the anomaly that produced this
    // rule via "Apply as rule". UUID-shaped string, not tied to a
    // specific FK — the activate handler resolves it lazily.
    source_anomaly_id: v.optional(v.pipe(v.string(), v.uuid())),
  }),
  v.check(
    (cfg) => nonEmptyMatch(cfg.match),
    'model_routing match must include at least one selector (customer_id / step_name / provider / model)',
  ),
);

// --- Reliability failover ---

const reliabilityFailoverConfig: v.GenericSchema<unknown, ReliabilityFailoverConfig> = v.pipe(
  v.object({
    customer_id: customerIdSchema,
    primary_provider: providerSchema,
    backup_provider: providerSchema,
    enabled: v.boolean(),
    consent_to_cost_shift: v.boolean(),
    trigger_error_rate_pct: v.pipe(v.number(), v.minValue(1), v.maxValue(100)),
    window_seconds: v.pipe(v.number(), v.minValue(60), v.maxValue(3600)),
    recover_error_rate_pct: v.pipe(v.number(), v.minValue(0), v.maxValue(100)),
    recover_after_seconds: v.pipe(v.number(), v.minValue(60), v.maxValue(3600)),
    recovery_probe_after_seconds: v.pipe(v.number(), v.minValue(60), v.maxValue(86_400)),
    // D31: optional backup-model + consent-time price snapshot. Validation
    // is shape-only — runtime correctness (snapshot-only-set-on-activate,
    // model-belongs-to-backup-provider) lives at the activate route.
    backup_model: v.optional(modelSchema),
    consent_backup_input_per_1m_usd: v.optional(v.pipe(v.number(), v.minValue(0))),
    consent_backup_output_per_1m_usd: v.optional(v.pipe(v.number(), v.minValue(0))),
    consent_observed_at: v.optional(v.pipe(v.string(), v.isoTimestamp())),
  }),
  v.check(
    (cfg) => cfg.primary_provider !== cfg.backup_provider,
    'reliability_failover primary_provider and backup_provider must differ',
  ),
  // D8 / D31: builders MUST tick consent_to_cost_shift before activation.
  // The dashboard activate endpoint enforces this on enabled=true; the
  // validator allows enabled=false drafts so partial config can be saved.
  v.check(
    (cfg) => !cfg.enabled || cfg.consent_to_cost_shift,
    'reliability_failover.enabled requires consent_to_cost_shift=true',
  ),
);

export type RuleCreateInput =
  | {
      type: typeof RuleType.COST_THRESHOLD;
      name: string;
      enabled?: boolean;
      customer_id?: string | null;
      enforcement?: typeof RuleEnforcement.POST_CALL;
      config: v.InferOutput<typeof costThresholdConfig>;
    }
  | {
      type: typeof RuleType.BUDGET_LIMIT;
      name: string;
      enabled?: boolean;
      customer_id?: string | null;
      enforcement?: typeof RuleEnforcement.PRE_CALL | typeof RuleEnforcement.POST_CALL;
      config: v.InferOutput<typeof budgetLimitConfig>;
    }
  | {
      type: typeof RuleType.MARGIN_PROTECTION;
      name: string;
      enabled?: boolean;
      customer_id?: string | null;
      enforcement?: typeof RuleEnforcement.POST_CALL;
      config: v.InferOutput<typeof marginProtectionConfig>;
    }
  | {
      type: typeof RuleType.MODEL_ROUTING;
      name: string;
      enabled?: boolean;
      customer_id?: string | null;
      enforcement?: typeof RuleEnforcement.PRE_CALL;
      config: v.InferOutput<typeof modelRoutingConfig>;
    }
  | {
      type: typeof RuleType.RELIABILITY_FAILOVER;
      name: string;
      enabled?: boolean;
      customer_id?: string | null;
      enforcement?: typeof RuleEnforcement.PRE_CALL;
      config: v.InferOutput<typeof reliabilityFailoverConfig>;
    };

const baseMeta = {
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  enabled: v.optional(v.boolean(), true),
  customer_id: v.optional(v.nullable(customerIdSchema)),
};

// A pooled-scope rule aggregates spend across ALL end-users; combining it
// with a single-customer target has no coherent meaning (that customer's
// calls would be gated on everyone's spend) and broke budget-sync
// resolution, which wiped the SDK's blocked state every sync cycle.
export const POOLED_TARGETING_MESSAGE =
  'Pooled rules apply to all end-users; remove the end-user target or use per_customer scope';

// Explicit GenericSchema annotation widens the inferred type so the .d.ts
// emit doesn't reference valibot internals (RegexAction, SchemaWithPipe,
// etc.) that aren't re-exported across the @pylva/shared project
// boundary. v.safeParse still narrows correctly via RuleCreateInput.
export const ruleCreateSchema: v.GenericSchema<unknown, RuleCreateInput> = v.variant('type', [
  v.pipe(
    v.object({
      type: v.literal(RuleType.COST_THRESHOLD),
      ...baseMeta,
      config: costThresholdConfig,
    }),
    v.check((r) => r.config.scope !== RuleScope.POOLED || !r.customer_id, POOLED_TARGETING_MESSAGE),
  ),
  v.pipe(
    v.object({
      type: v.literal(RuleType.BUDGET_LIMIT),
      ...baseMeta,
      enforcement: v.optional(
        v.picklist([RuleEnforcement.PRE_CALL, RuleEnforcement.POST_CALL]),
        RuleEnforcement.PRE_CALL,
      ),
      config: budgetLimitConfig,
    }),
    v.check((r) => r.config.scope !== RuleScope.POOLED || !r.customer_id, POOLED_TARGETING_MESSAGE),
  ),
  v.pipe(
    v.object({
      type: v.literal(RuleType.MARGIN_PROTECTION),
      ...baseMeta,
      config: marginProtectionConfig,
    }),
    v.check((r) => r.config.scope !== RuleScope.POOLED || !r.customer_id, POOLED_TARGETING_MESSAGE),
  ),
  v.object({
    type: v.literal(RuleType.MODEL_ROUTING),
    ...baseMeta,
    enforcement: v.optional(v.literal(RuleEnforcement.PRE_CALL), RuleEnforcement.PRE_CALL),
    config: modelRoutingConfig,
  }),
  v.object({
    type: v.literal(RuleType.RELIABILITY_FAILOVER),
    ...baseMeta,
    enforcement: v.optional(v.literal(RuleEnforcement.PRE_CALL), RuleEnforcement.PRE_CALL),
    config: reliabilityFailoverConfig,
  }),
]);

export function isSupportedRuleType(
  t: string,
): t is Extract<RuleCreateInput, { type: unknown }>['type'] {
  return (
    t === RuleType.COST_THRESHOLD ||
    t === RuleType.BUDGET_LIMIT ||
    t === RuleType.MARGIN_PROTECTION ||
    t === RuleType.MODEL_ROUTING ||
    t === RuleType.RELIABILITY_FAILOVER
  );
}

// Updates keep `type` immutable (changing a rule's type is conceptually a
// delete + create); the update payload uses the same variants.
export const ruleUpdateSchema: v.GenericSchema<unknown, RuleCreateInput> = ruleCreateSchema;
