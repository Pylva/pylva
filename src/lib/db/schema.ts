// Drizzle schema — DERIVATIVE of SQL migrations, not source of truth
// Decision #3: Raw SQL is migration source of truth. This file mirrors the
// migrations so Drizzle can typecheck queries; DDL is never generated from here.
// B2a additions: users, user_builder_memberships, invites, builder_feature_flags,
// alert_history, rule_alert_channels + column adds to builders, webhook_configs,
// webhook_dlq, audit_log.

import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  serial,
  bigserial,
  timestamp,
  jsonb,
  decimal,
  doublePrecision,
  inet,
  customType,
  uniqueIndex,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';
import {
  AnomalySeverity,
  AnomalyStatus,
  CostDisplayMode,
  InvoiceDetailLevel,
  PortalAccessGrantStatus,
  PortalCertificateStatus,
  PortalDnsStatus,
  PortalDomainStatus,
  PortalLinkStatus,
  PortalLinkType,
  RuleEventSeverity,
  VisibilityLevel,
} from '@pylva/shared';

// citext is not a built-in Drizzle type; declare a custom type that maps
// cleanly to postgres `citext` (provided by the citext extension enabled
// in migration 010).
const citext = customType<{ data: string; driverData: string }>({
  dataType: () => 'citext',
});

// --- builders ---
export const builders = pgTable('builders', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  name: varchar('name', { length: 255 }),
  tier: varchar('tier', { length: 20 }).notNull().default('free'),
  // B2a migration 011: slugged URLs (/o/{slug}/...)
  slug: text('slug').notNull().unique(),
  // B2a migration 015: OAuth-sourced display metadata
  display_name: text('display_name'),
  avatar_url: text('avatar_url'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// --- customers ---
export const customers = pgTable('customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  builder_id: uuid('builder_id').notNull().references(() => builders.id, { onDelete: 'cascade' }),
  external_id: varchar('external_id', { length: 255 }).notNull(),
  name: varchar('name', { length: 255 }),
  email: varchar('email', { length: 255 }),
  metadata: jsonb('metadata').default({}),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('idx_customers_builder_external').on(table.builder_id, table.external_id),
  index('idx_customers_builder').on(table.builder_id),
]);

// --- api_keys ---
export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  key_id: varchar('key_id', { length: 12 }).notNull().unique(),
  builder_id: uuid('builder_id').notNull().references(() => builders.id, { onDelete: 'cascade' }),
  key_hash: text('key_hash').notNull(),
  scope: varchar('scope', { length: 20 }).notNull(),
  label: varchar('label', { length: 100 }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expires_at: timestamp('expires_at', { withTimezone: true }),
  revoked_at: timestamp('revoked_at', { withTimezone: true }),
}, (table) => [
  index('idx_api_keys_builder').on(table.builder_id),
]);

// --- llm_pricing ---
export const llmPricing = pgTable('llm_pricing', {
  id: serial('id').primaryKey(),
  provider: varchar('provider', { length: 255 }).notNull(),
  model: varchar('model', { length: 255 }).notNull(),
  input_per_1m: decimal('input_per_1m', { precision: 10, scale: 4 }).notNull(),
  output_per_1m: decimal('output_per_1m', { precision: 10, scale: 4 }).notNull(),
  effective_from: timestamp('effective_from', { withTimezone: true }).notNull(),
  effective_to: timestamp('effective_to', { withTimezone: true }),
  source: varchar('source', { length: 20 }).notNull().default('admin'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_llm_pricing_lookup').on(table.provider, table.model, table.effective_from),
]);

// --- rules ---
export const rules = pgTable('rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  builder_id: uuid('builder_id').notNull().references(() => builders.id, { onDelete: 'cascade' }),
  type: varchar('type', { length: 30 }).notNull(),
  enforcement: varchar('enforcement', { length: 20 }).notNull(),
  name: varchar('name', { length: 200 }).notNull(),
  enabled: boolean('enabled').notNull().default(true),
  config: jsonb('config').notNull().default({}),
  customer_id: varchar('customer_id', { length: 255 }),
  // B3 migration 026: draft rules are simulator recommendations (D17).
  status: varchar('status', { length: 20 }).notNull().default('active'),
  // B4 migration 028: activation + diagnostic columns.
  activated_at: timestamp('activated_at', { withTimezone: true }),
  last_triggered_at: timestamp('last_triggered_at', { withTimezone: true }),
  last_error: varchar('last_error', { length: 2000 }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_rules_builder').on(table.builder_id),
  index('idx_rules_builder_status').on(table.builder_id, table.status),
]);

// --- custom_rule_requests ---
export const customRuleRequests = pgTable('custom_rule_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  builder_id: uuid('builder_id').notNull().references(() => builders.id, { onDelete: 'cascade' }),
  requester_user_id: uuid('requester_user_id').references(() => users.id, { onDelete: 'set null' }),
  requester_email: text('requester_email').notNull(),
  requester_display_name: text('requester_display_name'),
  workspace_name: text('workspace_name'),
  workspace_slug: text('workspace_slug').notNull(),
  workspace_email: text('workspace_email').notNull(),
  workspace_tier: text('workspace_tier').notNull(),
  idea: text('idea').notNull(),
  email_status: text('email_status').notNull().default('pending'),
  internal_email_sent: boolean('internal_email_sent').notNull().default(false),
  receipt_email_sent: boolean('receipt_email_sent').notNull().default(false),
  last_email_error: text('last_email_error'),
  submitted_at: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_custom_rule_requests_builder_submitted').on(table.builder_id, table.submitted_at),
  index('idx_custom_rule_requests_status_submitted').on(table.email_status, table.submitted_at),
]);

