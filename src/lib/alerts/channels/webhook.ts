// B2a — user-facing webhook channel. Distinct from src/lib/alerts/slack.ts
// (the internal B1 team-notify helper).
//
// Signs with HMAC-SHA256 using `webhook_configs.secret` + the rule's fired_at
// timestamp. Grace-window (24h) is handled by the verify-side contract: the
// SDK's verifyWebhook accepts both the current secret and secret_prior when
// secret_rotated_at < NOW() - 24h. On this side we always sign with the
// current secret, so nothing special.
//
// Orphaned config (webhook_config_id deleted between fire + dispatch): we
// detect via the absent row + route directly to DLQ with reason
// `webhook_config_orphaned` (§2e D2 footnote).

import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { withRLS } from '../../db/rls.js';
import { webhookConfigs } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { retryWithBackoff, isRetryableHttpError } from '../retry.js';
import { writeToDlq } from '../dlq.js';
import { externalFetch } from '../../external-egress.js';
import type { ChannelDeliverFn } from './channel.interface.ts';
import type {
  AlertPayload,
  BatchedAlertPayload,
  AlertChannelEntry,
  RuleAlertChannelWebhook,
} from '@pylva/shared';

const log = logger.child({ module: 'alerts.webhook' });
const WEBHOOK_FETCH_TIMEOUT_MS = 15_000;

interface WebhookConfigSnapshot {
  url: string;
  secret: string;
  events: string[];
}

async function loadWebhookConfig(
  builder_id: string,
  webhook_config_id: string,
): Promise<WebhookConfigSnapshot | null> {
  try {
    return await withRLS(builder_id, async (tx) => {
      const rows = await tx
        .select({
          url: webhookConfigs.url,
          secret: webhookConfigs.secret,
          events: webhookConfigs.events,
        })
        .from(webhookConfigs)
        .where(
          and(eq(webhookConfigs.id, webhook_config_id), eq(webhookConfigs.builder_id, builder_id)),
        )
        .limit(1);
      if (rows.length === 0) return null;
      return rows[0] as WebhookConfigSnapshot;
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ builder_id, webhook_config_id, error: message }, 'webhook config load failed');
    return null;
  }
}

function buildBody(payloads: AlertPayload[]): AlertPayload | BatchedAlertPayload {
  if (payloads.length === 1) return payloads[0]!;
  return {
    version: '1.0',
    batch: payloads,
    count: payloads.length,
    fired_at: payloads[0]!.fired_at,
  };
}

function signHmac(body: string, secret: string, timestamp: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/**
 * Timing-safe env check — tests compare against a fixture signature, so we
 * want a constant-time compare when used as a self-verify smoke.
 */
export function verifyHmacSmoke(
  body: string,
  sig: string,
  secret: string,
  timestamp: string,
): boolean {
  const expected = signHmac(body, secret, timestamp);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(sig, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const deliverWebhook: ChannelDeliverFn = async (payloads, entry, ctx) => {
  if (entry.channel !== 'webhook') {
    throw new Error(
      `[alerts.webhook] non-webhook entry routed to webhook channel (got ${entry.channel})`,
    );
  }
  const webhookEntry = entry as RuleAlertChannelWebhook;

  const config = await loadWebhookConfig(ctx.builder_id, webhookEntry.webhook_config_id);
  if (!config) {
    // Orphan: write directly to DLQ (we don't even try to deliver).
    await writeToDlq({
      builder_id: ctx.builder_id,
      channel: 'webhook',
      webhook_config_id: webhookEntry.webhook_config_id,
      event_type: 'rule.fired',
      payload: buildBody(payloads) as unknown as Record<string, unknown>,
      channel_config_snapshot: {},
      last_error: 'webhook_config_orphaned',
      attempts: 0,
    });
    return { ok: false, attempts: 0, last_error: 'webhook_config_orphaned' };
  }

  const body = buildBody(payloads);
  const bodyText = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signHmac(bodyText, config.secret, timestamp);

  const result = await retryWithBackoff(
    async () => {
      const res = await externalFetch({
        target: 'custom_webhook',
        url: config.url,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Pylva-Signature': `sha256=${signature}`,
          'X-Pylva-Timestamp': timestamp,
        },
        body: bodyText,
        timeoutMs: WEBHOOK_FETCH_TIMEOUT_MS,
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`webhook POST failed: ${res.status} ${res.statusText}`);
      }
    },
    { retryable: isRetryableHttpError },
  );

  if (!result.ok) {
    await writeToDlq({
      builder_id: ctx.builder_id,
      channel: 'webhook',
      webhook_config_id: webhookEntry.webhook_config_id,
      event_type: 'rule.fired',
      payload: body as unknown as Record<string, unknown>,
      channel_config_snapshot: config as unknown as Record<string, unknown>,
      last_error: result.last_error ?? 'unknown',
      attempts: result.attempts,
    });
  }

  return {
    ok: result.ok,
    attempts: result.attempts,
    ...(result.last_error ? { last_error: result.last_error } : {}),
  };
};

/** Test export — lets unit tests call the inner loader without a real DB. */
export const _internal = { loadWebhookConfig, signHmac };

// Silence unused import warning if a caller imports just the helpers.
export type { AlertChannelEntry };
