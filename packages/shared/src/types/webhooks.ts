// Webhook + DLQ types — spec Section 4.10 + B2a §4.2 (migration 016 multichannel DLQ).

export const WebhookEventType = {
  COST_THRESHOLD_EXCEEDED: 'cost.threshold_exceeded',
  BUDGET_EXCEEDED: 'budget.exceeded',
  MARGIN_ALERT: 'margin.alert',
  BILLING_INVOICE_CREATED: 'billing.invoice_created',
  BILLING_PAYMENT_FAILED: 'billing.payment_failed', // B2b T2-D — Stripe invoice.payment_failed
  BILLING_DISPUTE_CREATED: 'billing.dispute_created', // B2b T2-D — Stripe charge.dispute.created
  INSTRUMENTATION_HEALTH: 'instrumentation.health',
  INSTRUMENTATION_SILENCE: 'instrumentation.silence', // B3-T4b — source stopped reporting events
  INSTRUMENTATION_COST_DROP: 'instrumentation.cost_drop', // B3-T4b — 7d avg <10% of 30d avg
  ANOMALY_DETECTED: 'anomaly.detected', // B4-4c — backend cron emitted an anomaly_event row
  BACKUP_MODEL_PRICE_CHANGED: 'backup_model.price_changed', // B4-4c-2 (D31) — failover backup-model price drifted >10% since consent
  RULE_FIRED: 'rule.fired', // internal DLQ default event_type
} as const;

export type WebhookEventType = (typeof WebhookEventType)[keyof typeof WebhookEventType];

export interface WebhookPayloadBase {
  id: string;
  type: WebhookEventType;
  builder_id: string;
  timestamp: string; // ISO 8601
}

export interface CostThresholdPayload extends WebhookPayloadBase {
  type: typeof WebhookEventType.COST_THRESHOLD_EXCEEDED;
  data: {
    customer_id: string | null;
    threshold_usd: number;
    current_usd: number;
    period: string;
    rule_id: string;
  };
}

export interface BudgetExceededPayload extends WebhookPayloadBase {
  type: typeof WebhookEventType.BUDGET_EXCEEDED;
  data: {
    customer_id: string | null;
    budget_usd: number;
    current_usd: number;
    action_taken: 'blocked' | 'warned';
    rule_id: string;
  };
}

export interface MarginAlertPayload extends WebhookPayloadBase {
  type: typeof WebhookEventType.MARGIN_ALERT;
  data: {
    customer_id: string | null;
    margin_percent: number;
    threshold_percent: number;
    // Preview-badge rule (D36): B2a returns skeletal top_drivers; B6 fills.
    diagnosis: { top_drivers: Array<{ label: string; cost_usd: number }> };
  };
}

export interface BillingInvoicePayload extends WebhookPayloadBase {
  type: typeof WebhookEventType.BILLING_INVOICE_CREATED;
  data: {
    customer_id: string;
    invoice_id: string;
    amount_usd: number;
    period_start: string;
    period_end: string;
  };
}

export interface InstrumentationHealthPayload extends WebhookPayloadBase {
  type: typeof WebhookEventType.INSTRUMENTATION_HEALTH;
  data: {
    status: 'healthy' | 'degraded' | 'missing';
    missing_sources: string[];
    last_event_at: string | null;
  };
}

export interface BillingPaymentFailedPayload extends WebhookPayloadBase {
  type: typeof WebhookEventType.BILLING_PAYMENT_FAILED;
  data: {
    customer_id: string;
    invoice_id: string;
    stripe_invoice_id: string;
    amount_usd: number;
    failure_reason: string | null;
    hosted_invoice_url: string | null;
  };
}

export interface BillingDisputeCreatedPayload extends WebhookPayloadBase {
  type: typeof WebhookEventType.BILLING_DISPUTE_CREATED;
  data: {
    dispute_id: string;
    charge_id: string;
    invoice_id: string | null;
    amount_usd: number;
    reason: string | null;
  };
}

export interface InstrumentationSilencePayload extends WebhookPayloadBase {
  type: typeof WebhookEventType.INSTRUMENTATION_SILENCE;
  data: {
    source_slug: string;
    source_display_name: string;
    last_seen_at: string | null;
    silent_hours: number;
    longest_historical_gap_hours: number;
  };
}

export interface InstrumentationCostDropPayload extends WebhookPayloadBase {
  type: typeof WebhookEventType.INSTRUMENTATION_COST_DROP;
  data: {
    source_slug: string;
    source_display_name: string;
    rolling_7d_avg_usd: number;
    rolling_30d_avg_usd: number;
    drop_percent: number;
  };
}