// --- rule_events (B4 migration 028: per-rule activity log) ---
export const ruleEvents = pgTable('rule_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  builder_id: uuid('builder_id').notNull().references(() => builders.id, { onDelete: 'cascade' }),
  rule_id: uuid('rule_id').references(() => rules.id, { onDelete: 'set null' }),
  customer_id: varchar('customer_id', { length: 255 }),
  event_type: varchar('event_type', { length: 60 }).notNull(),
  severity: varchar('severity', { length: 20 }).notNull().default(RuleEventSeverity.INFO),
  provider: varchar('provider', { length: 255 }),
  model_from: varchar('model_from', { length: 255 }),
  model_to: varchar('model_to', { length: 255 }),
  message: text('message').notNull(),
  metadata: jsonb('metadata').notNull().default({}),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_rule_events_builder_customer_created').on(table.builder_id, table.customer_id, table.created_at),
  index('idx_rule_events_builder_rule_created').on(table.builder_id, table.rule_id, table.created_at),
]);

// --- anomaly_events (B4 migration 028: backend-detected cost anomalies) ---
export const anomalyEvents = pgTable('anomaly_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  builder_id: uuid('builder_id').notNull().references(() => builders.id, { onDelete: 'cascade' }),
  customer_id: varchar('customer_id', { length: 255 }),
  source_type: varchar('source_type', { length: 40 }).notNull(),
  status: varchar('status', { length: 40 }).notNull().default(AnomalyStatus.OPEN),
  severity: varchar('severity', { length: 20 }).notNull().default(AnomalySeverity.WARN),
  period_start: timestamp('period_start', { withTimezone: true }).notNull(),
  period_end: timestamp('period_end', { withTimezone: true }).notNull(),
  actual_value: decimal('actual_value'),
  baseline_value: decimal('baseline_value'),
  delta_pct: decimal('delta_pct'),
  diagnosis: jsonb('diagnosis').notNull().default({}),
  recommendation: jsonb('recommendation').notNull().default({}),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  dismissed_at: timestamp('dismissed_at', { withTimezone: true }),
}, (table) => [
  index('idx_anomaly_events_builder_status_created').on(table.builder_id, table.status, table.created_at),
  index('idx_anomaly_events_builder_customer_created').on(table.builder_id, table.customer_id, table.created_at),
  // Partial unique index (NULLS NOT DISTINCT) gating idempotent anomaly
  // inserts lives in 030_b4_anomaly_idempotency.sql — Drizzle doesn't
  // model partial-where or NULLS NOT DISTINCT yet.
]);

