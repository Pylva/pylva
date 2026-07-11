// B2a — email alert channel via Resend (D12, §4.1 dep).
//
// Phase 0a ships the delivery + retry + DLQ skeleton; T4a (PR #13) fleshes
// out the HTML templates (src/lib/alerts/templates/email/*) and the
// batched-summary wording.
//
// Resend client is lazily constructed so the module loads even when
// RESEND_API_KEY is unset (dev smoke). Without a key, delivery fails fast
// → DLQ.

import { env } from '../../config.js';
import { logger } from '../../logger.js';
import { retryWithBackoff, isRetryableHttpError } from '../retry.js';
import { writeToDlq } from '../dlq.js';
import { renderAlertEmail } from '../templates/email/alert.js';
import type { ChannelDeliverFn } from './channel.interface.ts';
import type { AlertPayload, RuleAlertChannelEmail } from '@pylva/shared';

const log = logger.child({ module: 'alerts.email' });

interface ResendClient {
  emails: {
    send: (input: {
      from: string;
      to: string[];
      subject: string;
      html: string;
    }) => Promise<{ data?: { id: string } | null; error?: { message: string } | null }>;
  };
}

let _client: ResendClient | null = null;

async function getResend(): Promise<ResendClient | null> {
  if (_client) return _client;
  if (!env.RESEND_API_KEY) return null;
  const { Resend } = await import('resend');
  _client = new Resend(env.RESEND_API_KEY) as unknown as ResendClient;
  return _client;
}

export const deliverEmail: ChannelDeliverFn = async (payloads, entry, ctx) => {
  if (entry.channel !== 'email') {
    throw new Error(
      `[alerts.email] non-email entry routed to email channel (got ${entry.channel})`,
    );
  }
  const emailEntry = entry as RuleAlertChannelEmail;

  const client = await getResend();
  if (!client) {
    const err = 'RESEND_API_KEY_missing';
    log.warn(
      { builder_id: ctx.builder_id },
      'email delivery attempted with no RESEND_API_KEY — writing to DLQ',
    );
    await writeToDlq({
      builder_id: ctx.builder_id,
      channel: 'email',
      webhook_config_id: null,
      event_type: 'rule.fired',
      payload: payloads as unknown as Record<string, unknown>,
      channel_config_snapshot: { email_recipients: emailEntry.email_recipients },
      last_error: err,
      attempts: 0,
    });
    return { ok: false, attempts: 0, last_error: err };
  }

  const { subject, html } = renderAlertEmail(payloads);

  const result = await retryWithBackoff(
    async () => {
      const res = await client.emails.send({
        from: env.ALERT_FROM_EMAIL,
        to: emailEntry.email_recipients,
        subject,
        html,
      });
      if (res.error) throw new Error(`resend error: ${res.error.message}`);
    },
    { retryable: isRetryableHttpError },
  );

  if (!result.ok) {
    await writeToDlq({
      builder_id: ctx.builder_id,
      channel: 'email',
      webhook_config_id: null,
      event_type: 'rule.fired',
      payload: payloads as unknown as Record<string, unknown>,
      channel_config_snapshot: { email_recipients: emailEntry.email_recipients },
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

/**
 * v1.1 follow-up — send from a frozen DLQ snapshot. Used by
 * src/lib/alerts/dlq-retry.ts to replay an email entry against the
 * recipients captured at the original failure time, never live config.
 *
 * Returns { ok: true } on Resend success; { ok: false, error } on any
 * failure (no key configured, malformed snapshot, send failure). Does
 * not write to DLQ — the retry library updates the existing row.
 */
export async function sendEmailFromSnapshot(
  snapshot: { email_recipients?: string[] },
  payload: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!Array.isArray(snapshot.email_recipients) || snapshot.email_recipients.length === 0) {
    return { ok: false, error: 'snapshot_missing_email_recipients' };
  }
  const client = await getResend();
  if (!client) return { ok: false, error: 'RESEND_API_KEY_missing' };

  // The DLQ payload column for the email channel stores the RAW
  // AlertPayload[] verbatim (see deliverEmail's writeToDlq calls: it
  // persists `payloads`, the array, NOT buildBody's single/batched
  // shape that the webhook channel uses). So the already-an-array case
  // is the real production shape and MUST be checked first — otherwise
  // the array gets re-wrapped into `[ [AlertPayload, …] ]`, renderAlertEmail
  // reads `.payload.type` off the inner array, throws, and every email
  // DLQ retry fails permanently (the email twin of the slack #229 bug).
  // The batched / single branches stay as defensive fallbacks for any
  // future caller that passes buildBody's shape.
  const payloads: AlertPayload[] = Array.isArray(payload)
    ? (payload as AlertPayload[])
    : Array.isArray((payload as { batch?: unknown[] }).batch)
      ? (payload as { batch: AlertPayload[] }).batch
      : [payload as AlertPayload];

  try {
    const { subject, html } = renderAlertEmail(payloads);
    const res = await client.emails.send({
      from: env.ALERT_FROM_EMAIL,
      to: snapshot.email_recipients,
      subject,
      html,
    });
    if (res.error) return { ok: false, error: res.error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Silence unused-export warning for the PendingBatch payload type.
export type { AlertPayload };
