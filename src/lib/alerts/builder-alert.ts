// B2b T2-D — builder-level alert dispatch.
//
// Triggered by Stripe webhook handlers on payment_failed / dispute. Loads
// `builder_alert_config` (migration 024), constructs a one-shot
// AlertChannelEntry, and calls the existing B2a channel delivery function
// (webhook / email / slack). Does NOT go through the batcher — these are
// ad-hoc single-dispatch events, not rule fires.
//
// If no config exists or it's disabled → audit `alert_skipped_no_config`
// and return. Stripe webhooks MUST return 200 even without an alert sent;
// builders without an alert config have opted out.

import { eq } from 'drizzle-orm';
import type { AlertChannelEntry, AlertPayload, WebhookPayload } from '@pylva/shared';
import { withRLS } from '../db/rls.js';
import { auditLog } from '../auth/audit-log.js';
import { AuditAction } from '../audit/actions.js';
import { builderAlertConfig } from '../db/schema.js';
import { deliverEmail } from './channels/email.js';
import { deliverSlack } from './channels/slack.js';
import { deliverWebhook } from './channels/webhook.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'alerts.builder-alert' });

function buildEntry(builderId: string, config: BuilderAlertRow): AlertChannelEntry | null {
  const now = new Date();
  const base = {
    id: `builder-alert-${builderId}`,
    rule_id: `builder-alert-${builderId}`,
    enabled: true,
    created_at: now,
    updated_at: now,
  };
  switch (config.channel) {
    case 'webhook':
      if (!config.webhook_config_id) return null;
      return { ...base, channel: 'webhook', webhook_config_id: config.webhook_config_id };
    case 'email':
      if (!config.email_recipients || config.email_recipients.length === 0) return null;
      return { ...base, channel: 'email', email_recipients: config.email_recipients };
    case 'slack':
      if (!config.slack_webhook_url) return null;
      return { ...base, channel: 'slack', slack_webhook_url: config.slack_webhook_url };
  }
  return null;
}

interface BuilderAlertRow {
  channel: 'webhook' | 'email' | 'slack';
  enabled: boolean;
  webhook_config_id: string | null;
  email_recipients: string[] | null;
  slack_webhook_url: string | null;
}

/**
 * Dispatch a single event to the builder's configured alert channel. No
 * retry here beyond whatever the channel impl does internally (webhook has
 * retryWithBackoff + DLQ on exhaustion; email/slack don't).
 */
export async function deliverBuilderAlert(params: {
  builderId: string;
  payload: WebhookPayload;
}): Promise<void> {
  const configRow = await withRLS(params.builderId, async (tx) => {
    const rows = await tx
      .select({
        channel: builderAlertConfig.channel,
        enabled: builderAlertConfig.enabled,
        webhook_config_id: builderAlertConfig.webhook_config_id,
        email_recipients: builderAlertConfig.email_recipients,
        slack_webhook_url: builderAlertConfig.slack_webhook_url,
      })
      .from(builderAlertConfig)
      .where(eq(builderAlertConfig.builder_id, params.builderId))
      .limit(1);
    return rows[0] ?? null;
  });

  if (!configRow || !configRow.enabled) {
    await withRLS(params.builderId, async (tx) => {
      await auditLog(tx, {
        builder_id: params.builderId,
        actor_type: 'system',
        actor_id: 'stripe-webhook',
        action: AuditAction.ALERT_SKIPPED_NO_CONFIG,
        resource_type: 'builder_alert_config',
        details: { event_type: params.payload.type },
      });
    });
    return;
  }

  const entry = buildEntry(params.builderId, configRow as BuilderAlertRow);
  if (!entry) {
    log.warn({ builder_id: params.builderId }, 'builder_alert_config row has no usable target');
    return;
  }

  const alertPayload: AlertPayload = {
    version: '1.0',
    rule_id: `builder-alert-${params.builderId}`,
    fired_at: new Date().toISOString(),
    payload: params.payload,
  };

  const ctx = { builder_id: params.builderId, rule_id: alertPayload.rule_id };
  try {
    switch (entry.channel) {
      case 'webhook':
        await deliverWebhook([alertPayload], entry, ctx);
        break;
      case 'email':
        await deliverEmail([alertPayload], entry, ctx);
        break;
      case 'slack':
        await deliverSlack([alertPayload], entry, ctx);
        break;
    }
  } catch (err) {
    // Channel impl bug: log + swallow. Stripe webhook must still 200 so it
    // doesn't retry — our status-update side-effect is what matters.
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { builder_id: params.builderId, channel: entry.channel, error: message },
      'builder alert dispatch threw',
    );
  }
}