// --- webhook_configs (B2a migration 013: secret rotation grace) ---
export const webhookConfigs = pgTable('webhook_configs', {
  id: uuid('id').primaryKey().defaultRandom(),
  builder_id: uuid('builder_id').notNull().references(() => builders.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  events: text('events').array().notNull(),
  secret: text('secret').notNull(),
  secret_prior: text('secret_prior'),
  secret_rotated_at: timestamp('secret_rotated_at', { withTimezone: true }),
  enabled: boolean('enabled').notNull().default(true),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_webhook_configs_builder').on(table.builder_id),
]);

// --- webhook_dlq (B2a migration 016: multichannel + config snapshot) ---
export const webhookDlq = pgTable('webhook_dlq', {
  id: uuid('id').primaryKey().defaultRandom(),
  builder_id: uuid('builder_id').notNull().references(() => builders.id, { onDelete: 'cascade' }),
  // webhook_config_id nullable: email/slack rows have no webhook_configs row, and
  // orphaned (deleted) webhook configs leave the reference null.
  webhook_config_id: uuid('webhook_config_id').references(() => webhookConfigs.id, { onDelete: 'set null' }),
  channel: text('channel').notNull().default('webhook'),
  channel_config_snapshot: jsonb('channel_config_snapshot').notNull().default({}),
  event_type: text('event_type').notNull().default('rule.fired'),
  payload: jsonb('payload').notNull(),
  attempts: integer('attempts').notNull().default(0),
  last_attempt_at: timestamp('last_attempt_at', { withTimezone: true }),
  last_error: text('last_error'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_webhook_dlq_builder').on(table.builder_id),
  index('idx_webhook_dlq_channel').on(table.channel, table.created_at),
]);

// --- audit_log (B2a migration 019: actor_user_id) ---
export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'number' }),
  builder_id: uuid('builder_id').notNull(),
  actor_type: varchar('actor_type', { length: 20 }).notNull(),
  actor_id: varchar('actor_id', { length: 255 }).notNull(),
  actor_user_id: uuid('actor_user_id'),
  action: varchar('action', { length: 50 }).notNull(),
  resource_type: varchar('resource_type', { length: 50 }).notNull(),
  resource_id: varchar('resource_id', { length: 255 }),
  details: jsonb('details'),
  ip_address: inet('ip_address'),
  timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
});

// --- stripe_connect_event_log (migration 039: Connect webhook idempotency) ---
// At-least-once idempotency for builder Connect webhooks. Scoped by Stripe
// account because Connect event ids are delivered in account context.
export const stripeConnectEventLog = pgTable('stripe_connect_event_log', {
  stripe_account_id: text('stripe_account_id').notNull(),
  stripe_event_id: text('stripe_event_id').notNull(),
  type: text('type').notNull(),
  builder_id: uuid('builder_id'),
  received_at: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  processing_started_at: timestamp('processing_started_at', { withTimezone: true }),
  handled_at: timestamp('handled_at', { withTimezone: true }),
  last_error: text('last_error'),
}, (table) => [
  primaryKey({ columns: [table.stripe_account_id, table.stripe_event_id] }),
  index('idx_stripe_connect_event_log_received').on(table.received_at),
  index('idx_stripe_connect_event_log_builder_received').on(table.builder_id, table.received_at),
  // Partial index idx_stripe_connect_event_log_unhandled (WHERE handled_at IS NULL)
  // lives in migration 039 per Decision #3.
]);

// --- feature_flag_overrides (Track 3 PR 3.1: O29) ---
// Per-builder override on top of env defaults. Resolution: env default OR
// builder override (override wins). Migration 032.
export const featureFlagOverrides = pgTable('feature_flag_overrides', {
  builder_id: uuid('builder_id').notNull().references(() => builders.id, { onDelete: 'cascade' }),
  flag_name: text('flag_name').notNull(),
  enabled: boolean('enabled').notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.builder_id, table.flag_name] }),
  index('idx_feature_flag_overrides_flag').on(table.flag_name),
]);

