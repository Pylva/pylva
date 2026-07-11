// Reactive rules types — spec Section 6 + B2a §2h (discriminated config + scope).
// v1.0: rule channels live in `rule_alert_channels` (migration 017), NOT in
// rules.config. The legacy shape (channels inside config) is gone.

export const RuleType = {
  COST_THRESHOLD: 'cost_threshold',
  BUDGET_LIMIT: 'budget_limit',
  MODEL_ROUTING: 'model_routing', // B4-T1: live; validator accepts
  RELIABILITY_FAILOVER: 'reliability_failover', // B4-T1: live; requires consent
  MARGIN_PROTECTION: 'margin_protection',
} as const;

export type RuleType = (typeof RuleType)[keyof typeof RuleType];

export const RuleEnforcement = {
  PRE_CALL: 'pre_call',
  POST_CALL: 'post_call',
} as const;

export type RuleEnforcement = (typeof RuleEnforcement)[keyof typeof RuleEnforcement];

export const RulePeriod = {
  HOUR: 'hour',
  DAY: 'day',
  WEEK: 'week',
  MONTH: 'month',
} as const;

export type RulePeriod = (typeof RulePeriod)[keyof typeof RulePeriod];

// D28: explicit scope flag on rule.config decides whether a null customer_id
// means "one budget per end-user" (per_customer) or "one shared budget
// across all end-users" (pooled).
export const RuleScope = {
  PER_CUSTOMER: 'per_customer',
  POOLED: 'pooled',
} as const;

export type RuleScope = (typeof RuleScope)[keyof typeof RuleScope];

// B3-T3 (D17): simulator saves draft recommendations as rules with status='draft'.
// SDK rule fetch filters WHERE status != 'draft'; dashboard shows drafts
// in a separate tab.
export const RuleStatus = {
  ACTIVE: 'active',
  DRAFT: 'draft',
} as const;

export type RuleStatus = (typeof RuleStatus)[keyof typeof RuleStatus];

// --- Discriminated config shapes (§2h) ---

export interface CostThresholdConfig {
  threshold_usd: number; // > 0
  period: RulePeriod;
  scope?: RuleScope; // defaults to per_customer when omitted
}

export interface BudgetLimitConfig {
  limit_usd: number; // > 0
  period: RulePeriod;
  hard_stop: boolean; // pre-call enforcement throws if true
  scope: RuleScope; // required
}

export interface MarginProtectionConfig {
  margin_threshold_pct: number; // 0-100
  period: RulePeriod;
  scope: RuleScope; // required
  // B4-T1 (D10/D41/D49): expanded shape — top-driver / iteration heuristics
  // emit deterministic recommendations; the simulator's draft route stores
  // the suggested swap here for "Apply as rule" → model_routing rule.
  insufficient_revenue_data_treatment?: 'skip' | 'alert';
  ab_suggestion_traffic_pct?: number; // recommendation default: 10%
}

// --- B4-T1 model routing (D9, D11, D25, D28) ---

// Match selectors are AND-combined; null/undefined means "any". `customer_id`
// is the external customer string (the SDK-supplied identifier), not the
// internal UUID.
export interface ModelRoutingMatch {
  customer_id?: string;
  step_name?: string;
  provider?: string;
  model?: string;
}

export interface ModelRoutingTarget {
  provider: string;
  model: string;
}

// D25: same-provider 401 retry is skipped — re-issuing with the same key
// won't recover. Cross-provider 401/403/404 fall back to the original model.
export interface ModelRoutingFallback {
  on_cross_provider_auth_error: boolean; // 401 (cross-provider only)
  on_access_denied: boolean; // 403
  on_model_not_found: boolean; // 404
  use_original_model: boolean; // fall back to req.model on failure
  skip_same_provider_401: boolean; // D25
}

// Canonical default. Used by the SDK wrappers, the recommendation engine
// when emitting a draft rule, and any test fixture that wants the
// "everything-on" preset. Promotes the choice to one source of truth.
export const DEFAULT_MODEL_ROUTING_FALLBACK: ModelRoutingFallback = {
  on_cross_provider_auth_error: true,
  on_access_denied: true,
  on_model_not_found: true,
  use_original_model: true,
  skip_same_provider_401: true,
};

