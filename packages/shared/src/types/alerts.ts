// B2a alert-channel + delivery types — spec §4.5 + §4.2a.
// Complements webhooks.ts: this file models the per-rule channel config
// row (rule_alert_channels) and the fan-out/delivery contract used by
// src/lib/alerts/*.

import type { AlertDeliveryChannel } from './webhooks.js';
import type { WebhookPayload } from './webhooks.js';

// --- Per-rule channel config (§4.2a) ---

// Tagged union keyed on `channel`. The DB check constraint
// (rac_exactly_one_of) mirrors this union: exactly one of
// webhook_config_id / email_recipients / slack_webhook_url is set.

export interface RuleAlertChannelWebhook {
  id: string;
  rule_id: string;
  channel: typeof AlertDeliveryChannel.WEBHOOK;
  enabled: boolean;
  webhook_config_id: string;
  created_at: Date;
  updated_at: Date;
}

export interface RuleAlertChannelEmail {
  id: string;
  rule_id: string;
  channel: typeof AlertDeliveryChannel.EMAIL;
  enabled: boolean;
  email_recipients: string[]; // 1..10 addresses
  created_at: Date;
  updated_at: Date;
}

export interface RuleAlertChannelSlack {
  id: string;
  rule_id: string;
  channel: typeof AlertDeliveryChannel.SLACK;
  enabled: boolean;
  slack_webhook_url: string; // Slack Incoming Webhook URL
  created_at: Date;
  updated_at: Date;
}

export type AlertChannelEntry =
  | RuleAlertChannelWebhook
  | RuleAlertChannelEmail
  | RuleAlertChannelSlack;

// --- Delivery shapes (§3.4, §7.1) ---

// Single-alert payload flowing through the batcher. In single-alert
// dispatches (`count === 1`) this IS the wire shape — preserves the
// pre-batch v1.1 contract so existing integrations don't break (I-T4a-7).
export interface AlertPayload {
  version: '1.0';
  rule_id: string;
  fired_at: string; // ISO 8601
  payload: WebhookPayload;
}

// Coalesced wire shape for multi-alert dispatches. Wrapped when the
// batcher collects ≥2 payloads within the 60s window (§3.4).
export interface BatchedAlertPayload {
  version: '1.0';
  batch: AlertPayload[];
  count: number; // batch.length; denormalized for convenience
  fired_at: string; // ISO 8601 of first payload (anchor time)
}

// Result of one deliver attempt (after retry exhaustion or success).
export interface DeliveryResult {
  ok: boolean;
  attempts: number;
  last_error?: string;
}

// Per-channel status embedded in alert_history.delivery_status JSONB.
// Shape: { webhook?: DeliveryStatus, email?: DeliveryStatus, slack?: DeliveryStatus }
export interface DeliveryStatus {
  ok: boolean;
  attempts: number;
  last_error: string | null;
}

export type DeliveryStatusByChannel = {
  [K in AlertDeliveryChannel]?: DeliveryStatus;
};