// Emitted by the hourly anomaly-detection cron. Carries the full
// diagnosis + recommendation so webhook receivers can route on
// `recommendation.action` without a follow-up dashboard fetch.
// `deep_link_url` is the recommender's dashboard target; alert
// templates surface it as the primary "Investigate" link.
//
// `data.diagnosis` and `data.recommendation` mirror the shapes from
// `rules.ts` (`AnomalyDiagnosis` / `AnomalyRecommendation`). Importing
// them here would force webhooks consumers to depend on the rules
// types; the inline shape keeps webhook recipients's surface narrow
// while the producer (anomaly-payloads.ts) maps from the canonical
// types.
export interface AnomalyDetectedPayload extends WebhookPayloadBase {
  type: typeof WebhookEventType.ANOMALY_DETECTED;
  data: {
    anomaly_id: string;
    customer_id: string | null;
    source_type: 'cost_spike' | 'cost_drop' | 'deploy_drop' | 'source_silence' | 'margin_risk';
    severity: 'info' | 'warn' | 'error';
    actual_value: number | null;
    baseline_value: number | null;
    delta_pct: number | null;
    period_start: string; // ISO 8601
    period_end: string; // ISO 8601
    diagnosis: {
      top_drivers?: Array<{
        kind: 'step' | 'model' | 'source';
        label: string;
        delta_usd: number;
        provider?: string;
        model?: string;
      }>;
      iteration_inflation?: { step_name: string; from: number; to: number };
      insufficient_revenue_data?: boolean;
      notes?: string[];
    };
    recommendation: {
      action: 'create_draft_model_routing_rule' | 'investigate_deep_link' | 'dismiss';
      projected_savings_usd?: number;
      ab_suggestion?: { traffic_pct: number; rationale: string };
      deep_link_url?: string;
    };
  };
}

// D31 — fired when a reliability_failover rule's recorded consent
// price drifts >10% from the current llm_pricing row. Consumers usually
// surface this as a "verify your failover backup is still cost-safe"
// nudge in the dashboard / channel.
export interface BackupModelPriceChangedPayload extends WebhookPayloadBase {
  type: typeof WebhookEventType.BACKUP_MODEL_PRICE_CHANGED;
  data: {
    rule_id: string;
    customer_id: string;
    backup_provider: string;
    backup_model: string;
    /** ISO 8601 — when the consent snapshot was taken. */
    consent_observed_at: string;
    /** USD per 1M input/output tokens at consent time. */
    consent_input_per_1m_usd: number;
    consent_output_per_1m_usd: number;
    /** Current llm_pricing row at the time of the alert. */
    current_input_per_1m_usd: number;
    current_output_per_1m_usd: number;
    /** Signed % delta on the (input + output) sum vs consent total. */
    delta_pct: number;
  };
}

export type WebhookPayload =
  | CostThresholdPayload
  | BudgetExceededPayload
  | MarginAlertPayload
  | BillingInvoicePayload
  | BillingPaymentFailedPayload
  | BillingDisputeCreatedPayload
  | InstrumentationHealthPayload
  | InstrumentationSilencePayload
  | InstrumentationCostDropPayload
  | AnomalyDetectedPayload
  | BackupModelPriceChangedPayload;

export interface WebhookConfig {
  id: string;
  builder_id: string;
  url: string;
  events: WebhookEventType[];
  secret: string; // HMAC-SHA256 secret (current)
  secret_prior: string | null; // B2a: 24h grace window on rotation (D33)
  secret_rotated_at: Date | null;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

// --- Multi-channel DLQ (migration 016) ---

export const AlertDeliveryChannel = {
  WEBHOOK: 'webhook',
  EMAIL: 'email',
  SLACK: 'slack',
} as const;

export type AlertDeliveryChannel = (typeof AlertDeliveryChannel)[keyof typeof AlertDeliveryChannel];

// DLQ entries are now channel-agnostic (B2a migration 016).
// payload is JSONB (not a string); channel_config_snapshot captures the
// config at fire-time so a retry in B2b replays against the frozen config
// (I-T4a-3).
export interface WebhookDlqEntry {
  id: string;
  builder_id: string;
  channel: AlertDeliveryChannel;
  webhook_config_id: string | null; // null for email/slack or after config delete
  channel_config_snapshot: Record<string, unknown>;
  event_type: string; // default 'rule.fired'
  payload: Record<string, unknown>;
  attempts: number;
  last_attempt_at: Date | null;
  last_error: string | null;
  created_at: Date;
}
