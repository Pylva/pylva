// B2a — in-process 60s window coalescer (D31, §3.4).
//
// When multiple alerts target the same channel:config pair within the window,
// the batcher wraps them into one BatchedAlertPayload. Single-alert case
// (count === 1) emits the AlertPayload shape unchanged so integrations
// wired to the v1.1 wire contract don't break (I-T4a-7).
//
// Memory protection: hard cap at MAX_PENDING_BATCHES pending batches per
// process. On overflow, oldest is flushed + logged (§11 risk #2).
//
// Process shutdown (I-T4a-9): flushAll() is called from a SIGTERM handler
// wired in server setup so an ECS task termination doesn't drop alerts.
// SIGKILL is lossy by design; durable queue is B3.

import type { AlertPayload, BatchedAlertPayload, AlertChannelEntry } from '@pylva/shared';
import { logger } from '../logger.js';

const log = logger.child({ module: 'alerts.batcher' });

const BATCH_WINDOW_MS = 60_000;
const MAX_PENDING_BATCHES = 1000;

interface PendingBatch {
  key: string;
  entry: AlertChannelEntry;
  payloads: AlertPayload[];
  timer: ReturnType<typeof setTimeout>;
  started_at: number;
}

export type DeliverFn = (
  entry: AlertChannelEntry,
  coalesced: AlertPayload | BatchedAlertPayload,
) => Promise<void>;

const pending = new Map<string, PendingBatch>();

function channelConfigKey(builderId: string, entry: AlertChannelEntry): string {
  // builderId MUST prefix the key. slack_webhook_url and email_recipients carry
  // no DB uniqueness across builders (schema.ts) — two tenants can configure the
  // SAME Slack URL or recipient list. Without the prefix their fires coalesce
  // into one batch, get delivered under (and written to alert_history as) the
  // first scheduler's builder_id — a cross-tenant isolation break (R7).
  switch (entry.channel) {
    case 'webhook':
      return `${builderId}:webhook:${entry.webhook_config_id}`;
    case 'email': {
      // Hash the recipient list so different email-recipient permutations
      // don't coalesce into one batch.
      const joined = [...entry.email_recipients].sort().join(',');
      return `${builderId}:email:${joined}`;
    }
    case 'slack':
      return `${builderId}:slack:${entry.slack_webhook_url}`;
  }
}

function coalesce(pending: PendingBatch): AlertPayload | BatchedAlertPayload {
  if (pending.payloads.length === 1) return pending.payloads[0]!;
  return {
    version: '1.0',
    batch: pending.payloads,
    count: pending.payloads.length,
    fired_at: pending.payloads[0]!.fired_at,
  };
}

function logDeliveryError(key: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  log.error({ key, error: message }, 'batch delivery threw');
}

function flushOneDetached(batch: PendingBatch, deliver: DeliverFn): void {
  void flushOne(batch, deliver);
}

function evictOldest(deliver: DeliverFn): void {
  const firstKey = pending.keys().next().value;
  if (firstKey === undefined) return;
  const batch = pending.get(firstKey);
  if (!batch) return;
  log.warn(
    { key: firstKey, size: pending.size },
    'batcher overflow — flushing oldest pending batch',
  );
  flushOneDetached(batch, deliver);
}

async function flushOne(batch: PendingBatch, deliver: DeliverFn): Promise<void> {
  clearTimeout(batch.timer);
  pending.delete(batch.key);
  const payload = coalesce(batch);
  try {
    await deliver(batch.entry, payload);
  } catch (err) {
    logDeliveryError(batch.key, err);
  }
}

export function schedule(
  entry: AlertChannelEntry,
  payload: AlertPayload,
  deliver: DeliverFn,
): void {
  // Every AlertPayload's inner payload extends WebhookPayloadBase (builder_id),
  // so the owning tenant is always available without threading an extra param.
  const key = channelConfigKey(payload.payload.builder_id, entry);
  const existing = pending.get(key);
  if (existing) {
    existing.payloads.push(payload);
    return;
  }

  // Evict oldest before inserting if we're at the cap.
  if (pending.size >= MAX_PENDING_BATCHES) {
    evictOldest(deliver);
  }

  const batch: PendingBatch = {
    key,
    entry,
    payloads: [payload],
    started_at: Date.now(),
    timer: setTimeout(() => {
      const b = pending.get(key);
      if (b) flushOneDetached(b, deliver);
    }, BATCH_WINDOW_MS),
  };
  if (typeof (batch.timer as unknown as { unref?: () => void }).unref === 'function') {
    (batch.timer as unknown as { unref: () => void }).unref();
  }
  pending.set(key, batch);
}

/** Awaitable flush — called from SIGTERM handler so nothing pending on deploy. */
export async function flushAll(deliver: DeliverFn): Promise<void> {
  const batches = [...pending.values()];
  await Promise.all(batches.map((b) => flushOne(b, deliver)));
}

/** Test helper — drains pending batches without delivering. */
export function _resetBatcherForTests(): void {
  for (const b of pending.values()) clearTimeout(b.timer);
  pending.clear();
}

export function _pendingSizeForTests(): number {
  return pending.size;
}
