// Billing types — spec Section 12 Layer 2, Section 4.4
// B2b extensions: versioned pricing, invoice cycle grouping, preview-impact
// response, builder-level alert config, invoice idempotency.

import type { AlertDeliveryChannel } from './webhooks.js';

export const PricingModel = {
  FLAT: 'flat',
  PAY_AS_YOU_GO: 'pay_as_you_go',
  CREDIT_PACK: 'credit_pack',
  HYBRID: 'hybrid',
} as const;

export type PricingModel = (typeof PricingModel)[keyof typeof PricingModel];

// B2b migration 022 — versioned shape. Writes are INSERT-new + close-prior
// in a single transaction; reads use effective_from..effective_to overlap.
export interface CustomerPricing {
  id: string;
  builder_id: string;
  customer_id: string;
  pricing_model: PricingModel;
  flat_rate_usd: number | null;
  per_unit_rates: Record<string, number> | null; // metric -> rate
  credit_balance: number | null;
  billing_period: 'monthly' | 'weekly' | 'custom';
  stripe_customer_id: string | null;
  // B2b versioning
  version: number;
  effective_from: string; // ISO 8601
  effective_to: string | null;
  // B2b per-model fields (nullable — only the ones relevant to pricing_model are set)
  pack_price_usd: number | null;
  included_credits: number | null;
  overage_rate_usd: number | null;
  markup_pct: number | null;
  base_fee_usd: number | null;
  created_at: Date;
  updated_at: Date;
}

// B2b migration 023 — invoices grew cycle + webhook-driven timestamps.
export interface Invoice {
  id: string;
  builder_id: string;
  customer_id: string;
  stripe_invoice_id: string | null;
  amount_usd: number;
  period_start: string; // ISO 8601
  period_end: string; // ISO 8601
  status: 'draft' | 'pending' | 'paid' | 'failed' | 'void';
  line_items: InvoiceLineItem[];
  // B2b cycle + version reference
  billing_cycle_id: string | null;
  pricing_version: number | null;
  has_unpriced_events: boolean;
  // B2b Stripe webhook timestamps
  paid_at: string | null;
  payment_failed_at: string | null;
  last_viewed_at: string | null;
  created_at: Date;
}

export interface InvoiceLineItem {
  description: string;
  metric: string;
  quantity: number;
  unit_price_usd: number;
  total_usd: number;
  // B2b: historical reproducibility — which pricing version produced this line.
  pricing_version?: number;
}

// B2b migration 025 — widened status enum.
export const StripeConnectStatus = {
  NOT_CONNECTED: 'not_connected',
  PENDING_ONBOARDING: 'pending_onboarding',
  CONNECTED: 'connected',
  CONNECTED_PENDING_CAPABILITIES: 'connected_pending_capabilities',
  DISCONNECTED: 'disconnected',
} as const;

export type StripeConnectStatus = (typeof StripeConnectStatus)[keyof typeof StripeConnectStatus];

export interface StripeConnectState {
  builder_id: string;
  stripe_account_id: string | null;
  status: StripeConnectStatus;
  capabilities_ok: boolean;
  connected_at: Date | null;
}

// B2b — Preview Impact endpoint (/api/v1/billing/pricing/preview).
// GET query: customer_id + proposed pricing JSON. Response compares current
// vs proposed against the last 30 days of priced usage. Side-effect-free.
export interface PricingPreviewResponse {
  current: { amount_usd: number; line_items: InvoiceLineItem[] };
  proposed: { amount_usd: number; line_items: InvoiceLineItem[] };
  delta_usd: number;
  sample_period_start: string;
  sample_period_end: string;
}

// B2b — Invoice generate request/response.
export interface InvoiceGenerateRequest {
  customer_id: string;
  period_start: string;
  period_end: string;
}

export interface InvoiceGenerateResponse {
  invoice_id: string;
  stripe_invoice_id: string;
  amount_usd: number;
  has_unpriced_events: boolean;
  billing_cycle_id?: string; // present when part of an auto-split cycle
}

// B2b migration 024 — builder-level alert channel (Stripe webhook events).
export interface BuilderAlertConfig {
  builder_id: string;
  channel: AlertDeliveryChannel;
  enabled: boolean;
  webhook_config_id: string | null;
  email_recipients: string[] | null;
  slack_webhook_url: string | null;
}

// B2b migration 021 — idempotency cache (24h TTL).
export interface InvoiceIdempotency {
  idempotency_key: string;
  builder_id: string;
  invoice_id: string | null;
  request_hash: string;
  created_at: Date;
}