// --- customer_pricing (B2b migration 022: versioned) ---
// Writes = INSERT-of-new-version + UPDATE prior row's effective_to inside a
// single transaction. Reads for invoice generation use effective_from / to
// overlap against the billing period (see src/lib/billing/pricing-versioning.ts).
export const customerPricing = pgTable('customer_pricing', {
  id: uuid('id').primaryKey().defaultRandom(),
  builder_id: uuid('builder_id').notNull().references(() => builders.id, { onDelete: 'cascade' }),
  customer_id: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  pricing_model: varchar('pricing_model', { length: 20 }).notNull(),
  flat_rate_usd: decimal('flat_rate_usd', { precision: 10, scale: 2 }),
  per_unit_rates: jsonb('per_unit_rates'),
  credit_balance: decimal('credit_balance', { precision: 10, scale: 2 }),
  billing_period: varchar('billing_period', { length: 20 }).notNull().default('monthly'),
  stripe_customer_id: varchar('stripe_customer_id', { length: 255 }),
  // B2b migration 022 additions
  version: integer('version').notNull().default(1),
  effective_from: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
  effective_to: timestamp('effective_to', { withTimezone: true }),
  pack_price_usd: decimal('pack_price_usd', { precision: 10, scale: 2 }),
  included_credits: decimal('included_credits', { precision: 18, scale: 4 }),
  overage_rate_usd: decimal('overage_rate_usd', { precision: 18, scale: 10 }),
  markup_pct: decimal('markup_pct', { precision: 5, scale: 2 }),
  base_fee_usd: decimal('base_fee_usd', { precision: 10, scale: 2 }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('customer_pricing_builder_customer_version_uk').on(table.builder_id, table.customer_id, table.version),
  index('idx_customer_pricing_effective').on(table.builder_id, table.customer_id, table.effective_from, table.effective_to),
]);

// --- invoices (B2b migration 023: cycle + webhook timestamps) ---
export const invoices = pgTable('invoices', {
  id: uuid('id').primaryKey().defaultRandom(),
  builder_id: uuid('builder_id').notNull().references(() => builders.id, { onDelete: 'cascade' }),
  customer_id: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  stripe_invoice_id: varchar('stripe_invoice_id', { length: 255 }),
  amount_usd: decimal('amount_usd', { precision: 10, scale: 2 }).notNull(),
  period_start: timestamp('period_start', { withTimezone: true }).notNull(),
  period_end: timestamp('period_end', { withTimezone: true }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  line_items: jsonb('line_items').notNull().default([]),
  // B2b migration 023 additions
  billing_cycle_id: uuid('billing_cycle_id'),
  pricing_version: integer('pricing_version'),
  has_unpriced_events: boolean('has_unpriced_events').notNull().default(false),
  paid_at: timestamp('paid_at', { withTimezone: true }),
  payment_failed_at: timestamp('payment_failed_at', { withTimezone: true }),
  last_viewed_at: timestamp('last_viewed_at', { withTimezone: true }),
  // Track 1 PR 1.5 / migration 031: deterministic per-(builder, customer,
  // period, pricing_version, slice) key for monthly-cron dedupe.
  draft_key: text('draft_key'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_invoices_cycle').on(table.builder_id, table.billing_cycle_id),
]);

// --- stripe_connect (B2b migration 025: widened status + capabilities_ok) ---
export const stripeConnect = pgTable('stripe_connect', {
  id: uuid('id').primaryKey().defaultRandom(),
  builder_id: uuid('builder_id').notNull().references(() => builders.id, { onDelete: 'cascade' }).unique(),
  stripe_account_id: varchar('stripe_account_id', { length: 255 }),
  // Status CHECK (migration 025): not_connected | pending_onboarding | connected |
  // connected_pending_capabilities | disconnected.
  status: varchar('status', { length: 40 }).notNull().default('not_connected'),
  capabilities_ok: boolean('capabilities_ok').notNull().default(false),
  connected_at: timestamp('connected_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// --- invoice_idempotency (B2b migration 021 + Track 1 PR 1.5 / migration 031) ---
// Builder-supplied Idempotency-Key → claimed invoice. TTL 24h (purged by cron).
// Migration 031 (Track 1 PR 1.5) recreated this table with a composite PK
// (builder_id, idempotency_key) so two distinct builders can use the same
// Idempotency-Key without colliding (per Rev-2 O4).
export const invoiceIdempotency = pgTable('invoice_idempotency', {
  builder_id: uuid('builder_id').notNull().references(() => builders.id, { onDelete: 'cascade' }),
  idempotency_key: text('idempotency_key').notNull(),
  invoice_id: uuid('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),
  request_hash: text('request_hash').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.builder_id, table.idempotency_key] }),
  index('idx_invoice_idempotency_created').on(table.created_at),
]);

// --- builder_alert_config (B2b migration 024) ---
// Builder-level alert channel for Stripe webhook events (payment_failed,
// dispute). Distinct from per-rule channels — disabling one doesn't affect
// the other. Exactly-one-of CHECK enforced in migration; TS-side validators
// in src/lib/alerts/builder-alert.ts.
export const builderAlertConfig = pgTable('builder_alert_config', {
  builder_id: uuid('builder_id').primaryKey().references(() => builders.id, { onDelete: 'cascade' }),
  channel: text('channel').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  webhook_config_id: uuid('webhook_config_id').references(() => webhookConfigs.id, { onDelete: 'set null' }),
  email_recipients: text('email_recipients').array(),
  slack_webhook_url: text('slack_webhook_url'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// --- portal_configs (B4 migration 029: replaces JSONB blobs with typed columns) ---
export const portalConfigs = pgTable('portal_configs', {
  id: uuid('id').primaryKey().defaultRandom(),
  builder_id: uuid('builder_id').notNull().references(() => builders.id, { onDelete: 'cascade' }).unique(),
  // Branding (was: branding JSONB blob)
  company_name: text('company_name'),
  logo_url: text('logo_url'),
  primary_color: text('primary_color'),
  secondary_color: text('secondary_color'),
  accent_color: text('accent_color'),
  // Display
  cost_display_mode: varchar('cost_display_mode', { length: 20 }).notNull().default(CostDisplayMode.USD),
  credit_label: text('credit_label').notNull().default('credits'),
  visibility_level: varchar('visibility_level', { length: 40 }).notNull().default(VisibilityLevel.AGGREGATE_ONLY),
  invoice_detail_level: varchar('invoice_detail_level', { length: 20 }).notNull().default(InvoiceDetailLevel.SUMMARY_ONLY),
  show_budget_progress: boolean('show_budget_progress').notNull().default(true),
  show_usage_trend: boolean('show_usage_trend').notNull().default(true),
  // D7: portal defaults to usage-only — invoices are opt-in.
  show_invoices: boolean('show_invoices').notNull().default(false),
  show_non_llm_sources: boolean('show_non_llm_sources').notNull().default(false),
  // Iframe + OAuth
  allowed_iframe_origins: text('allowed_iframe_origins').array().notNull().default([]),
  oauth_config: jsonb('oauth_config'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// --- portal_links (B4 migration 029: jti revocation shape) ---
export const portalLinks = pgTable('portal_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  builder_id: uuid('builder_id').notNull().references(() => builders.id, { onDelete: 'cascade' }),
  customer_id: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  jti: uuid('jti').notNull().unique(),
  token_hash: text('token_hash').notNull(),
  link_type: varchar('link_type', { length: 20 }).notNull().default(PortalLinkType.STANDARD),
  status: varchar('status', { length: 20 }).notNull().default(PortalLinkStatus.ACTIVE),
  expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  first_used_at: timestamp('first_used_at', { withTimezone: true }),
  grace_expires_at: timestamp('grace_expires_at', { withTimezone: true }),
  revoked_at: timestamp('revoked_at', { withTimezone: true }),
  created_by: uuid('created_by').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_portal_links_builder_customer_status').on(table.builder_id, table.customer_id, table.status),
]);

// --- portal_sessions (Track 4 PR 4.1: O7 + O8) ---
// Long-lived link → 8h hard session, sliding within window. See
// db/migrations/033_portal_sessions.sql for the contract.
export const portalSessions = pgTable('portal_sessions', {
  jti: uuid('jti').primaryKey(),
  builder_id: uuid('builder_id').notNull().references(() => builders.id, { onDelete: 'cascade' }),
  customer_id: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  link_id: uuid('link_id').notNull(),
  issued_at: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  last_activity_at: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
  hard_expires_at: timestamp('hard_expires_at', { withTimezone: true }).notNull(),
}, (table) => [
  index('idx_portal_sessions_builder_customer').on(table.builder_id, table.customer_id),
  index('idx_portal_sessions_hard_expires').on(table.hard_expires_at),
]);

// --- portal_access_grants (B4 migration 029: OAuth email allowlist) ---
export const portalAccessGrants = pgTable('portal_access_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  builder_id: uuid('builder_id').notNull().references(() => builders.id, { onDelete: 'cascade' }),
  customer_id: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  status: varchar('status', { length: 20 }).notNull().default(PortalAccessGrantStatus.ACTIVE),
  created_by: uuid('created_by').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revoked_at: timestamp('revoked_at', { withTimezone: true }),
}, (table) => [
  uniqueIndex('idx_portal_access_grants_unique').on(table.builder_id, table.customer_id, table.email),
  index('idx_portal_access_grants_builder_email').on(table.builder_id, table.email),
]);

// --- portal_domains (B4 migration 029: self-serve custom domain lifecycle) ---
export const portalDomains = pgTable('portal_domains', {
  id: uuid('id').primaryKey().defaultRandom(),
  builder_id: uuid('builder_id').notNull().references(() => builders.id, { onDelete: 'cascade' }),
  domain: text('domain').notNull().unique(),
  verification_token: text('verification_token').notNull(),
  dns_status: varchar('dns_status', { length: 40 }).notNull().default(PortalDnsStatus.PENDING_DNS),
  certificate_status: varchar('certificate_status', { length: 40 }).notNull().default(PortalCertificateStatus.NONE),
  domain_status: varchar('domain_status', { length: 40 }).notNull().default(PortalDomainStatus.PENDING_DNS),
  certificate_arn: text('certificate_arn'),
  last_checked_at: timestamp('last_checked_at', { withTimezone: true }),
  error_detail: text('error_detail'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_portal_domains_status').on(table.domain_status),
  index('idx_portal_domains_builder').on(table.builder_id),
]);

// --- api_key_vault (dormant — BYOK deferred post-PMF, per internal design notes) ---
export const apiKeyVault = pgTable('api_key_vault', {
  id: serial('id').primaryKey(),
  builder_id: uuid('builder_id').notNull().references(() => builders.id, { onDelete: 'cascade' }),
  customer_id: varchar('customer_id', { length: 255 }),
  provider: varchar('provider', { length: 255 }).notNull(),
  encrypted_key: text('encrypted_key').notNull(),
  nonce: text('nonce').notNull(),
  auth_tag: text('auth_tag').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  rotated_at: timestamp('rotated_at', { withTimezone: true }),
});

// --- custom_pricing (B1 migration 005) ---
export const customPricing = pgTable('custom_pricing', {
  id: uuid('id').primaryKey().defaultRandom(),
  builder_id: uuid('builder_id').notNull().references(() => builders.id, { onDelete: 'cascade' }),
  provider: varchar('provider', { length: 255 }),
  model: varchar('model', { length: 255 }),
  metric: varchar('metric', { length: 200 }),
  price_per_unit_usd: decimal('price_per_unit_usd', { precision: 18, scale: 10 }).notNull(),
  input_per_1m_usd: decimal('input_per_1m_usd', { precision: 18, scale: 10 }),
  output_per_1m_usd: decimal('output_per_1m_usd', { precision: 18, scale: 10 }),
  effective_from: timestamp('effective_from', { withTimezone: true }).notNull(),
  effective_to: timestamp('effective_to', { withTimezone: true }),
  source: text('source').notNull(),
  created_by: uuid('created_by'),
  notes: text('notes'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// --- pricing_onboarding_tasks (B1 migration 006) ---
export const pricingOnboardingTasks = pgTable('pricing_onboarding_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  builder_id: uuid('builder_id').notNull().references(() => builders.id, { onDelete: 'cascade' }),
  provider: varchar('provider', { length: 255 }),
  model: varchar('model', { length: 255 }),
  metric: varchar('metric', { length: 200 }),
  status: text('status').notNull().default('open'),
  first_seen_at: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  resolved_at: timestamp('resolved_at', { withTimezone: true }),
  resolved_by: uuid('resolved_by'),
});

// --- pricing_sync_log (B1 migration 007) ---
export const pricingSyncLog = pgTable('pricing_sync_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  run_at: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
  status: text('status').notNull(),
  failure_reason: text('failure_reason'),
  models_synced: integer('models_synced').notNull().default(0),
  models_skipped: integer('models_skipped').notNull().default(0),
  attempt_number: integer('attempt_number').notNull().default(1),
  source: text('source').notNull().default('litellm'),
});

// --- B2a: users (migration 010) ---
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: citext('email').notNull().unique(),
  display_name: text('display_name'),
  avatar_url: text('avatar_url'),
  // Migration 012 adds auth_provider as nullable TEXT with CHECK constraint.
  auth_provider: text('auth_provider'),
  last_login_at: timestamp('last_login_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_users_email').on(table.email),
]);

// --- B2a: user_builder_memberships (migration 010) ---
export const userBuilderMemberships = pgTable('user_builder_memberships', {
  id: uuid('id').primaryKey().defaultRandom(),
  user_id: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  builder_id: uuid('builder_id').notNull().references(() => builders.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('user_builder_memberships_user_builder_uniq').on(table.user_id, table.builder_id),
  index('idx_memberships_user').on(table.user_id),
  index('idx_memberships_builder').on(table.builder_id),
]);

// --- B2a: invites (migration 010) ---
export const invites = pgTable('invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  builder_id: uuid('builder_id').notNull().references(() => builders.id, { onDelete: 'cascade' }),
  email: citext('email').notNull(),
  role: text('role').notNull(),
  token: text('token').notNull().unique(),
  expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  accepted_at: timestamp('accepted_at', { withTimezone: true }),
  invited_by_user_id: uuid('invited_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_invites_builder').on(table.builder_id),
  index('idx_invites_token').on(table.token),
  index('idx_invites_email').on(table.email),
]);

// --- B2a: alert_history (migration 014) ---
export const alertHistory = pgTable('alert_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  builder_id: uuid('builder_id').notNull().references(() => builders.id, { onDelete: 'cascade' }),
  rule_id: uuid('rule_id').notNull().references(() => rules.id, { onDelete: 'cascade' }),
  fired_at: timestamp('fired_at', { withTimezone: true }).notNull().defaultNow(),
  payload: jsonb('payload').notNull(),
  delivery_status: jsonb('delivery_status').notNull().default({}),
}, (table) => [
  index('idx_alert_history_builder_fired').on(table.builder_id, table.fired_at),
  index('idx_alert_history_rule').on(table.rule_id, table.fired_at),
]);

// --- B2a: rule_alert_channels (migration 017) ---
export const ruleAlertChannels = pgTable('rule_alert_channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  rule_id: uuid('rule_id').notNull().references(() => rules.id, { onDelete: 'cascade' }),
  channel: text('channel').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  webhook_config_id: uuid('webhook_config_id').references(() => webhookConfigs.id, { onDelete: 'set null' }),
  email_recipients: text('email_recipients').array(),
  slack_webhook_url: text('slack_webhook_url'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_rule_alert_channels_rule').on(table.rule_id),
]);

// --- B2a: builder_feature_flags (migration 018) ---
// --- cost_sources (B3 migration 026) ---
export const costSources = pgTable('cost_sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  builder_id: uuid('builder_id').notNull().references(() => builders.id, { onDelete: 'cascade' }),
  source_type: varchar('source_type', { length: 30 }).notNull(),
  display_name: varchar('display_name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 100 }).notNull(),
  metric: varchar('metric', { length: 100 }),
  unit: varchar('unit', { length: 50 }),
  price_per_unit: decimal('price_per_unit', { precision: 12, scale: 6 }),
  pricing_tiers: jsonb('pricing_tiers'),
  status: varchar('status', { length: 20 }).notNull().default('healthy'),
  tracking_status: varchar('tracking_status', { length: 20 }).notNull().default('tracked'),
  matchers: text('matchers').array().notNull().default([]),
  default_metric_value: doublePrecision('default_metric_value'),
  last_seen_at: timestamp('last_seen_at', { withTimezone: true }),
  last_discovered_at: timestamp('last_discovered_at', { withTimezone: true }),
  discovery_count: integer('discovery_count').notNull().default(0),
  approved_at: timestamp('approved_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('idx_cost_sources_builder_slug').on(table.builder_id, table.slug),
  index('idx_cost_sources_builder').on(table.builder_id),
  index('idx_cost_sources_builder_status').on(table.builder_id, table.status),
  index('idx_cost_sources_builder_tracking_status').on(table.builder_id, table.tracking_status),
]);

export const builderFeatureFlags = pgTable('builder_feature_flags', {
  builder_id: uuid('builder_id').primaryKey().references(() => builders.id, { onDelete: 'cascade' }),
  flags: jsonb('flags').notNull().default({}),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