export interface ModelRoutingConfig {
  scope: RuleScope;
  match: ModelRoutingMatch;
  route_to: ModelRoutingTarget;
  fallback: ModelRoutingFallback;
  // B4-4d (D41): when this rule was created from an anomaly
  // recommendation ("Apply as rule"), the source anomaly id is stamped
  // here so the activate UI can fetch a fresh metric and surface the
  // activation-time delta. Pure metadata — the SDK pre-call engine
  // ignores it.
  source_anomaly_id?: string;
}

// --- B4-T1 reliability failover (D8, D24, D26, D30, D31) ---

// D30: thresholds are platform defaults; persisted for documentation +
// per-pair tweakability later, but the runtime currently uses the constants.
export interface ReliabilityFailoverConfig {
  customer_id: string; // per-customer only — no global failover
  primary_provider: string;
  backup_provider: string;
  enabled: boolean;
  consent_to_cost_shift: boolean; // must be true to activate (D8)
  trigger_error_rate_pct: number; // platform default: 10
  window_seconds: number; // platform default: 300
  recover_error_rate_pct: number; // platform default: 5
  recover_after_seconds: number; // platform default: 300
  recovery_probe_after_seconds: number; // D24 default: 1800
  // D31: backup-model price-change watcher. The builder names the model
  // they consented to fail over to, and the activate handler stamps the
  // observed price into the consent_* fields. Pricing-sync compares
  // current price vs snapshot and alerts when delta > 10%. All four
  // fields are optional so existing rules without snapshots simply skip
  // the watcher (no schema migration required for older rules).
  backup_model?: string;
  consent_backup_input_per_1m_usd?: number;
  consent_backup_output_per_1m_usd?: number;
  consent_observed_at?: string; // ISO 8601
}

// Discriminated union keyed on RuleType.
export type RuleConfig =
  | ({ type: typeof RuleType.COST_THRESHOLD } & CostThresholdConfig)
  | ({ type: typeof RuleType.BUDGET_LIMIT } & BudgetLimitConfig)
  | ({ type: typeof RuleType.MARGIN_PROTECTION } & MarginProtectionConfig)
  | ({ type: typeof RuleType.MODEL_ROUTING } & ModelRoutingConfig)
  | ({ type: typeof RuleType.RELIABILITY_FAILOVER } & ReliabilityFailoverConfig);

