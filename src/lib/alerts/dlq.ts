// B2a — Dead-letter-queue writes. B2a writes on retry exhaustion; B2b adds
// the dashboard UI (list/retry/dismiss) + purge cron.
//
// channel_config_snapshot is CRITICAL: the retry in B2b replays against the
// frozen snapshot, not the live config (I-T4a-3). This protects against
// config edits mid-failure.

import { withRLS } from '../db/rls.js';
import { webhookDlq } from '../db/schema.js';
import { logger } from '../logger.js';
import type { AlertDeliveryChannel } from '@pylva/shared';

const log = logger.child({ module: 'alerts.dlq' });

export interface WriteDlqInput {
  builder_id: string;
  channel: AlertDeliveryChannel;
  webhook_config_id?: string | null;
  event_type?: string; // default 'rule.fired'
  payload: Record<string, unknown>;
  channel_config_snapshot: Record<string, unknown>;
  last_error: string;
  attempts: number;
}

export async function writeToDlq(input: WriteDlqInput): Promise<void> {
  try {
    await withRLS(input.builder_id, async (tx) => {
      await tx.insert(webhookDlq).values({
        builder_id: input.builder_id,
        channel: input.channel,
        webhook_config_id: input.webhook_config_id ?? null,
        event_type: input.event_type ?? 'rule.fired',
        payload: input.payload,
        channel_config_snapshot: input.channel_config_snapshot,
        attempts: input.attempts,
        last_attempt_at: new Date(),
        last_error: input.last_error,
      });
    });
  } catch (err) {
    // DLQ write itself failed — we've already exhausted retries on the primary
    // channel; log loudly and move on. Sentry captures this (§4.7 SENTRY_DSN).
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { builder_id: input.builder_id, channel: input.channel, error: message },
      'DLQ write failed',
    );
  }
}
