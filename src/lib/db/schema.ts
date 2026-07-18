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
  bigint,
  serial,
  bigserial,
  timestamp,
  jsonb,
  decimal,
  char,
  doublePrecision,
  inet,
  customType,
  uniqueIndex,
  index,
  primaryKey,
  check,
  foreignKey,
  unique,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql as drizzleSql } from 'drizzle-orm';
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

// --- authoritative budget-control ledger (migration 050) ---
// Migration 051 adds typed cutover readiness, account opening evidence, and
// widened post-provider actual/overage evidence to this same mirror.
// PostgreSQL is the control and billing authority. These tables deliberately
// retain the tenant key in every primary/foreign key so a child row can never
// point across builders. There are no foreign keys to mutable rule or customer
// rows: the server stores immutable rule/pricing snapshots and external
// customer identifiers instead.
export const budgetControlCutovers = pgTable('budget_control_cutovers', {
  builder_id: uuid('builder_id')
    .primaryKey()
    .references(() => builders.id, { onDelete: 'restrict' }),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  mode: varchar('mode', { length: 20 }).notNull(),
  cutover_at: timestamp('cutover_at', { withTimezone: true }).notNull().defaultNow(),
  reconciled_through: timestamp('reconciled_through', { withTimezone: true }),
  reconciliation_snapshot: jsonb('reconciliation_snapshot'),
  reconciliation_snapshot_hash: char('reconciliation_snapshot_hash', { length: 64 }),
  ready_at: timestamp('ready_at', { withTimezone: true }),
  ready_order: bigint('ready_order', { mode: 'bigint' }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check(
    'budget_control_cutovers_status_ck',
    drizzleSql`${table.status} IN ('pending', 'ready')`,
  ),
  check(
    'budget_control_cutovers_mode_ck',
    drizzleSql`${table.mode} IN ('next_period', 'exact_backfill')`,
  ),
  check(
    'budget_control_cutovers_lifecycle_ck',
    drizzleSql`(${table.status} = 'pending'
        AND ${table.reconciled_through} IS NULL
        AND ${table.reconciliation_snapshot} IS NULL
        AND ${table.reconciliation_snapshot_hash} IS NULL
        AND ${table.ready_at} IS NULL
        AND ${table.ready_order} IS NULL)
      OR (${table.status} = 'ready'
        AND ${table.ready_at} IS NOT NULL
        AND ${table.ready_order} IS NOT NULL
        AND ${table.ready_at} >= ${table.cutover_at}
        AND ((${table.mode} = 'next_period'
            AND ${table.reconciled_through} IS NULL
            AND ${table.reconciliation_snapshot} IS NULL
            AND ${table.reconciliation_snapshot_hash} IS NULL)
          OR (${table.mode} = 'exact_backfill'
            AND ${table.reconciled_through} IS NOT DISTINCT FROM ${table.cutover_at}
            AND ${table.reconciliation_snapshot} IS NOT NULL
            AND ${table.reconciliation_snapshot_hash} IS NOT NULL)))`,
  ),
  check(
    'budget_control_cutovers_ready_order_ck',
    drizzleSql`(${table.status} = 'pending' AND ${table.ready_order} IS NULL)
      OR (${table.status} = 'ready'
        AND ${table.ready_order} BETWEEN 1 AND 9223372036854775806)`,
  ),
  check(
    'budget_control_cutovers_reconciliation_ck',
    drizzleSql`${table.reconciliation_snapshot} IS NULL
      OR (jsonb_typeof(${table.reconciliation_snapshot}) IS NOT DISTINCT FROM 'object'
        AND ${table.reconciliation_snapshot} = jsonb_build_object(
          'schema_version', '1.0',
          'builder_id', ${table.builder_id}::TEXT,
          'mode', 'exact_backfill',
          'cutover_at', public.pylva_budget_timestamp_text(${table.cutover_at}),
          'reconciled_through',
            public.pylva_budget_timestamp_text(${table.reconciled_through})
        )
        AND ${table.reconciliation_snapshot_hash} ~ '^[0-9a-f]{64}$'
        AND ${table.reconciliation_snapshot_hash} =
          public.pylva_budget_jsonb_sha256(${table.reconciliation_snapshot}))`,
  ),
  check(
    'budget_control_cutovers_timestamps_ck',
    drizzleSql`public.pylva_budget_timestamp_is_wire_safe(${table.cutover_at})
      AND public.pylva_budget_timestamp_is_wire_safe(${table.created_at})
      AND public.pylva_budget_timestamp_is_wire_safe(${table.updated_at})
      AND ${table.updated_at} >= ${table.created_at}
      AND (${table.reconciled_through} IS NULL
        OR public.pylva_budget_timestamp_is_wire_safe(${table.reconciled_through}))
      AND (${table.ready_at} IS NULL
        OR public.pylva_budget_timestamp_is_wire_safe(${table.ready_at}))`,
  ),
]);

export const budgetRuleRevisions = pgTable('budget_rule_revisions', {
  builder_id: uuid('builder_id').notNull().references(() => builders.id, { onDelete: 'restrict' }),
  id: uuid('id').notNull().defaultRandom(),
  rule_key: uuid('rule_key').notNull(),
  revision: bigint('revision', { mode: 'bigint' }).notNull(),
  authority_order: bigint('authority_order', { mode: 'bigint' }).notNull(),
  scope: varchar('scope', { length: 20 }).notNull(),
  target_customer_id: varchar('target_customer_id', { length: 255 }),
  period: varchar('period', { length: 20 }).notNull(),
  enforcement: varchar('enforcement', { length: 20 }).notNull(),
  limit_usd: decimal('limit_usd', { precision: 38, scale: 18 }).notNull(),
  config_snapshot: jsonb('config_snapshot').notNull(),
  config_snapshot_hash: char('config_snapshot_hash', { length: 64 }).notNull(),
  active_from: timestamp('active_from', { withTimezone: true }).notNull().defaultNow(),
  retired_at: timestamp('retired_at', { withTimezone: true }),
  retirement_reason: varchar('retirement_reason', { length: 20 }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({
    name: 'budget_rule_revisions_pk',
    columns: [table.builder_id, table.id],
  }),
  unique('budget_rule_revisions_rule_revision_uk').on(
    table.builder_id,
    table.rule_key,
    table.revision,
  ),
  unique('budget_rule_revisions_authority_order_uk').on(table.authority_order),
  unique('budget_rule_revisions_allocation_identity_uk').on(
    table.builder_id,
    table.id,
    table.rule_key,
  ),
  uniqueIndex('budget_rule_revisions_one_active_uk')
    .on(table.builder_id, table.rule_key)
    .where(drizzleSql`${table.retired_at} IS NULL`),
  index('idx_budget_rule_revisions_builder_rule').on(
    table.builder_id,
    table.rule_key,
    table.revision.desc(),
  ),
  index('idx_budget_rule_revisions_active_scope')
    .on(
      table.builder_id,
      table.scope,
      table.target_customer_id,
      table.period,
      table.rule_key,
      table.id,
    )
    .where(drizzleSql`${table.retired_at} IS NULL`),
  check(
    'budget_rule_revisions_revision_ck',
    drizzleSql`${table.revision} BETWEEN 0 AND 9223372036854775806`,
  ),
  check(
    'budget_rule_revisions_authority_order_ck',
    drizzleSql`${table.authority_order} BETWEEN 1 AND 9223372036854775806`,
  ),
  check(
    'budget_rule_revisions_scope_ck',
    drizzleSql`${table.scope} IN ('pooled', 'per_customer')`,
  ),
  check(
    'budget_rule_revisions_target_ck',
    drizzleSql`(${table.scope} = 'pooled' AND ${table.target_customer_id} IS NULL)
      OR (${table.scope} = 'per_customer'
        AND (${table.target_customer_id} IS NULL
          OR ${table.target_customer_id} ~ '^[A-Za-z0-9_-]{1,255}$'))`,
  ),
  check(
    'budget_rule_revisions_period_ck',
    drizzleSql`${table.period} IN ('hour', 'day', 'week', 'month')`,
  ),
  check(
    'budget_rule_revisions_enforcement_ck',
    drizzleSql`${table.enforcement} IN ('hard_stop', 'advisory')`,
  ),
  check(
    'budget_rule_revisions_snapshot_ck',
    drizzleSql`jsonb_typeof(${table.config_snapshot}) IS NOT DISTINCT FROM 'object'
      AND (${table.config_snapshot} - ARRAY[
        'schema_version', 'rule_key', 'scope', 'target_customer_id',
        'period', 'enforcement', 'limit_usd'
      ]::TEXT[]) = '{}'::JSONB
      AND jsonb_typeof(${table.config_snapshot}->'schema_version')
        IS NOT DISTINCT FROM 'string'
      AND ${table.config_snapshot}->>'schema_version' IS NOT DISTINCT FROM '1.0'
      AND public.pylva_budget_jsonb_uuid_matches(
        ${table.config_snapshot}->'rule_key',
        ${table.rule_key}
      )
      AND ${table.config_snapshot}->>'scope' IS NOT DISTINCT FROM ${table.scope}
      AND ${table.config_snapshot}->'target_customer_id' IS NOT DISTINCT FROM
        CASE
          WHEN ${table.target_customer_id} IS NULL THEN 'null'::JSONB
          ELSE to_jsonb(${table.target_customer_id})
        END
      AND ${table.config_snapshot}->>'period' IS NOT DISTINCT FROM ${table.period}
      AND ${table.config_snapshot}->>'enforcement' IS NOT DISTINCT FROM ${table.enforcement}
      AND jsonb_typeof(${table.config_snapshot}->'limit_usd') IS NOT DISTINCT FROM 'string'
      AND ${table.config_snapshot}->>'limit_usd' IS NOT DISTINCT FROM
        public.pylva_budget_decimal_text(${table.limit_usd})
      AND ${table.config_snapshot_hash} ~ '^[0-9a-f]{64}$'
      AND ${table.config_snapshot_hash} =
        public.pylva_budget_jsonb_sha256(${table.config_snapshot})`,
  ),
  check(
    'budget_rule_revisions_amount_ck',
    drizzleSql`${table.limit_usd} <> 'NaN'::numeric AND ${table.limit_usd} >= 0`,
  ),
  check(
    'budget_rule_revisions_lifecycle_ck',
    drizzleSql`public.pylva_budget_timestamp_is_wire_safe(${table.active_from})
      AND public.pylva_budget_timestamp_is_wire_safe(${table.created_at})
      AND ${table.active_from} = ${table.created_at}
      AND ((${table.retired_at} IS NULL AND ${table.retirement_reason} IS NULL)
        OR (${table.retired_at} IS NOT NULL
          AND public.pylva_budget_timestamp_is_wire_safe(${table.retired_at})
          AND ${table.retired_at} >= ${table.active_from}
          AND ${table.retirement_reason} IS NOT NULL
          AND ${table.retirement_reason} IN ('superseded', 'disabled', 'deleted')))`,
  ),
]);

export const budgetAccounts = pgTable('budget_accounts', {
  builder_id: uuid('builder_id').notNull().references(() => builders.id, { onDelete: 'restrict' }),
  id: uuid('id').notNull().defaultRandom(),
  rule_key: uuid('rule_key').notNull(),
  enforcement: varchar('enforcement', { length: 20 }).notNull(),
  limit_usd: decimal('limit_usd', { precision: 38, scale: 18 }).notNull(),
  scope: varchar('scope', { length: 20 }).notNull(),
  subject_customer_id: varchar('subject_customer_id', { length: 255 }),
  period: varchar('period', { length: 20 }).notNull(),
  period_start: timestamp('period_start', { withTimezone: true }).notNull(),
  period_end: timestamp('period_end', { withTimezone: true }).notNull(),
  initial_rule_revision_id: uuid('initial_rule_revision_id').notNull(),
  initial_rule_snapshot: jsonb('initial_rule_snapshot').notNull(),
  initial_rule_snapshot_hash: char('initial_rule_snapshot_hash', { length: 64 }).notNull(),
  opening_committed_usd: decimal('opening_committed_usd', { precision: 38, scale: 18 })
    .notNull(),
  // Deliberately unbounded: a provider can return a post-call cost larger than
  // the public wire amount range, and the authoritative ledger must retain it.
  committed_usd: decimal('committed_usd').notNull().default('0'),
  reserved_usd: decimal('reserved_usd', { precision: 38, scale: 18 })
    .notNull()
    .default('0'),
  unresolved_usd: decimal('unresolved_usd', { precision: 38, scale: 18 })
    .notNull()
    .default('0'),
  version: bigint('version', { mode: 'bigint' }).notNull().default(0n),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({
    name: 'budget_accounts_pk',
    columns: [table.builder_id, table.id],
  }),
  unique('budget_accounts_rule_identity_uk').on(
    table.builder_id,
    table.id,
    table.rule_key,
  ),
  foreignKey({
    name: 'budget_accounts_initial_rule_revision_fk',
    columns: [table.builder_id, table.initial_rule_revision_id, table.rule_key],
    foreignColumns: [
      budgetRuleRevisions.builder_id,
      budgetRuleRevisions.id,
      budgetRuleRevisions.rule_key,
    ],
  }).onDelete('restrict'),
  unique('budget_accounts_natural_identity_uk')
    .on(
      table.builder_id,
      table.rule_key,
      table.scope,
      table.subject_customer_id,
      table.period,
      table.period_start,
    )
    .nullsNotDistinct(),
  index('idx_budget_accounts_builder_period').on(
    table.builder_id,
    table.period_start,
    table.period_end,
    table.rule_key,
    table.scope,
    table.subject_customer_id,
    table.id,
  ),
  index('idx_budget_accounts_builder_rule').on(table.builder_id, table.rule_key),
  check(
    'budget_accounts_scope_ck',
    drizzleSql`${table.scope} IN ('pooled', 'per_customer')`,
  ),
  check(
    'budget_accounts_enforcement_ck',
    drizzleSql`${table.enforcement} IN ('hard_stop', 'advisory')`,
  ),
  check(
    'budget_accounts_customer_scope_ck',
    drizzleSql`(${table.scope} = 'pooled' AND ${table.subject_customer_id} IS NULL)
      OR (${table.scope} = 'per_customer'
        AND ${table.subject_customer_id} IS NOT NULL
        AND ${table.subject_customer_id} ~ '^[A-Za-z0-9_-]{1,255}$')`,
  ),
  check(
    'budget_accounts_period_ck',
    drizzleSql`${table.period} IN ('hour', 'day', 'week', 'month')`,
  ),
  check(
    'budget_accounts_period_bounds_ck',
    drizzleSql`public.pylva_budget_timestamp_is_wire_safe(${table.period_start})
      AND public.pylva_budget_timestamp_is_wire_safe(${table.period_end})
      AND CASE ${table.period}
        WHEN 'hour' THEN
          ${table.period_start} AT TIME ZONE 'UTC' =
            date_trunc('hour', ${table.period_start} AT TIME ZONE 'UTC')
          AND ${table.period_end} = ${table.period_start} + INTERVAL '1 hour'
        WHEN 'day' THEN
          ${table.period_start} AT TIME ZONE 'UTC' =
            date_trunc('day', ${table.period_start} AT TIME ZONE 'UTC')
          AND ${table.period_end} = ${table.period_start} + INTERVAL '1 day'
        WHEN 'week' THEN
          ${table.period_start} AT TIME ZONE 'UTC' =
            date_trunc('week', ${table.period_start} AT TIME ZONE 'UTC')
          AND ${table.period_end} = ${table.period_start} + INTERVAL '7 days'
        WHEN 'month' THEN
          ${table.period_start} AT TIME ZONE 'UTC' =
            date_trunc('month', ${table.period_start} AT TIME ZONE 'UTC')
          AND ${table.period_end} = (
            (${table.period_start} AT TIME ZONE 'UTC') + INTERVAL '1 month'
          ) AT TIME ZONE 'UTC'
        ELSE FALSE
      END`,
  ),
  check(
    'budget_accounts_snapshot_ck',
    drizzleSql`jsonb_typeof(${table.initial_rule_snapshot}) IS NOT DISTINCT FROM 'object'
      AND (${table.initial_rule_snapshot} - ARRAY[
        'schema_version', 'rule_key', 'scope', 'subject_customer_id',
        'period', 'period_start', 'period_end', 'enforcement', 'limit_usd',
        'opening_committed_usd'
      ]::TEXT[]) = '{}'::JSONB
      AND jsonb_typeof(${table.initial_rule_snapshot}->'schema_version')
        IS NOT DISTINCT FROM 'string'
      AND ${table.initial_rule_snapshot}->>'schema_version' IS NOT DISTINCT FROM '1.0'
      AND public.pylva_budget_jsonb_uuid_matches(
        ${table.initial_rule_snapshot}->'rule_key',
        ${table.rule_key}
      )
      AND ${table.initial_rule_snapshot}->>'scope' IS NOT DISTINCT FROM ${table.scope}
      AND (${table.initial_rule_snapshot}->'subject_customer_id') IS NOT DISTINCT FROM
        CASE
          WHEN ${table.subject_customer_id} IS NULL THEN 'null'::JSONB
          ELSE to_jsonb(${table.subject_customer_id})
        END
      AND ${table.initial_rule_snapshot}->>'period' IS NOT DISTINCT FROM ${table.period}
      AND ${table.initial_rule_snapshot}->>'period_start' IS NOT DISTINCT FROM
        public.pylva_budget_timestamp_text(${table.period_start})
      AND ${table.initial_rule_snapshot}->>'period_end' IS NOT DISTINCT FROM
        public.pylva_budget_timestamp_text(${table.period_end})
      AND ${table.initial_rule_snapshot}->>'enforcement' IS NOT DISTINCT FROM ${table.enforcement}
      AND jsonb_typeof(${table.initial_rule_snapshot}->'limit_usd')
        IS NOT DISTINCT FROM 'string'
      AND ${table.initial_rule_snapshot}->>'limit_usd' IS NOT DISTINCT FROM
        public.pylva_budget_decimal_text(${table.limit_usd})
      AND jsonb_typeof(${table.initial_rule_snapshot}->'opening_committed_usd')
        IS NOT DISTINCT FROM 'string'
      AND ${table.initial_rule_snapshot}->>'opening_committed_usd' IS NOT DISTINCT FROM
        public.pylva_budget_decimal_text(${table.opening_committed_usd})`,
  ),
  check(
    'budget_accounts_snapshot_hash_ck',
    drizzleSql`${table.initial_rule_snapshot_hash} ~ '^[0-9a-f]{64}$'
      AND ${table.initial_rule_snapshot_hash} =
        public.pylva_budget_jsonb_sha256(${table.initial_rule_snapshot})`,
  ),
  check(
    'budget_accounts_amounts_ck',
    drizzleSql`${table.committed_usd} <> 'NaN'::numeric
      AND ${table.committed_usd} <> 'Infinity'::numeric
      AND ${table.limit_usd} <> 'NaN'::numeric
      AND ${table.limit_usd} >= 0
      AND ${table.opening_committed_usd} <> 'NaN'::numeric
      AND ${table.opening_committed_usd} >= 0
      AND ${table.reserved_usd} <> 'NaN'::numeric
      AND ${table.unresolved_usd} <> 'NaN'::numeric
      AND ${table.committed_usd} >= 0
      AND ${table.reserved_usd} >= 0
      AND ${table.unresolved_usd} >= 0
      AND ${table.committed_usd} >= ${table.opening_committed_usd}`,
  ),
  check(
    'budget_accounts_timestamps_ck',
    drizzleSql`public.pylva_budget_timestamp_is_wire_safe(${table.created_at})
      AND public.pylva_budget_timestamp_is_wire_safe(${table.updated_at})
      AND ${table.updated_at} >= ${table.created_at}`,
  ),
  check(
    'budget_accounts_version_ck',
    drizzleSql`${table.version} BETWEEN 0 AND 9223372036854775806`,
  ),
]);

export const budgetAccountOpeningEvidence = pgTable('budget_account_opening_evidence', {
  builder_id: uuid('builder_id').notNull(),
  account_id: uuid('account_id').notNull(),
  source: varchar('source', { length: 30 }).notNull(),
  opening_committed_usd: decimal('opening_committed_usd', {
    precision: 38,
    scale: 18,
  }).notNull(),
  measured_through: timestamp('measured_through', { withTimezone: true }).notNull(),
  evidence_snapshot: jsonb('evidence_snapshot').notNull(),
  evidence_snapshot_hash: char('evidence_snapshot_hash', { length: 64 }).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({
    name: 'budget_account_opening_evidence_pk',
    columns: [table.builder_id, table.account_id],
  }),
  foreignKey({
    name: 'budget_account_opening_evidence_cutover_fk',
    columns: [table.builder_id],
    foreignColumns: [budgetControlCutovers.builder_id],
  }).onDelete('restrict'),
  foreignKey({
    name: 'budget_account_opening_evidence_account_fk',
    columns: [table.builder_id, table.account_id],
    foreignColumns: [budgetAccounts.builder_id, budgetAccounts.id],
  }).onDelete('restrict'),
  check(
    'budget_account_opening_evidence_source_ck',
    drizzleSql`${table.source} IN ('post_cutover_zero', 'exact_backfill')`,
  ),
  check(
    'budget_account_opening_evidence_amount_ck',
    drizzleSql`${table.opening_committed_usd} <> 'NaN'::numeric
      AND ${table.opening_committed_usd} >= 0`,
  ),
  check(
    'budget_account_opening_evidence_snapshot_ck',
    drizzleSql`jsonb_typeof(${table.evidence_snapshot}) IS NOT DISTINCT FROM 'object'
      AND ${table.evidence_snapshot_hash} ~ '^[0-9a-f]{64}$'
      AND ${table.evidence_snapshot_hash} =
        public.pylva_budget_jsonb_sha256(${table.evidence_snapshot})`,
  ),
  check(
    'budget_account_opening_evidence_timestamps_ck',
    drizzleSql`public.pylva_budget_timestamp_is_wire_safe(${table.measured_through})
      AND public.pylva_budget_timestamp_is_wire_safe(${table.created_at})`,
  ),
]);

// A named, explicitly widened accessor breaks TypeScript's inference cycle
// while preserving the runtime composite FK from reservations to allocations.
function budgetReservationAllocationIdentityColumns(): [
  AnyPgColumn,
  AnyPgColumn,
  AnyPgColumn,
] {
  return [
    budgetReservationAllocations.builder_id,
    budgetReservationAllocations.reservation_decision_id,
    budgetReservationAllocations.account_id,
  ];
}

export const budgetReservations = pgTable('budget_reservations', {
  builder_id: uuid('builder_id').notNull().references(() => builders.id, { onDelete: 'restrict' }),
  decision_id: uuid('decision_id').notNull().defaultRandom(),
  reservation_id: uuid('reservation_id'),
  operation_id: uuid('operation_id').notNull(),
  schema_version: varchar('schema_version', { length: 10 }).notNull(),
  request_hash: char('request_hash', { length: 64 }).notNull(),
  request_snapshot: jsonb('request_snapshot').notNull(),
  mode: varchar('mode', { length: 10 }).notNull(),
  kind: varchar('kind', { length: 10 }).notNull(),
  customer_id: varchar('customer_id', { length: 255 }).notNull(),
  trace_id: uuid('trace_id').notNull(),
  span_id: uuid('span_id').notNull(),
  parent_span_id: uuid('parent_span_id'),
  step_name: varchar('step_name', { length: 200 }),
  framework: varchar('framework', { length: 40 }).notNull().default('none'),
  reservation_ttl_seconds: integer('reservation_ttl_seconds').notNull(),
  provider: varchar('provider', { length: 255 }),
  model: varchar('model', { length: 255 }),
  estimated_input_tokens: bigint('estimated_input_tokens', { mode: 'number' }),
  max_output_tokens: bigint('max_output_tokens', { mode: 'number' }),
  cost_source_slug: varchar('cost_source_slug', { length: 100 }),
  tool_name: varchar('tool_name', { length: 200 }),
  metric: varchar('metric', { length: 100 }),
  maximum_value: decimal('maximum_value', { precision: 38, scale: 18 }),
  decision: varchar('decision', { length: 20 }).notNull(),
  decision_reason: varchar('decision_reason', { length: 80 }),
  would_have_denied: boolean('would_have_denied'),
  state: varchar('state', { length: 20 }),
  pricing_snapshot: jsonb('pricing_snapshot'),
  pricing_snapshot_hash: char('pricing_snapshot_hash', { length: 64 }),
  requested_usd: decimal('requested_usd', { precision: 38, scale: 18 }),
  reserved_usd: decimal('reserved_usd', { precision: 38, scale: 18 })
    .notNull()
    .default('0'),
  actual_usd: decimal('actual_usd', { precision: 44, scale: 18 }).notNull().default('0'),
  released_usd: decimal('released_usd', { precision: 38, scale: 18 })
    .notNull()
    .default('0'),
  overage_usd: decimal('overage_usd', { precision: 44, scale: 18 }).notNull().default('0'),
  remaining_usd: decimal('remaining_usd', { precision: 38, scale: 18 }),
  deciding_account_id: uuid('deciding_account_id'),
  reserve_response_snapshot: jsonb('reserve_response_snapshot').notNull(),
  rule_revision_ids: uuid('rule_revision_ids').array().notNull().default(drizzleSql`ARRAY[]::UUID[]`),
  rule_set_hash: char('rule_set_hash', { length: 64 })
    .notNull()
    .default(drizzleSql`repeat('0', 64)`),
  authorization_transaction_id: bigint('authorization_transaction_id', { mode: 'bigint' })
    .notNull()
    .default(0n),
  expires_at: timestamp('expires_at', { withTimezone: true }),
  reserved_at: timestamp('reserved_at', { withTimezone: true }),
  refused_at: timestamp('refused_at', { withTimezone: true }),
  committed_at: timestamp('committed_at', { withTimezone: true }),
  released_at: timestamp('released_at', { withTimezone: true }),
  unresolved_at: timestamp('unresolved_at', { withTimezone: true }),
  unresolved_reason: varchar('unresolved_reason', { length: 80 }),
  state_version: bigint('state_version', { mode: 'bigint' }).notNull().default(0n),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({
    name: 'budget_reservations_pk',
    columns: [table.builder_id, table.decision_id],
  }),
  unique('budget_reservations_operation_uk').on(table.builder_id, table.operation_id),
  unique('budget_reservations_usage_parent_uk').on(
    table.builder_id,
    table.decision_id,
    table.operation_id,
  ),
  uniqueIndex('budget_reservations_reservation_uk')
    .on(table.builder_id, table.reservation_id)
    .where(drizzleSql`${table.reservation_id} IS NOT NULL`),
  foreignKey({
    name: 'budget_reservations_deciding_account_fk',
    columns: [table.builder_id, table.deciding_account_id],
    foreignColumns: [budgetAccounts.builder_id, budgetAccounts.id],
  }).onDelete('restrict'),
  foreignKey({
    name: 'budget_reservations_deciding_allocation_fk',
    columns: [table.builder_id, table.decision_id, table.deciding_account_id],
    foreignColumns: budgetReservationAllocationIdentityColumns(),
  }),
  index('idx_budget_reservations_builder_customer_created').on(
    table.builder_id,
    table.customer_id,
    table.created_at.desc().nullsFirst(),
  ),
  index('idx_budget_reservations_expiry')
    .on(table.expires_at, table.builder_id, table.decision_id)
    .where(drizzleSql`${table.state} = 'reserved'`),
  index('idx_budget_reservations_expiry_discovery')
    .on(table.builder_id, table.expires_at, table.decision_id)
    .where(drizzleSql`${table.state} = 'reserved' AND ${table.decision} = 'reserved'`),
  index('idx_budget_reservations_builder_state_updated').on(
    table.builder_id,
    table.state,
    table.updated_at.desc().nullsFirst(),
  ),
  index('idx_budget_reservations_builder_authorization_tx').on(
    table.builder_id,
    table.authorization_transaction_id,
  ),
  check(
    'budget_reservations_schema_version_ck',
    drizzleSql`${table.schema_version} = '1.0'`,
  ),
  check(
    'budget_reservations_request_hash_ck',
    drizzleSql`${table.request_hash} ~ '^[0-9a-f]{64}$'
      AND ${table.request_hash} =
        public.pylva_budget_jsonb_sha256(${table.request_snapshot})`,
  ),
  check(
    'budget_reservations_request_snapshot_ck',
    drizzleSql`jsonb_typeof(${table.request_snapshot}) = 'object'`,
  ),
  check(
    'budget_reservations_response_snapshot_ck',
    drizzleSql`jsonb_typeof(${table.reserve_response_snapshot}) = 'object'`,
  ),
  check(
    'budget_reservations_rule_set_ck',
    drizzleSql`public.pylva_budget_uuid_array_is_canonical(${table.rule_revision_ids})
      AND ${table.rule_set_hash} ~ '^[0-9a-f]{64}$'
      AND ${table.rule_set_hash} =
        public.pylva_budget_jsonb_sha256(to_jsonb(${table.rule_revision_ids}))`,
  ),
  check(
    'budget_reservations_authorization_tx_ck',
    drizzleSql`${table.authorization_transaction_id} > 0`,
  ),
  check('budget_reservations_mode_ck', drizzleSql`${table.mode} IN ('shadow', 'enforce')`),
  check(
    'budget_reservations_mode_decision_ck',
    drizzleSql`(${table.mode} = 'shadow' AND ${table.decision} = 'bypassed')
      OR (${table.mode} = 'enforce'
        AND ${table.decision} IN ('reserved', 'denied', 'bypassed', 'unavailable'))`,
  ),
  check(
    'budget_reservations_ttl_ck',
    drizzleSql`${table.reservation_ttl_seconds} BETWEEN 30 AND 3600`,
  ),
  check('budget_reservations_kind_ck', drizzleSql`${table.kind} IN ('llm', 'tool')`),
  check(
    'budget_reservations_customer_id_ck',
    drizzleSql`${table.customer_id} ~ '^[A-Za-z0-9_-]{1,255}$'`,
  ),
  check(
    'budget_reservations_framework_ck',
    drizzleSql`${table.framework} IN ('langgraph', 'crewai', 'mastra', 'openai-agents', 'pydantic-ai', 'none')`,
  ),
  check(
    'budget_reservations_identifiers_ck',
    drizzleSql`(${table.step_name} IS NULL
        OR ${table.step_name} ~ '^[A-Za-z0-9 _.:/-]{0,200}$')
      AND (${table.provider} IS NULL OR (
        char_length(${table.provider}) BETWEEN 1 AND 255
        AND ${table.provider} !~ E'[\\\\u0001-\\\\u001F\\\\u007F]'
        AND ${table.provider} !~ E'^[\\\\u0009-\\\\u000D\\\\u0020\\\\u0085\\\\u00A0\\\\u1680\\\\u2000-\\\\u200A\\\\u2028\\\\u2029\\\\u202F\\\\u205F\\\\u3000\\\\uFEFF]*$'
      ))
      AND (${table.model} IS NULL OR (
        char_length(${table.model}) BETWEEN 1 AND 255
        AND ${table.model} !~ E'[\\\\u0001-\\\\u001F\\\\u007F]'
        AND ${table.model} !~ E'^[\\\\u0009-\\\\u000D\\\\u0020\\\\u0085\\\\u00A0\\\\u1680\\\\u2000-\\\\u200A\\\\u2028\\\\u2029\\\\u202F\\\\u205F\\\\u3000\\\\uFEFF]*$'
      ))
      AND (${table.tool_name} IS NULL OR (
        char_length(${table.tool_name}) BETWEEN 1 AND 200
        AND ${table.tool_name} ~ '^[A-Za-z0-9 _.:/-]+$'
      ))
      AND (${table.metric} IS NULL OR (
        char_length(${table.metric}) BETWEEN 1 AND 100
        AND ${table.metric} !~ E'[\\\\u0001-\\\\u001F\\\\u007F]'
        AND ${table.metric} !~ E'^[\\\\u0009-\\\\u000D\\\\u0020\\\\u0085\\\\u00A0\\\\u1680\\\\u2000-\\\\u200A\\\\u2028\\\\u2029\\\\u202F\\\\u205F\\\\u3000\\\\uFEFF]*$'
      ))`,
  ),
  check(
    'budget_reservations_decision_ck',
    drizzleSql`${table.decision} IN ('reserved', 'denied', 'bypassed', 'unavailable')`,
  ),
  check(
    'budget_reservations_state_ck',
    drizzleSql`${table.state} IS NULL
      OR ${table.state} IN ('reserved', 'committed', 'released', 'unresolved', 'refused')`,
  ),
  check(
    'budget_reservations_decision_state_ck',
    drizzleSql`CASE ${table.decision}
      WHEN 'reserved' THEN
        ${table.reservation_id} IS NOT NULL
        AND ${table.state} IS NOT NULL
        AND ${table.state} IN ('reserved', 'committed', 'released', 'unresolved')
        AND ${table.pricing_snapshot} IS NOT NULL
        AND ${table.requested_usd} IS NOT NULL
        AND ${table.reserved_usd} = ${table.requested_usd}
        AND ${table.expires_at} IS NOT NULL
        AND ${table.reserved_at} IS NOT NULL
        AND ${table.refused_at} IS NULL
      WHEN 'denied' THEN
        ${table.reservation_id} IS NULL
        AND ${table.state} IS NOT DISTINCT FROM 'refused'
        AND ${table.pricing_snapshot} IS NOT NULL
        AND ${table.requested_usd} IS NOT NULL
        AND ${table.reserved_usd} = 0
        AND ${table.expires_at} IS NULL
        AND ${table.reserved_at} IS NULL
        AND ${table.refused_at} IS NOT NULL
      WHEN 'bypassed' THEN
        ${table.reservation_id} IS NULL
        AND ${table.state} IS NULL
        AND (${table.decision_reason} NOT IN ('shadow_would_allow', 'shadow_would_deny')
          OR (${table.pricing_snapshot} IS NOT NULL AND ${table.requested_usd} IS NOT NULL))
        AND (${table.decision_reason} IS DISTINCT FROM 'shadow_control_unavailable'
          OR (${table.pricing_snapshot} IS NULL
            AND ${table.pricing_snapshot_hash} IS NULL
            AND ${table.requested_usd} IS NULL
            AND ${table.remaining_usd} IS NULL
            AND ${table.deciding_account_id} IS NULL))
        AND ${table.reserved_usd} = 0
        AND ${table.expires_at} IS NULL
        AND ${table.reserved_at} IS NULL
        AND ${table.refused_at} IS NULL
      WHEN 'unavailable' THEN
        ${table.reservation_id} IS NULL
        AND ${table.state} IS NULL
        AND ${table.reserved_usd} = 0
        AND ${table.expires_at} IS NULL
        AND ${table.reserved_at} IS NULL
        AND ${table.refused_at} IS NULL
      ELSE FALSE
    END`,
  ),
  check(
    'budget_reservations_usage_shape_ck',
    drizzleSql`(${table.kind} = 'llm'
        AND ${table.provider} IS NOT NULL
        AND ${table.model} IS NOT NULL
        AND ${table.estimated_input_tokens} IS NOT NULL
        AND ${table.max_output_tokens} IS NOT NULL
        AND ${table.cost_source_slug} IS NULL
        AND ${table.tool_name} IS NULL
        AND ${table.metric} IS NULL
        AND ${table.maximum_value} IS NULL)
      OR (${table.kind} = 'tool'
        AND ${table.provider} IS NULL
        AND ${table.model} IS NULL
        AND ${table.estimated_input_tokens} IS NULL
        AND ${table.max_output_tokens} IS NULL
        AND ${table.cost_source_slug} IS NOT NULL
        AND ${table.tool_name} IS NOT NULL
        AND ${table.metric} IS NOT NULL
        AND ${table.maximum_value} IS NOT NULL)`,
  ),
  check(
    'budget_reservations_usage_bounds_ck',
    drizzleSql`(${table.estimated_input_tokens} IS NULL OR ${table.estimated_input_tokens} BETWEEN 0 AND 4294967295)
      AND (${table.max_output_tokens} IS NULL OR ${table.max_output_tokens} BETWEEN 0 AND 4294967295)
      AND (${table.maximum_value} IS NULL OR ${table.maximum_value} >= 0)
      AND (${table.cost_source_slug} IS NULL OR ${table.cost_source_slug} ~ '^[a-z0-9][a-z0-9-]{0,99}$')`,
  ),
  check(
    'budget_reservations_pricing_snapshot_ck',
    drizzleSql`(${table.pricing_snapshot} IS NULL) = (${table.pricing_snapshot_hash} IS NULL)
      AND (${table.pricing_snapshot} IS NULL OR jsonb_typeof(${table.pricing_snapshot}) = 'object')
      AND (${table.pricing_snapshot_hash} IS NULL OR ${table.pricing_snapshot_hash} ~ '^[0-9a-f]{64}$')
      AND (${table.pricing_snapshot} IS NULL OR ${table.pricing_snapshot_hash} =
        public.pylva_budget_jsonb_sha256(${table.pricing_snapshot}))`,
  ),
  check(
    'budget_reservations_amounts_ck',
    drizzleSql`(${table.maximum_value} IS NULL OR (
        ${table.maximum_value} <> 'NaN'::numeric AND ${table.maximum_value} >= 0))
      AND (${table.requested_usd} IS NULL OR (
        ${table.requested_usd} <> 'NaN'::numeric AND ${table.requested_usd} >= 0))
      AND ${table.reserved_usd} <> 'NaN'::numeric AND ${table.reserved_usd} >= 0
      AND ${table.actual_usd} <> 'NaN'::numeric AND ${table.actual_usd} >= 0
      AND ${table.released_usd} <> 'NaN'::numeric AND ${table.released_usd} >= 0
      AND ${table.overage_usd} <> 'NaN'::numeric AND ${table.overage_usd} >= 0
      AND (${table.remaining_usd} IS NULL OR (
        ${table.remaining_usd} <> 'NaN'::numeric AND ${table.remaining_usd} >= 0))`,
  ),
  check(
    'budget_reservations_decision_reason_ck',
    drizzleSql`CASE ${table.decision}
      WHEN 'reserved' THEN
        ${table.decision_reason} IS NULL AND ${table.would_have_denied} IS NULL
      WHEN 'denied' THEN
        ${table.decision_reason} IS NOT DISTINCT FROM 'budget_exceeded'
        AND ${table.would_have_denied} IS NULL
      WHEN 'bypassed' THEN
        CASE ${table.decision_reason}
          WHEN 'control_disabled' THEN ${table.would_have_denied} IS NULL
          WHEN 'no_applicable_budget' THEN ${table.would_have_denied} IS NULL
          WHEN 'shadow_would_allow' THEN
            ${table.mode} = 'shadow' AND ${table.would_have_denied} IS FALSE
          WHEN 'shadow_would_deny' THEN
            ${table.mode} = 'shadow' AND ${table.would_have_denied} IS TRUE
          WHEN 'shadow_control_unavailable' THEN
            ${table.mode} = 'shadow' AND ${table.would_have_denied} IS NULL
          ELSE FALSE
        END
      WHEN 'unavailable' THEN
        ${table.decision_reason} IS NOT NULL
        AND ${table.decision_reason} IN ('pricing_unavailable', 'usage_bound_required', 'control_unavailable')
        AND ${table.would_have_denied} IS NULL
      ELSE FALSE
    END`,
  ),
  check(
    'budget_reservations_lifecycle_timestamps_ck',
    drizzleSql`((${table.state} IS NOT DISTINCT FROM 'committed') = (${table.committed_at} IS NOT NULL))
      AND ((${table.state} IS NOT DISTINCT FROM 'released') = (${table.released_at} IS NOT NULL))
      AND ((${table.state} IS NOT DISTINCT FROM 'unresolved') = (${table.unresolved_at} IS NOT NULL))
      AND ((${table.state} IS NOT DISTINCT FROM 'refused') = (${table.refused_at} IS NOT NULL))
      AND (${table.unresolved_at} IS NULL) = (${table.unresolved_reason} IS NULL)
      AND (${table.unresolved_reason} IS NULL OR ${table.unresolved_reason} = 'lease_expired')
      AND (${table.reserved_at} IS NULL OR ${table.expires_at} > ${table.reserved_at})
      AND (${table.expires_at} IS NULL
        OR public.pylva_budget_timestamp_is_wire_safe(${table.expires_at}))
      AND (${table.reserved_at} IS NULL
        OR public.pylva_budget_timestamp_is_wire_safe(${table.reserved_at}))
      AND (${table.refused_at} IS NULL
        OR public.pylva_budget_timestamp_is_wire_safe(${table.refused_at}))
      AND (${table.committed_at} IS NULL
        OR public.pylva_budget_timestamp_is_wire_safe(${table.committed_at}))
      AND (${table.released_at} IS NULL
        OR public.pylva_budget_timestamp_is_wire_safe(${table.released_at}))
      AND (${table.unresolved_at} IS NULL
        OR public.pylva_budget_timestamp_is_wire_safe(${table.unresolved_at}))
      AND public.pylva_budget_timestamp_is_wire_safe(${table.created_at})
      AND public.pylva_budget_timestamp_is_wire_safe(${table.updated_at})
      AND ${table.updated_at} >= ${table.created_at}
      AND (${table.reserved_at} IS NULL OR ${table.reserved_at} >= ${table.created_at})
      AND (${table.refused_at} IS NULL OR ${table.refused_at} >= ${table.created_at})
      AND (${table.committed_at} IS NULL OR ${table.committed_at} >= ${table.reserved_at})
      AND (${table.released_at} IS NULL OR ${table.released_at} >= ${table.reserved_at})
      AND (${table.unresolved_at} IS NULL OR ${table.unresolved_at} >= ${table.reserved_at})`,
  ),
  check(
    'budget_reservations_settlement_math_ck',
    drizzleSql`(${table.state} = 'committed'
        AND ${table.released_usd} = GREATEST(${table.reserved_usd} - ${table.actual_usd}, 0)
        AND ${table.overage_usd} = GREATEST(${table.actual_usd} - ${table.reserved_usd}, 0))
      OR (${table.state} = 'released'
        AND ${table.actual_usd} = 0
        AND ${table.released_usd} = ${table.reserved_usd}
        AND ${table.overage_usd} = 0)
      OR ((${table.state} IS NULL OR ${table.state} IN ('reserved', 'unresolved', 'refused'))
        AND ${table.actual_usd} = 0
        AND ${table.released_usd} = 0
        AND ${table.overage_usd} = 0)`,
  ),
  check(
    'budget_reservations_state_version_ck',
    drizzleSql`${table.state_version} BETWEEN 0 AND 9223372036854775806`,
  ),
]);

export const budgetReservationAllocations = pgTable('budget_reservation_allocations', {
  builder_id: uuid('builder_id').notNull(),
  id: uuid('id').notNull().defaultRandom(),
  reservation_decision_id: uuid('reservation_decision_id').notNull(),
  account_id: uuid('account_id').notNull(),
  rule_key: uuid('rule_key').notNull(),
  rule_revision_id: uuid('rule_revision_id').notNull(),
  rule_snapshot: jsonb('rule_snapshot').notNull(),
  rule_snapshot_hash: char('rule_snapshot_hash', { length: 64 }).notNull(),
  enforcement: varchar('enforcement', { length: 20 }).notNull(),
  evaluation_order: integer('evaluation_order').notNull(),
  is_deciding: boolean('is_deciding').notNull().default(false),
  account_version_before: bigint('account_version_before', { mode: 'bigint' }).notNull(),
  held_at_reserve: boolean('held_at_reserve').notNull(),
  status: varchar('status', { length: 30 }).notNull(),
  committed_before_usd: decimal('committed_before_usd', {
    precision: 38,
    scale: 18,
  }).notNull(),
  reserved_before_usd: decimal('reserved_before_usd', {
    precision: 38,
    scale: 18,
  }).notNull(),
  unresolved_before_usd: decimal('unresolved_before_usd', {
    precision: 38,
    scale: 18,
  }).notNull(),
  requested_usd: decimal('requested_usd', { precision: 38, scale: 18 }).notNull(),
  projected_usd: decimal('projected_usd', { precision: 38, scale: 18 }).notNull(),
  limit_usd: decimal('limit_usd', { precision: 38, scale: 18 }).notNull(),
  remaining_usd: decimal('remaining_usd', { precision: 38, scale: 18 }).notNull(),
  authorized_usd: decimal('authorized_usd', { precision: 38, scale: 18 })
    .notNull()
    .default('0'),
  actual_usd: decimal('actual_usd', { precision: 44, scale: 18 }).notNull().default('0'),
  released_usd: decimal('released_usd', { precision: 38, scale: 18 })
    .notNull()
    .default('0'),
  unresolved_usd: decimal('unresolved_usd', { precision: 38, scale: 18 })
    .notNull()
    .default('0'),
  overage_usd: decimal('overage_usd', { precision: 44, scale: 18 }).notNull().default('0'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({
    name: 'budget_reservation_allocations_pk',
    columns: [table.builder_id, table.id],
  }),
  unique('budget_reservation_allocations_account_uk').on(
    table.builder_id,
    table.reservation_decision_id,
    table.account_id,
  ),
  unique('budget_reservation_allocations_rule_uk').on(
    table.builder_id,
    table.reservation_decision_id,
    table.rule_key,
  ),
  unique('budget_reservation_allocations_order_uk').on(
    table.builder_id,
    table.reservation_decision_id,
    table.evaluation_order,
  ),
  foreignKey({
    name: 'budget_reservation_allocations_reservation_fk',
    columns: [table.builder_id, table.reservation_decision_id],
    foreignColumns: [budgetReservations.builder_id, budgetReservations.decision_id],
  }).onDelete('cascade'),
  foreignKey({
    name: 'budget_reservation_allocations_account_fk',
    columns: [table.builder_id, table.account_id, table.rule_key],
    foreignColumns: [
      budgetAccounts.builder_id,
      budgetAccounts.id,
      budgetAccounts.rule_key,
    ],
  }).onDelete('restrict'),
  foreignKey({
    name: 'budget_reservation_allocations_rule_revision_fk',
    columns: [table.builder_id, table.rule_revision_id, table.rule_key],
    foreignColumns: [
      budgetRuleRevisions.builder_id,
      budgetRuleRevisions.id,
      budgetRuleRevisions.rule_key,
    ],
  }).onDelete('restrict'),
  // Drizzle 0.45 has no INCLUDE-columns API. The migration additionally
  // includes authorized_usd, actual_usd, and unresolved_usd in this index.
  index('idx_budget_reservation_allocations_account').on(
    table.builder_id,
    table.account_id,
    table.status,
  ),
  // The migration additionally includes account_id, is_deciding,
  // requested_usd, and actual_usd in this index.
  index('idx_budget_reservation_allocations_decision_status').on(
    table.builder_id,
    table.reservation_decision_id,
    table.status,
  ),
  uniqueIndex('budget_reservation_allocations_observed_version_uk')
    .on(table.builder_id, table.account_id, table.account_version_before)
    .where(drizzleSql`${table.held_at_reserve}`),
  uniqueIndex('budget_reservation_allocations_deciding_uk')
    .on(table.builder_id, table.reservation_decision_id)
    .where(drizzleSql`${table.is_deciding}`),
  check(
    'budget_reservation_allocations_snapshot_ck',
    drizzleSql`jsonb_typeof(${table.rule_snapshot}) = 'object'
      AND ${table.rule_snapshot_hash} ~ '^[0-9a-f]{64}$'
      AND ${table.rule_snapshot_hash} =
        public.pylva_budget_jsonb_sha256(${table.rule_snapshot})`,
  ),
  check(
    'budget_reservation_allocations_enforcement_ck',
    drizzleSql`${table.enforcement} IN ('hard_stop', 'advisory')`,
  ),
  check(
    'budget_reservation_allocations_status_ck',
    drizzleSql`${table.status} IN ('reserved', 'refused', 'not_held', 'shadow', 'committed', 'released', 'unresolved')`,
  ),
  check(
    'budget_reservation_allocations_deciding_ck',
    drizzleSql`NOT ${table.is_deciding} OR (
      ${table.enforcement} = 'hard_stop'
      AND ${table.status} IN ('refused', 'shadow')
      AND ${table.projected_usd} > ${table.limit_usd}
    )`,
  ),
  check(
    'budget_reservation_allocations_order_ck',
    drizzleSql`${table.evaluation_order} >= 0`,
  ),
  check(
    'budget_reservation_allocations_account_version_ck',
    drizzleSql`${table.account_version_before} BETWEEN 0 AND 9223372036854775806`,
  ),
  check(
    'budget_reservation_allocations_held_ck',
    drizzleSql`${table.held_at_reserve} =
      (${table.status} IN ('reserved', 'committed', 'released', 'unresolved'))`,
  ),
  check(
    'budget_reservation_allocations_decision_math_ck',
    drizzleSql`${table.committed_before_usd} <> 'NaN'::numeric
      AND ${table.committed_before_usd} >= 0
      AND ${table.reserved_before_usd} <> 'NaN'::numeric
      AND ${table.reserved_before_usd} >= 0
      AND ${table.unresolved_before_usd} <> 'NaN'::numeric
      AND ${table.unresolved_before_usd} >= 0
      AND ${table.requested_usd} <> 'NaN'::numeric
      AND ${table.requested_usd} >= 0
      AND ${table.projected_usd} <> 'NaN'::numeric
      AND ${table.projected_usd} = ${table.committed_before_usd}
        + ${table.reserved_before_usd}
        + ${table.unresolved_before_usd}
        + ${table.requested_usd}
      AND ${table.limit_usd} <> 'NaN'::numeric
      AND ${table.limit_usd} >= 0
      AND ${table.remaining_usd} <> 'NaN'::numeric
      AND ${table.remaining_usd} = CASE
        WHEN ${table.projected_usd} <= ${table.limit_usd}
          THEN ${table.limit_usd} - ${table.projected_usd}
        ELSE GREATEST(
          ${table.limit_usd} - ${table.committed_before_usd}
            - ${table.reserved_before_usd} - ${table.unresolved_before_usd},
          0
        )
      END`,
  ),
  check(
    'budget_reservation_allocations_authorization_ck',
    drizzleSql`(${table.status} IN ('reserved', 'committed', 'released', 'unresolved')
        AND ${table.authorized_usd} = ${table.requested_usd})
      OR (${table.status} IN ('refused', 'not_held', 'shadow')
        AND ${table.authorized_usd} = 0)`,
  ),
  check(
    'budget_reservation_allocations_amounts_ck',
    drizzleSql`${table.authorized_usd} <> 'NaN'::numeric AND ${table.authorized_usd} >= 0
      AND ${table.actual_usd} <> 'NaN'::numeric AND ${table.actual_usd} >= 0
      AND ${table.released_usd} <> 'NaN'::numeric AND ${table.released_usd} >= 0
      AND ${table.unresolved_usd} <> 'NaN'::numeric AND ${table.unresolved_usd} >= 0
      AND ${table.overage_usd} <> 'NaN'::numeric AND ${table.overage_usd} >= 0`,
  ),
  check(
    'budget_reservation_allocations_control_result_ck',
    drizzleSql`(${table.status} = 'refused'
        AND ${table.enforcement} = 'hard_stop'
        AND ${table.projected_usd} > ${table.limit_usd})
      OR (${table.status} IN ('reserved', 'committed', 'released', 'unresolved')
        AND (${table.enforcement} = 'advisory' OR ${table.projected_usd} <= ${table.limit_usd}))
      OR ${table.status} = 'not_held'
      OR ${table.status} = 'shadow'`,
  ),
  check(
    'budget_reservation_allocations_settlement_math_ck',
    drizzleSql`(${table.status} = 'committed'
        AND ${table.released_usd} = GREATEST(${table.authorized_usd} - ${table.actual_usd}, 0)
        AND ${table.overage_usd} = GREATEST(${table.actual_usd} - ${table.authorized_usd}, 0)
        AND ${table.unresolved_usd} = 0)
      OR (${table.status} = 'released'
        AND ${table.actual_usd} = 0
        AND ${table.released_usd} = ${table.authorized_usd}
        AND ${table.unresolved_usd} = 0
        AND ${table.overage_usd} = 0)
      OR (${table.status} = 'unresolved'
        AND ${table.actual_usd} = 0
        AND ${table.released_usd} = 0
        AND ${table.unresolved_usd} = ${table.authorized_usd}
        AND ${table.overage_usd} = 0)
      OR (${table.status} IN ('reserved', 'refused', 'not_held', 'shadow')
        AND ${table.actual_usd} = 0
        AND ${table.released_usd} = 0
        AND ${table.unresolved_usd} = 0
        AND ${table.overage_usd} = 0)`,
  ),
  check(
    'budget_reservation_allocations_timestamps_ck',
    drizzleSql`public.pylva_budget_timestamp_is_wire_safe(${table.created_at})
      AND public.pylva_budget_timestamp_is_wire_safe(${table.updated_at})
      AND ${table.updated_at} >= ${table.created_at}`,
  ),
]);

export const budgetReservationTransitions = pgTable('budget_reservation_transitions', {
  builder_id: uuid('builder_id').notNull(),
  id: uuid('id').notNull().defaultRandom(),
  reservation_decision_id: uuid('reservation_decision_id').notNull(),
  type: varchar('type', { length: 30 }).notNull(),
  extension_id: uuid('extension_id'),
  release_reason: varchar('release_reason', { length: 50 }),
  request_hash: char('request_hash', { length: 64 }).notNull(),
  request_snapshot: jsonb('request_snapshot').notNull(),
  response_snapshot: jsonb('response_snapshot').notNull(),
  from_state: varchar('from_state', { length: 20 }).notNull(),
  to_state: varchar('to_state', { length: 20 }).notNull(),
  from_state_version: bigint('from_state_version', { mode: 'bigint' }).notNull(),
  to_state_version: bigint('to_state_version', { mode: 'bigint' }).notNull(),
  from_expires_at: timestamp('from_expires_at', { withTimezone: true }).notNull(),
  to_expires_at: timestamp('to_expires_at', { withTimezone: true }).notNull(),
  extend_by_seconds: integer('extend_by_seconds'),
  occurred_at: timestamp('occurred_at', { withTimezone: true })
    .notNull()
    .default(drizzleSql`statement_timestamp()`),
}, (table) => [
  primaryKey({
    name: 'budget_reservation_transitions_pk',
    columns: [table.builder_id, table.id],
  }),
  foreignKey({
    name: 'budget_reservation_transitions_reservation_fk',
    columns: [table.builder_id, table.reservation_decision_id],
    foreignColumns: [budgetReservations.builder_id, budgetReservations.decision_id],
  }).onDelete('cascade'),
  // Drizzle 0.45 cannot mark a unique index NULLS NOT DISTINCT, so mirror the
  // migration's idempotency index as an equivalent NND unique constraint.
  unique('budget_reservation_transitions_idempotency_uk')
    .on(table.builder_id, table.reservation_decision_id, table.type, table.extension_id)
    .nullsNotDistinct(),
  uniqueIndex('budget_reservation_transitions_terminal_uk')
    .on(table.builder_id, table.reservation_decision_id)
    .where(drizzleSql`${table.type} IN ('commit', 'release')`),
  uniqueIndex('budget_reservation_transitions_from_version_uk').on(
    table.builder_id,
    table.reservation_decision_id,
    table.from_state_version,
  ),
  uniqueIndex('budget_reservation_transitions_to_version_uk').on(
    table.builder_id,
    table.reservation_decision_id,
    table.to_state_version,
  ),
  index('idx_budget_reservation_transitions_decision_occurred').on(
    table.builder_id,
    table.reservation_decision_id,
    table.occurred_at,
    table.id,
  ),
  check(
    'budget_reservation_transitions_type_ck',
    drizzleSql`${table.type} IN ('commit', 'release', 'extend', 'expire_unresolved')`,
  ),
  check(
    'budget_reservation_transitions_extension_ck',
    drizzleSql`(${table.type} = 'extend') = (${table.extension_id} IS NOT NULL)
      AND (${table.type} = 'extend') = (${table.extend_by_seconds} IS NOT NULL)`,
  ),
  check(
    'budget_reservation_transitions_release_reason_ck',
    drizzleSql`(${table.type} = 'release') = (${table.release_reason} IS NOT NULL)
      AND (${table.release_reason} IS NULL OR ${table.release_reason} IN (
        'provider_not_called', 'provider_confirmed_uncharged'
      ))`,
  ),
  check(
    'budget_reservation_transitions_snapshot_ck',
    drizzleSql`${table.request_hash} ~ '^[0-9a-f]{64}$'
      AND ${table.request_hash} =
        public.pylva_budget_jsonb_sha256(${table.request_snapshot})
      AND jsonb_typeof(${table.request_snapshot}) = 'object'
      AND jsonb_typeof(${table.response_snapshot}) = 'object'`,
  ),
  check(
    'budget_reservation_transitions_state_ck',
    drizzleSql`(${table.type} = 'commit'
        AND ${table.from_state} IN ('reserved', 'unresolved')
        AND ${table.to_state} = 'committed')
      OR (${table.type} = 'release'
        AND ${table.from_state} IN ('reserved', 'unresolved')
        AND ${table.to_state} = 'released')
      OR (${table.type} = 'extend'
        AND ${table.from_state} = 'reserved'
        AND ${table.to_state} = 'reserved')
      OR (${table.type} = 'expire_unresolved'
        AND ${table.from_state} = 'reserved'
        AND ${table.to_state} = 'unresolved')`,
  ),
  check(
    'budget_reservation_transitions_version_ck',
    drizzleSql`${table.from_state_version} BETWEEN 0 AND 9223372036854775806
      AND ${table.to_state_version} BETWEEN 1 AND 9223372036854775807
      AND ${table.to_state_version} - ${table.from_state_version} = 1`,
  ),
  check(
    'budget_reservation_transitions_expiry_ck',
    drizzleSql`public.pylva_budget_timestamp_is_wire_safe(${table.from_expires_at})
      AND public.pylva_budget_timestamp_is_wire_safe(${table.to_expires_at})
      AND public.pylva_budget_timestamp_is_wire_safe(${table.occurred_at})
      AND (
        (${table.type} = 'extend'
          AND ${table.extend_by_seconds} BETWEEN 30 AND 3600
          AND ${table.to_expires_at} = ${table.from_expires_at}
            + make_interval(secs => ${table.extend_by_seconds})
          AND ${table.occurred_at} < ${table.from_expires_at})
        OR (${table.type} = 'expire_unresolved'
          AND ${table.extend_by_seconds} IS NULL
          AND ${table.to_expires_at} = ${table.from_expires_at}
          AND ${table.occurred_at} >= ${table.from_expires_at})
        OR (${table.type} IN ('commit', 'release')
          AND ${table.extend_by_seconds} IS NULL
          AND ${table.to_expires_at} = ${table.from_expires_at}
          AND (${table.from_state} = 'unresolved'
            OR ${table.occurred_at} < ${table.from_expires_at}))
      )`,
  ),
]);

export const budgetUsageLedger = pgTable('budget_usage_ledger', {
  builder_id: uuid('builder_id').notNull(),
  id: uuid('id').notNull().defaultRandom(),
  reservation_decision_id: uuid('reservation_decision_id').notNull(),
  operation_id: uuid('operation_id').notNull(),
  cost_event_id: uuid('cost_event_id').notNull(),
  customer_id: varchar('customer_id', { length: 255 }).notNull(),
  trace_id: uuid('trace_id').notNull(),
  span_id: uuid('span_id').notNull(),
  parent_span_id: uuid('parent_span_id'),
  step_name: varchar('step_name', { length: 200 }),
  framework: varchar('framework', { length: 40 }).notNull().default('none'),
  sdk_version: varchar('sdk_version', { length: 50 }).notNull().default('unknown'),
  sdk_language: varchar('sdk_language', { length: 20 }).notNull().default('unknown'),
  kind: varchar('kind', { length: 10 }).notNull(),
  provider: varchar('provider', { length: 255 }),
  model: varchar('model', { length: 255 }),
  actual_input_tokens: bigint('actual_input_tokens', { mode: 'number' }),
  actual_output_tokens: bigint('actual_output_tokens', { mode: 'number' }),
  cost_source_slug: varchar('cost_source_slug', { length: 100 }),
  tool_name: varchar('tool_name', { length: 200 }),
  metric: varchar('metric', { length: 100 }),
  actual_value: decimal('actual_value', { precision: 38, scale: 18 }),
  status: varchar('status', { length: 20 }).notNull(),
  latency_ms: bigint('latency_ms', { mode: 'number' }).notNull(),
  stream_aborted: boolean('stream_aborted').notNull(),
  actual_cost_usd: decimal('actual_cost_usd', { precision: 44, scale: 18 }).notNull(),
  pricing_snapshot: jsonb('pricing_snapshot'),
  pricing_snapshot_hash: char('pricing_snapshot_hash', { length: 64 }).notNull(),
  usage_snapshot: jsonb('usage_snapshot'),
  usage_snapshot_hash: char('usage_snapshot_hash', { length: 64 }).notNull(),
  cost_source: varchar('cost_source', { length: 20 }).notNull(),
  instrumentation_tier: varchar('instrumentation_tier', { length: 20 }).notNull(),
  is_demo: boolean('is_demo').notNull().default(false),
  retention_days: integer('retention_days').notNull(),
  billing_retention_days: integer('billing_retention_days').notNull(),
  metadata: jsonb('metadata').default({}),
  committed_at: timestamp('committed_at', { withTimezone: true }).notNull(),
  retain_until: timestamp('retain_until', { withTimezone: true }).notNull(),
  details_purged_at: timestamp('details_purged_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(drizzleSql`statement_timestamp()`),
}, (table) => [
  primaryKey({
    name: 'budget_usage_ledger_pk',
    columns: [table.builder_id, table.id],
  }),
  foreignKey({
    name: 'budget_usage_ledger_reservation_fk',
    columns: [table.builder_id, table.reservation_decision_id, table.operation_id],
    foreignColumns: [
      budgetReservations.builder_id,
      budgetReservations.decision_id,
      budgetReservations.operation_id,
    ],
  }).onDelete('restrict'),
  unique('budget_usage_ledger_decision_uk').on(
    table.builder_id,
    table.reservation_decision_id,
  ),
  unique('budget_usage_ledger_operation_uk').on(table.builder_id, table.operation_id),
  unique('budget_usage_ledger_cost_event_uk').on(table.builder_id, table.cost_event_id),
  unique('budget_usage_ledger_outbox_parent_uk').on(
    table.builder_id,
    table.id,
    table.cost_event_id,
  ),
  index('idx_budget_usage_ledger_builder_committed').on(
    table.builder_id,
    table.committed_at.desc().nullsFirst(),
    table.id,
  ),
  index('idx_budget_usage_ledger_retain_until').on(
    table.retain_until,
    table.builder_id,
    table.id,
  ),
  index('idx_budget_usage_ledger_purge_ready')
    .on(table.builder_id, table.retain_until, table.id)
    .where(drizzleSql`${table.details_purged_at} IS NULL`),
  index('idx_budget_usage_ledger_trace').on(
    table.builder_id,
    table.trace_id,
    table.committed_at.desc().nullsFirst(),
  ),
  check(
    'budget_usage_ledger_customer_id_ck',
    drizzleSql`${table.customer_id} ~ '^[A-Za-z0-9_-]{1,255}$'`,
  ),
  check(
    'budget_usage_ledger_framework_ck',
    drizzleSql`${table.framework} IN ('langgraph', 'crewai', 'mastra', 'openai-agents', 'pydantic-ai', 'none')`,
  ),
  check(
    'budget_usage_ledger_sdk_identity_ck',
    drizzleSql`${table.sdk_language} IN ('python', 'typescript', 'unknown')
      AND ${table.sdk_version} ~ '^[ -~]{1,50}$'`,
  ),
  check(
    'budget_usage_ledger_identifiers_ck',
    drizzleSql`(${table.step_name} IS NULL
        OR ${table.step_name} ~ '^[A-Za-z0-9 _.:/-]{0,200}$')
      AND (${table.provider} IS NULL OR (
        char_length(${table.provider}) BETWEEN 1 AND 255
        AND ${table.provider} !~ E'[\\\\u0001-\\\\u001F\\\\u007F]'
        AND ${table.provider} !~ E'^[\\\\u0009-\\\\u000D\\\\u0020\\\\u0085\\\\u00A0\\\\u1680\\\\u2000-\\\\u200A\\\\u2028\\\\u2029\\\\u202F\\\\u205F\\\\u3000\\\\uFEFF]*$'
      ))
      AND (${table.model} IS NULL OR (
        char_length(${table.model}) BETWEEN 1 AND 255
        AND ${table.model} !~ E'[\\\\u0001-\\\\u001F\\\\u007F]'
        AND ${table.model} !~ E'^[\\\\u0009-\\\\u000D\\\\u0020\\\\u0085\\\\u00A0\\\\u1680\\\\u2000-\\\\u200A\\\\u2028\\\\u2029\\\\u202F\\\\u205F\\\\u3000\\\\uFEFF]*$'
      ))
      AND (${table.tool_name} IS NULL OR (
        char_length(${table.tool_name}) BETWEEN 1 AND 200
        AND ${table.tool_name} ~ '^[A-Za-z0-9 _.:/-]+$'
      ))
      AND (${table.metric} IS NULL OR (
        char_length(${table.metric}) BETWEEN 1 AND 100
        AND ${table.metric} !~ E'[\\\\u0001-\\\\u001F\\\\u007F]'
        AND ${table.metric} !~ E'^[\\\\u0009-\\\\u000D\\\\u0020\\\\u0085\\\\u00A0\\\\u1680\\\\u2000-\\\\u200A\\\\u2028\\\\u2029\\\\u202F\\\\u205F\\\\u3000\\\\uFEFF]*$'
      ))`,
  ),
  check('budget_usage_ledger_kind_ck', drizzleSql`${table.kind} IN ('llm', 'tool')`),
  check(
    'budget_usage_ledger_usage_shape_ck',
    drizzleSql`(${table.kind} = 'llm'
        AND ${table.provider} IS NOT NULL
        AND ${table.model} IS NOT NULL
        AND ${table.actual_input_tokens} IS NOT NULL
        AND ${table.actual_output_tokens} IS NOT NULL
        AND ${table.cost_source_slug} IS NULL
        AND ${table.tool_name} IS NULL
        AND ${table.metric} IS NULL
        AND ${table.actual_value} IS NULL)
      OR (${table.kind} = 'tool'
        AND ${table.provider} IS NULL
        AND ${table.model} IS NULL
        AND ${table.actual_input_tokens} IS NULL
        AND ${table.actual_output_tokens} IS NULL
        AND ${table.cost_source_slug} IS NOT NULL
        AND ${table.tool_name} IS NOT NULL
        AND ${table.metric} IS NOT NULL
        AND ${table.actual_value} IS NOT NULL)`,
  ),
  check(
    'budget_usage_ledger_usage_bounds_ck',
    drizzleSql`(${table.actual_input_tokens} IS NULL OR ${table.actual_input_tokens} BETWEEN 0 AND 4294967295)
      AND (${table.actual_output_tokens} IS NULL OR ${table.actual_output_tokens} BETWEEN 0 AND 4294967295)
      AND (${table.actual_value} IS NULL OR (
        ${table.actual_value} <> 'NaN'::numeric AND ${table.actual_value} >= 0))
      AND ${table.latency_ms} BETWEEN 0 AND 4294967295
      AND ${table.actual_cost_usd} <> 'NaN'::numeric
      AND ${table.actual_cost_usd} >= 0
      AND (${table.cost_source_slug} IS NULL OR ${table.cost_source_slug} ~ '^[a-z0-9][a-z0-9-]{0,99}$')`,
  ),
  check(
    'budget_usage_ledger_status_ck',
    drizzleSql`${table.status} IN ('success', 'failure', 'retry', 'aborted')`,
  ),
  check(
    'budget_usage_ledger_projection_shape_ck',
    drizzleSql`${table.cost_source} IN ('auto', 'configured')
      AND ${table.instrumentation_tier} IN ('sdk_wrapper', 'reported')
      AND ((${table.kind} = 'llm' AND ${table.instrumentation_tier} = 'sdk_wrapper')
        OR (${table.kind} = 'tool'
          AND ${table.instrumentation_tier} = 'reported'
          AND ${table.cost_source} = 'configured'))`,
  ),
  check(
    'budget_usage_ledger_snapshots_ck',
    drizzleSql`${table.pricing_snapshot_hash} ~ '^[0-9a-f]{64}$'
      AND ${table.usage_snapshot_hash} ~ '^[0-9a-f]{64}$'
      AND CASE WHEN ${table.details_purged_at} IS NULL THEN
        ${table.pricing_snapshot} IS NOT NULL
        AND jsonb_typeof(${table.pricing_snapshot}) = 'object'
        AND ${table.pricing_snapshot_hash} =
          public.pylva_budget_jsonb_sha256(${table.pricing_snapshot})
        AND ${table.usage_snapshot} IS NOT NULL
        AND jsonb_typeof(${table.usage_snapshot}) = 'object'
        AND ${table.usage_snapshot_hash} =
          public.pylva_budget_jsonb_sha256(${table.usage_snapshot})
      ELSE
        ${table.pricing_snapshot} IS NULL
        AND ${table.usage_snapshot} IS NULL
        AND ${table.metadata} IS NULL
        AND public.pylva_budget_timestamp_is_wire_safe(${table.details_purged_at})
        AND ${table.details_purged_at} >= ${table.retain_until}
      END`,
  ),
  check(
    'budget_usage_ledger_metadata_ck',
    drizzleSql`CASE WHEN ${table.details_purged_at} IS NULL THEN
      ${table.metadata} IS NOT NULL
      AND jsonb_typeof(${table.metadata}) = 'object'
      AND (${table.metadata} - ARRAY[
        'provider_request_id', 'token_count_source', 'finish_reason'
      ]::text[]) = '{}'::jsonb
      AND (${table.metadata}->'provider_request_id' IS NULL OR (
        jsonb_typeof(${table.metadata}->'provider_request_id') = 'string'
        AND char_length(${table.metadata}->>'provider_request_id') <= 255
        AND ${table.metadata}->>'provider_request_id' !~ E'[\\\\u0001-\\\\u001F\\\\u007F]'
      ))
      AND (${table.metadata}->'token_count_source' IS NULL OR (
        jsonb_typeof(${table.metadata}->'token_count_source') = 'string'
        AND ${table.metadata}->>'token_count_source' IN ('exact', 'estimated')
      ))
      AND (${table.metadata}->'finish_reason' IS NULL OR (
        jsonb_typeof(${table.metadata}->'finish_reason') = 'string'
        AND char_length(${table.metadata}->>'finish_reason') <= 100
        AND ${table.metadata}->>'finish_reason' !~ E'[\\\\u0001-\\\\u001F\\\\u007F]'
      ))
    ELSE ${table.metadata} IS NULL END`,
  ),
  check(
    'budget_usage_ledger_retention_ck',
    drizzleSql`${table.retention_days} BETWEEN 1 AND 18250
      AND ${table.billing_retention_days} BETWEEN ${table.retention_days} AND 18250
      AND public.pylva_budget_timestamp_is_wire_safe(${table.committed_at})
      AND public.pylva_budget_timestamp_is_wire_safe(${table.retain_until})
      AND public.pylva_budget_timestamp_is_wire_safe(${table.created_at})
      AND ${table.created_at} >= ${table.committed_at}
      AND ${table.retain_until} >= ${table.committed_at}
        + ${table.billing_retention_days} * INTERVAL '1 day'`,
  ),
]);

export const budgetCostEventOutbox = pgTable('budget_cost_event_outbox', {
  builder_id: uuid('builder_id').notNull(),
  id: uuid('id').notNull().defaultRandom(),
  usage_ledger_id: uuid('usage_ledger_id').notNull(),
  cost_event_id: uuid('cost_event_id').notNull(),
  payload_schema_version: varchar('payload_schema_version', { length: 10 }).notNull(),
  payload: jsonb('payload'),
  payload_hash: char('payload_hash', { length: 64 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  available_at: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  locked_at: timestamp('locked_at', { withTimezone: true }),
  lock_expires_at: timestamp('lock_expires_at', { withTimezone: true }),
  lock_owner: varchar('lock_owner', { length: 100 }),
  last_attempt_at: timestamp('last_attempt_at', { withTimezone: true }),
  projected_at: timestamp('projected_at', { withTimezone: true }),
  projection_verified_at: timestamp('projection_verified_at', { withTimezone: true }),
  payload_purged_at: timestamp('payload_purged_at', { withTimezone: true }),
  last_error_code: varchar('last_error_code', { length: 80 }),
  last_error_message: varchar('last_error_message', { length: 1000 }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({
    name: 'budget_cost_event_outbox_pk',
    columns: [table.builder_id, table.id],
  }),
  foreignKey({
    name: 'budget_cost_event_outbox_usage_fk',
    columns: [table.builder_id, table.usage_ledger_id, table.cost_event_id],
    foreignColumns: [
      budgetUsageLedger.builder_id,
      budgetUsageLedger.id,
      budgetUsageLedger.cost_event_id,
    ],
  }).onDelete('restrict'),
  unique('budget_cost_event_outbox_usage_uk').on(table.builder_id, table.usage_ledger_id),
  unique('budget_cost_event_outbox_event_uk').on(table.builder_id, table.cost_event_id),
  index('idx_budget_cost_event_outbox_pending')
    .on(table.available_at, table.created_at, table.builder_id, table.id)
    .where(drizzleSql`${table.status} = 'pending'`),
  index('idx_budget_cost_event_outbox_expired_lease')
    .on(table.lock_expires_at, table.builder_id, table.id)
    .where(drizzleSql`${table.status} = 'processing'`),
  index('idx_budget_cost_event_outbox_projected_unverified')
    .on(table.builder_id)
    .where(
      drizzleSql`${table.status} = 'projected' AND ${table.projection_verified_at} IS NULL`,
    ),
  index('idx_budget_cost_event_outbox_builder_status').on(
    table.builder_id,
    table.status,
    table.updated_at.desc().nullsFirst(),
  ),
  check(
    'budget_cost_event_outbox_payload_ck',
    drizzleSql`${table.payload_schema_version} = '1.6'
      AND ${table.payload_hash} ~ '^[0-9a-f]{64}$'
      AND CASE WHEN ${table.payload_purged_at} IS NULL THEN
        ${table.payload} IS NOT NULL
        AND jsonb_typeof(${table.payload}) IS NOT DISTINCT FROM 'object'
        AND ${table.payload_hash} = public.pylva_budget_jsonb_sha256(${table.payload})
        AND jsonb_typeof(${table.payload}->'event_id') IS NOT DISTINCT FROM 'string'
        AND ${table.payload}->>'event_id' IS NOT DISTINCT FROM ${table.cost_event_id}::text
        AND jsonb_typeof(${table.payload}->'builder_id') IS NOT DISTINCT FROM 'string'
        AND ${table.payload}->>'builder_id' IS NOT DISTINCT FROM ${table.builder_id}::text
      ELSE
        ${table.payload} IS NULL
        AND ${table.status} = 'projected'
        AND ${table.projection_verified_at} IS NOT NULL
        AND public.pylva_budget_timestamp_is_wire_safe(${table.payload_purged_at})
        AND ${table.payload_purged_at} >= ${table.projection_verified_at}
        AND ${table.payload_purged_at} >= ${table.projected_at}
      END`,
  ),
  check(
    'budget_cost_event_outbox_status_ck',
    drizzleSql`${table.status} IN ('pending', 'processing', 'projected')`,
  ),
  check(
    'budget_cost_event_outbox_attempts_ck',
    drizzleSql`${table.attempts} BETWEEN 0 AND 2147483646`,
  ),
  check(
    'budget_cost_event_outbox_error_ck',
    drizzleSql`(${table.last_error_code} IS NULL OR ${table.last_error_code} ~ '^[A-Z0-9_]{1,80}$')
      AND (${table.last_error_message} IS NULL
        OR ${table.last_error_message} !~ E'[\\\\u0001-\\\\u001F\\\\u007F]')`,
  ),
  check(
    'budget_cost_event_outbox_lifecycle_ck',
    drizzleSql`public.pylva_budget_timestamp_is_wire_safe(${table.available_at})
      AND public.pylva_budget_timestamp_is_wire_safe(${table.created_at})
      AND public.pylva_budget_timestamp_is_wire_safe(${table.updated_at})
      AND ${table.available_at} >= ${table.created_at}
      AND (${table.locked_at} IS NULL
        OR public.pylva_budget_timestamp_is_wire_safe(${table.locked_at}))
      AND (${table.lock_expires_at} IS NULL
        OR public.pylva_budget_timestamp_is_wire_safe(${table.lock_expires_at}))
      AND (${table.last_attempt_at} IS NULL
        OR public.pylva_budget_timestamp_is_wire_safe(${table.last_attempt_at}))
      AND (${table.projected_at} IS NULL
        OR public.pylva_budget_timestamp_is_wire_safe(${table.projected_at}))
      AND (${table.projection_verified_at} IS NULL
        OR public.pylva_budget_timestamp_is_wire_safe(${table.projection_verified_at}))
      AND (${table.payload_purged_at} IS NULL
        OR public.pylva_budget_timestamp_is_wire_safe(${table.payload_purged_at}))
      AND (${table.projection_verified_at} IS NULL OR (
        ${table.status} = 'projected'
        AND ${table.projected_at} IS NOT NULL
        AND ${table.projection_verified_at} >= ${table.projected_at}
      ))
      AND ((${table.status} = 'pending'
        AND ${table.locked_at} IS NULL
        AND ${table.lock_expires_at} IS NULL
        AND ${table.lock_owner} IS NULL
        AND ${table.projected_at} IS NULL)
      OR (${table.status} = 'processing'
        AND ${table.locked_at} IS NOT NULL
        AND ${table.lock_expires_at} IS NOT NULL
        AND ${table.lock_expires_at} > ${table.locked_at}
        AND ${table.lock_expires_at} <= ${table.locked_at} + INTERVAL '5 minutes'
        AND ${table.lock_owner} IS NOT NULL
        AND char_length(${table.lock_owner}) BETWEEN 1 AND 100
        AND ${table.lock_owner} !~ E'[\\\\u0001-\\\\u001F\\\\u007F]'
        AND ${table.lock_owner} !~ E'^[\\\\u0009-\\\\u000D\\\\u0020\\\\u0085\\\\u00A0\\\\u1680\\\\u2000-\\\\u200A\\\\u2028\\\\u2029\\\\u202F\\\\u205F\\\\u3000\\\\uFEFF]*$'
        AND ${table.attempts} > 0
        AND ${table.last_attempt_at} IS NOT NULL
        AND ${table.last_attempt_at} >= ${table.locked_at}
        AND ${table.projected_at} IS NULL)
      OR (${table.status} = 'projected'
        AND ${table.locked_at} IS NULL
        AND ${table.lock_expires_at} IS NULL
        AND ${table.lock_owner} IS NULL
        AND ${table.projected_at} IS NOT NULL
        AND ${table.attempts} > 0
        AND ${table.last_attempt_at} IS NOT NULL
        AND ${table.projected_at} >= ${table.last_attempt_at}))`,
  ),
  check(
    'budget_cost_event_outbox_attempt_time_ck',
    drizzleSql`(${table.attempts} = 0 AND ${table.last_attempt_at} IS NULL)
      OR (${table.attempts} > 0
        AND ${table.last_attempt_at} IS NOT NULL
        AND ${table.last_attempt_at} >= ${table.created_at})`,
  ),
]);

// Migration-only physical features (Drizzle 0.45 cannot express them):
// - DEFERRABLE timing on the ledger FKs. Their shapes are mirrored above,
//   including budget_reservations_deciding_allocation_fk, which the migration
//   adds only after both sides of the cycle exist;
// - INCLUDE columns on the two allocation lookup indexes;
// - the transition idempotency identity as a NULLS NOT DISTINCT unique INDEX
//   (mirrored above as the equivalent NND unique constraint);
// - pylva_budget_authority_order_seq and its explicit PUBLIC privilege
//   revocation from migration 051;
// - all trigger programs: budget_accounts_immutability_guard,
//   budget_rule_revisions_immutability_guard,
//   budget_rule_revisions_successor_consistency_guard,
//   budget_reservations_immutability_guard,
//   budget_reservation_allocations_insert_guard,
//   budget_reservation_allocations_immutability_guard,
//   budget_reservation_allocations_posting_guard,
//   budget_reservation_transitions_append_only_guard,
//   budget_usage_ledger_immutability_guard,
//   budget_usage_ledger_parent_consistency_guard,
//   budget_reservations_usage_consistency_guard,
//   budget_usage_ledger_retention_pair_guard,
//   budget_cost_event_outbox_retention_pair_guard,
//   budget_reservations_transition_consistency_guard,
//   budget_reservation_transitions_parent_consistency_guard,
//   budget_reservations_allocations_consistency_guard,
//   budget_reservation_allocations_parent_consistency_guard,
//   budget_accounts_postings_consistency_guard,
//   budget_reservation_allocations_postings_consistency_guard, and
//   budget_cost_event_outbox_immutability_guard from migration 050, plus the
//   rule-revision authority-order, cutover, reservation-readiness, and
//   opening-evidence guards from migration 051; and
// - the nine ENABLE/FORCE-RLS policies using app.builder_id.
// Raw migrations 050-051 remain authoritative for those details.
