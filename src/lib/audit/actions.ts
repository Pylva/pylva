// Track 3 PR 3.1 — canonical audit-log action names.
// Per internal design notes.
//
// Centralizes the action strings so callers can't drift (e.g. typo
// 'rule.deleted' vs 'rule.delete'). Existing code uses string literals
// today; this module is the new source of truth — new call sites should
// import AuditAction.X here. Existing call sites are not retrofitted in
// this PR to keep the diff small; a follow-up sweep can migrate them.

export const AuditAction = {
  // Rules + channels (Track 1 PR 1.1 + B4-T1).
  // Activation route writes past-tense strings — constants mirror disk.
  RULE_CREATE: 'rule.create',
  RULE_UPDATE: 'rule.update',
  RULE_TOGGLE: 'rule.toggle',
  RULE_DELETE: 'rule.delete',
  RULE_ACTIVATED: 'rule.activated',
  RULE_DEACTIVATED: 'rule.deactivated',
  RULE_CHANNEL_ADD: 'rule.channel_add',
  RULE_CHANNEL_REMOVE: 'rule.channel_remove',

  // API keys (Track 1 PR 1.2)
  API_KEY_CREATE: 'api_key.create',
  API_KEY_REVOKE: 'api_key.revoke',
  API_KEY_ROTATE: 'api_key.rotate',

  // Webhooks (Track 1 PR 1.3)
  WEBHOOK_CREATE: 'webhook.create',
  WEBHOOK_UPDATE: 'webhook.update',
  WEBHOOK_ROTATE_SECRET: 'webhook.rotate_secret',
  WEBHOOK_DISABLE: 'webhook.disable',
  WEBHOOK_DELETE: 'webhook.delete',

  // DLQ (Track 1 PR 1.4)
  ALERT_DLQ_RETRY_SUCCESS: 'alert.dlq_retry_success',
  ALERT_DLQ_RETRY_FAILED: 'alert.dlq_retry_failed',
  ALERT_DLQ_DISMISS: 'alert.dlq_dismiss',
  ALERT_DLQ_PURGED: 'alert.dlq_purged',

  // Cost sources (Track 2 PR 2.3)
  COST_SOURCE_UPDATE_PRICING: 'cost_source.update_pricing',

  // Anomalies / recommendations (B4-T1).
  // Note: the on-disk strings are past-tense / "recommendation." prefixed
  // because they pre-date this module. Constants below mirror what's
  // actually written to audit_log so existing queries don't break.
  ANOMALY_DISMISSED: 'anomaly.dismissed',
  RECOMMENDATION_CONVERTED: 'recommendation.converted',

  // Feature flags (Track 3 PR 3.1)
  FEATURE_FLAG_OVERRIDE_SET: 'feature_flag.override_set',
  FEATURE_FLAG_OVERRIDE_CLEAR: 'feature_flag.override_clear',

  // Audit log housekeeping (Track 3 PR 3.1)
  AUDIT_LOG_PURGED: 'audit_log.purged',

  // Portal (Track 4)
  PORTAL_LINK_CREATE: 'portal.link_create',
  PORTAL_LINK_REVOKE: 'portal.link_revoke',
  PORTAL_CONFIG_UPDATE: 'portal.config_update',

  // Legacy B0–B2 entries — pre-date this module. Strings here mirror
  // what's already written to audit_log so historical queries keep
  // resolving. Don't rename without an audit_log migration.
  AUTH_LOGIN: 'auth.login',
  AUTH_LOGOUT: 'auth.logout',
  AUTH_OAUTH_LINKED: 'auth.oauth_linked',
  AUTH_MAGIC_LINK_SENT: 'auth.magic_link_sent',

  ORG_MEMBER_INVITED: 'org.member_invited',
  ORG_MEMBER_JOINED: 'org.member_joined',
  ORG_INVITE_REVOKED: 'org.invite_revoked',

  CUSTOM_PRICING_CREATE: 'custom_pricing.create',
  CUSTOM_PRICING_UPDATE: 'custom_pricing.update',
  CUSTOM_PRICING_DELETE: 'custom_pricing.delete',

  BILLING_PRICING_SET: 'billing.pricing_set',
  BILLING_PRICING_UNDO: 'billing.pricing_undo',
  BILLING_INVOICE_GENERATED: 'billing.invoice_generated',
  BILLING_INVOICE_FINALIZED: 'billing.invoice_finalized',
  BILLING_INVOICE_VOIDED: 'billing.invoice_voided',
  BILLING_INVOICE_PAID: 'billing.invoice_paid',
  BILLING_INVOICE_PAYMENT_FAILED: 'billing.invoice_payment_failed',
  BILLING_INVOICE_VIEWED: 'billing.invoice_viewed',
  BILLING_INVOICE_DEDUPE_HIT: 'billing.invoice_dedupe_hit',
  BILLING_DISPUTE_CREATED: 'billing.dispute_created',
  BILLING_ALERT_CONFIG_SET: 'billing.alert_config_set',
  BILLING_CONNECT_INITIATED: 'billing.connect_initiated',
  BILLING_STRIPE_CONNECTED: 'billing.stripe_connected',
  BILLING_STRIPE_CONNECTED_PENDING_CAPABILITIES: 'billing.stripe_connected_pending_capabilities',
  BILLING_STRIPE_DISCONNECTED: 'billing.stripe_disconnected',

  ONBOARDING_RESOLVED: 'onboarding.resolved',

  ALERT_SKIPPED_NO_CONFIG: 'alert_skipped_no_config',
  ALERT_SKIPPED_NO_INVOICE: 'alert_skipped_no_invoice',
  // Connect webhook replay/out-of-order delivery that a status guard
  // turned into a no-op. Distinct from ALERT_SKIPPED_NO_INVOICE (orphan).
  BILLING_WEBHOOK_REPLAY_IGNORED: 'billing.webhook_replay_ignored',

  // Rev 3 — self-billing tier sync (manual + Stripe-driven).
  BUILDER_TIER_CHANGED: 'builder.tier_changed',
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];
