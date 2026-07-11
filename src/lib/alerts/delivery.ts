// B2a — alert fan-out. Takes a rule fire + its configured channels and
// dispatches. Each channel runs in parallel (I-T4a-1 Promise.allSettled)
// with per-channel retry + DLQ isolation. The batcher coalesces dispatches
// to the same channel:config_key within a 60s window (D31, §3.4).
//
// alert_history is written AFTER the parallel fan-out resolves so we capture
// the final per-channel delivery_status.

import { withRLS } from '../db/rls.js';
import { alertHistory } from '../db/schema.js';
import { logger } from '../logger.js';
import { schedule as scheduleBatch } from './batcher.js';
import { deliverWebhook } from './channels/webhook.js';
import { deliverEmail } from './channels/email.js';
import { deliverSlack } from './channels/slack.js';
import type {
  AlertChannelEntry,
  AlertPayload,
  BatchedAlertPayload,
  DeliveryResult,
  DeliveryStatusByChannel,
} from '@pylva/shared';

const log = logger.child({ module: 'alerts.delivery' });

export interface DeliverAlertInput {
  builder_id: string;
  rule_id: string;
  payload: AlertPayload;
  channels: AlertChannelEntry[];
}

/**
 * Dispatch a single rule-fire. Routes each channel through the batcher; the
 * batcher calls back into dispatchNow with the coalesced payload when the
 * window closes.
 */
export async function deliverAlert(input: DeliverAlertInput): Promise<void> {
  const activeChannels = input.channels.filter((c) => c.enabled);
  for (const channel of activeChannels) {
    scheduleBatch(channel, input.payload, deliverCoalescedAlert);
  }

  // Even when there are zero channels (silent rule, D30), write alert_history
  // with an empty delivery_status so the fires-vs-deliveries discrepancy is
  // visible in the dashboard history page.
  if (activeChannels.length === 0) {
    await writeAlertHistory(input.builder_id, input.rule_id, input.payload, {});
  }
}

interface DispatchNowInput {
  builder_id: string;
  rule_id: string;
  entry: AlertChannelEntry;
  payloads: AlertPayload[];
}

function payloadsFromCoalesced(coalesced: AlertPayload | BatchedAlertPayload): AlertPayload[] {
  return 'batch' in coalesced ? coalesced.batch : [coalesced];
}

function groupPayloadsByBuilder(payloads: AlertPayload[]): Map<string, AlertPayload[]> {
  const grouped = new Map<string, AlertPayload[]>();
  for (const payload of payloads) {
    const builderId = payload.payload.builder_id;
    const existing = grouped.get(builderId);
    if (existing) {
      existing.push(payload);
    } else {
      grouped.set(builderId, [payload]);
    }
  }
  return grouped;
}

export async function deliverCoalescedAlert(
  entry: AlertChannelEntry,
  coalesced: AlertPayload | BatchedAlertPayload,
): Promise<void> {
  const payloads = payloadsFromCoalesced(coalesced);
  const byBuilder = groupPayloadsByBuilder(payloads);

  if (byBuilder.size > 1) {
    log.error(
      { channel: entry.channel, builder_ids: [...byBuilder.keys()] },
      'mixed-builder alert batch split before delivery',
    );
  }

  await Promise.all(
    [...byBuilder.entries()].map(([builder_id, builderPayloads]) =>
      dispatchNow({
        builder_id,
        rule_id: builderPayloads[0]!.rule_id,
        entry,
        payloads: builderPayloads,
      }),
    ),
  );
}

async function dispatchNow(input: DispatchNowInput): Promise<void> {
  let result: DeliveryResult;
  try {
    switch (input.entry.channel) {
      case 'webhook':
        result = await deliverWebhook(input.payloads, input.entry, {
          builder_id: input.builder_id,
          rule_id: input.rule_id,
        });
        break;
      case 'email':
        result = await deliverEmail(input.payloads, input.entry, {
          builder_id: input.builder_id,
          rule_id: input.rule_id,
        });
        break;
      case 'slack':
        result = await deliverSlack(input.payloads, input.entry, {
          builder_id: input.builder_id,
          rule_id: input.rule_id,
        });
        break;
    }
  } catch (err) {
    // Channel impl bug: log + swallow so no pending batch corrupts further fires.
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { builder_id: input.builder_id, channel: input.entry.channel, error: message },
      'channel dispatch threw unexpectedly',
    );
    result = { ok: false, attempts: 0, last_error: message };
  }

  const status: DeliveryStatusByChannel = {
    [input.entry.channel]: {
      ok: result.ok,
      attempts: result.attempts,
      last_error: result.last_error ?? null,
    },
  };

  // Append one history row per rule-fire (coalesced may span multiple
  // payloads — we still write one row per dispatch to match how channels
  // deliver).
  for (const p of input.payloads) {
    await writeAlertHistory(p.payload.builder_id, p.rule_id, p, status);
  }
}

async function writeAlertHistory(
  builder_id: string,
  rule_id: string,
  payload: AlertPayload,
  delivery_status: DeliveryStatusByChannel,
): Promise<void> {
  try {
    await withRLS(builder_id, async (tx) => {
      await tx.insert(alertHistory).values({
        builder_id,
        rule_id,
        fired_at: new Date(payload.fired_at),
        payload: payload as unknown as Record<string, unknown>,
        delivery_status: delivery_status as unknown as Record<string, unknown>,
      });
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ builder_id, rule_id, error: message }, 'alert_history insert failed');
  }
}