// The DB row shape (rules table). config is JSONB; at read time callers
// narrow via the validator (Valibot discriminatedUnion) to a RuleConfig.
export interface Rule {
  id: string;
  builder_id: string;
  type: RuleType;
  enforcement: RuleEnforcement;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>; // narrowed by validator at read time
  customer_id: string | null; // null = applies to all customers (scope flag disambiguates)
  status: RuleStatus; // B3-T3: 'draft' rules are simulator recommendations, filtered from SDK fetch
  // B4-0a (migration 028): activation + diagnostic columns.
  activated_at: Date | null;
  last_triggered_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

// --- B4-T1 rule_events (per-rule activity log) ---

export const RuleEventType = {
  MODEL_ROUTING_APPLIED: 'model_routing_applied',
  MODEL_ROUTING_FAILED: 'model_routing_failed',
  FAILOVER_TRIGGERED: 'failover_triggered',
  FAILOVER_RECOVERED: 'failover_recovered',
  FAILOVER_PROBE_ATTEMPTED: 'failover_probe_attempted',
  BUDGET_BLOCKED: 'budget_blocked',
  RULE_ACTIVATED: 'rule_activated',
  RULE_DEACTIVATED: 'rule_deactivated',
  RULE_WARNING: 'rule_warning',
} as const;

export type RuleEventType = (typeof RuleEventType)[keyof typeof RuleEventType];

export const RuleEventSeverity = {
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
} as const;

export type RuleEventSeverity = (typeof RuleEventSeverity)[keyof typeof RuleEventSeverity];

export interface RuleEvent {
  id: string;
  builder_id: string;
  rule_id: string | null; // null when rule is hard-deleted but event log is kept
  customer_id: string | null;
  event_type: RuleEventType;
  severity: RuleEventSeverity;
  provider: string | null;
  model_from: string | null;
  model_to: string | null;
  message: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}

// --- B4-T1 SDK rule decision (returned from rules engine) ---

export const RuleDecisionAction = {
  ALLOW: 'allow',
  BLOCK: 'block',
  ROUTE_MODEL: 'route_model',
  FAILOVER: 'failover',
} as const;

export type RuleDecisionAction = (typeof RuleDecisionAction)[keyof typeof RuleDecisionAction];

// All warning codes the SDK rules engine + wrappers can surface to the
// host app via decision.warnings or response._pylva.warnings.
export const RuleWarningCode = {
  ROUTING_CROSS_PROVIDER_SKIPPED: 'routing_cross_provider_skipped',
  ROUTING_FALLBACK_AUTH_401: 'routing_fallback_auth_401',
  ROUTING_FALLBACK_ACCESS_403: 'routing_fallback_access_403',
  ROUTING_FALLBACK_NOT_FOUND_404: 'routing_fallback_not_found_404',
  FAILOVER_MISSING_BACKUP: 'failover_missing_backup',
  // PR #84 review (bug_028) — emitted while the failover state machine
  // says "primary is failing, route to backup" but the cross-provider
  // dispatch is not yet implemented. The backup client IS registered
  // (so FAILOVER_MISSING_BACKUP would be misleading), but every call
  // still lands on the failing primary. Distinct from MISSING_BACKUP
  // so dashboards can alert on the dispatch gap separately. Removed
  // when the v2 follow-up wires the dispatcher.
  FAILOVER_DISPATCH_NOT_IMPLEMENTED: 'failover_dispatch_not_implemented',
} as const;

export type RuleWarningCode = (typeof RuleWarningCode)[keyof typeof RuleWarningCode];

export interface RuleWarning {
  code: RuleWarningCode;
  message: string;
}

// Discriminated decision returned by the SDK rules engine. Wrapper code
// applies the action; the engine itself is pure (no side effects).
export type RuleDecision =
  | { action: typeof RuleDecisionAction.ALLOW; warnings?: RuleWarning[] }
  | {
      action: typeof RuleDecisionAction.BLOCK;
      reason: 'budget_exceeded';
      rule_id: string;
      warnings?: RuleWarning[];
    }
  | {
      action: typeof RuleDecisionAction.ROUTE_MODEL;
      rule_id: string;
      provider: string;
      model: string;
      original_model: string;
      fallback: ModelRoutingFallback;
      warnings?: RuleWarning[];
    }
  | {
      action: typeof RuleDecisionAction.FAILOVER;
      rule_id: string;
      provider: string; // backup provider in use
      reason: string;
      warnings?: RuleWarning[];
    };

// Conflict-resolution specificity tier (D27): customer + step + model >
// customer + step > customer > global + step + model > global + step > global.
// Same specificity → most recently updated rule wins.
export const RuleConflictResolution = {
  CUSTOMER_STEP_MODEL: 6,
  CUSTOMER_STEP: 5,
  CUSTOMER: 4,
  GLOBAL_STEP_MODEL: 3,
  GLOBAL_STEP: 2,
  GLOBAL: 1,
} as const;

export type RuleConflictResolution =
  (typeof RuleConflictResolution)[keyof typeof RuleConflictResolution];

// --- B4-T1 anomaly_events (backend-detected anomalies) ---

export const AnomalySourceType = {
  COST_SPIKE: 'cost_spike',
  COST_DROP: 'cost_drop',
  DEPLOY_DROP: 'deploy_drop',
  SOURCE_SILENCE: 'source_silence',
  MARGIN_RISK: 'margin_risk',
} as const;

export type AnomalySourceType = (typeof AnomalySourceType)[keyof typeof AnomalySourceType];

export const AnomalyStatus = {
  OPEN: 'open',
  DISMISSED: 'dismissed',
  CONVERTED_TO_RULE: 'converted_to_rule',
  // Track 3 PR 3.5 (O22): anomalies auto-expire after 30 days. The next
  // detect-anomalies cycle re-creates if the underlying condition holds.
  // UI hides expired by default.
  EXPIRED: 'expired',
} as const;

export type AnomalyStatus = (typeof AnomalyStatus)[keyof typeof AnomalyStatus];

export const AnomalySeverity = {
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
} as const;

export type AnomalySeverity = (typeof AnomalySeverity)[keyof typeof AnomalySeverity];

// Top-driver slice kinds. Carries `provider` + `model` separately when
// kind === 'model' so consumers don't have to re-parse a slash-separated
// label (model names can themselves contain '/').
export const DriverKind = {
  STEP: 'step',
  MODEL: 'model',
  SOURCE: 'source',
} as const;

export type DriverKind = (typeof DriverKind)[keyof typeof DriverKind];

export interface AnomalyDriver {
  kind: DriverKind;
  /** Human-readable display string for alert templates / dashboard. */
  label: string;
  delta_usd: number;
  /** Set when kind === 'model'; lets consumers route by structured ref
   *  rather than re-parsing the label. */
  provider?: string;
  model?: string;
}

// Diagnosis is deterministic structured JSON (D10): no LLM-generated text.
export interface AnomalyDiagnosis {
  top_drivers?: AnomalyDriver[];
  iteration_inflation?: { step_name: string; from: number; to: number };
  insufficient_revenue_data?: boolean;
  notes?: string[];
}

export const AnomalyRecommendationAction = {
  CREATE_DRAFT_MODEL_ROUTING_RULE: 'create_draft_model_routing_rule',
  INVESTIGATE_DEEP_LINK: 'investigate_deep_link',
  DISMISS: 'dismiss',
} as const;

export type AnomalyRecommendationAction =
  (typeof AnomalyRecommendationAction)[keyof typeof AnomalyRecommendationAction];

// Recommendation is also deterministic; the "Apply as rule" path persists
// these payloads as draft rules.
export interface AnomalyRecommendation {
  action: AnomalyRecommendationAction;
  projected_savings_usd?: number;
  ab_suggestion?: { traffic_pct: number; rationale: string };
  draft_rule?: ModelRoutingConfig;
  deep_link_url?: string;
}

export interface AnomalyEvent {
  id: string;
  builder_id: string;
  customer_id: string | null;
  source_type: AnomalySourceType;
  status: AnomalyStatus;
  severity: AnomalySeverity;
  period_start: Date;
  period_end: Date;
  actual_value: number | null;
  baseline_value: number | null;
  delta_pct: number | null;
  diagnosis: AnomalyDiagnosis;
  recommendation: AnomalyRecommendation;
  created_at: Date;
  dismissed_at: Date | null;
}

export interface RulesResponse {
  rules: Rule[];
  // PR #70 follow-up — 60s per remaining-implementation-plan.md O25.
  // Plan trumps the older spec Section 4.10 (which said 300s).
  // Rationale: newly-activated reliability_failover / model_routing rules
  // need to reach SDKs in &lt;1 min, not 5.
  ttl_seconds: 60;
  fetched_at: string; // ISO 8601
}

// --- Budget sync (SDK ↔ backend reconciliation) ---

// B2a adds `scope` + `rule_id` so the backend can reconcile the correct
// accumulator key (per-customer vs pooled) rather than assuming per-customer.
export interface BudgetSyncRequest {
  rule_id: string;
  scope: RuleScope;
  customer_id: string | null; // null iff scope='pooled'
  accumulated_cost_usd: number;
  period_start: string; // ISO 8601
  event_count: number;
}

export interface BudgetSyncResponse {
  rule_id: string;
  scope: RuleScope;
  customer_id: string | null;
  period_start: string; // ISO 8601; echoes the request key
  server_total_usd: number; // REPLACES local accumulator (I-T3-3)
  budget_remaining_usd: number | null;
  budget_exceeded: boolean;
  reconciled_at: string; // ISO 8601
}
