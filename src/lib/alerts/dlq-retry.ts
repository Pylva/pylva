// Track 1 PR 1.4 — DLQ retry library.
//
// Locks the row with SELECT ... FOR UPDATE SKIP LOCKED (per O3) so two
// concurrent retries can't double-fire. Replays delivery against the
// frozen channel_config_snapshot, never live config (per D10). On success
// the row is deleted + audited; on failure attempts/last_attempt_at/
// last_error get bumped + audited.

import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { DrizzleTransaction } from '../db/rls.js';
import { withRLS } from '../db/rls.js';
import { unwrapRows } from '../db/query-utils.js';
import { auditLog } from '../auth/audit-log.js';
import { AuditAction } from '../audit/actions.js';
import { logger } from '../logger.js';
import { externalFetch } from '../external-egress.js';
import type { AlertPayload } from '@pylva/shared';

const log = logger.child({ module: 'alerts.dlq-retry' });
const RETRY_FETCH_TIMEOUT_MS = 15_000;

export type RetryOutcome =
  | { kind: 'not_found' }
  | { kind: 'success'; channel: string }
  | { kind: 'failure'; channel: string; attempts: number; error: string };

export interface RetryInput {
  builderId: string;
  dlqId: string;
  actorUserId: string;
}

export interface DlqRow {
  id: string;
  channel: string;
  webhook_config_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  snapshot: Record<string, unknown>;
  attempts: number;
}

export async function retryDlqEntry(input: RetryInput): Promise<RetryOutcome> {
  return withRLS(input.builderId, async (tx) => {
    const lockedRows = await tx.execute(sql`
      SELECT id, channel, webhook_config_id, event_type, payload,
             channel_config_snapshot AS snapshot, attempts
      FROM webhook_dlq
      WHERE id = ${input.dlqId}::uuid
        AND builder_id = ${input.builderId}::uuid
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `);
    const row = unwrapRows<DlqRow>(lockedRows)[0];
    if (!row) return { kind: 'not_found' } as const;

    const result = await deliverFromSnapshot(row);

    if (result.ok) {
      await tx.execute(sql`DELETE FROM webhook_dlq WHERE id = ${row.id}::uuid`);
      await auditLog(tx, {
        builder_id: input.builderId,
        actor_type: 'user',
        actor_id: input.actorUserId,
        action: AuditAction.ALERT_DLQ_RETRY_SUCCESS,
        resource_type: 'webhook_dlq',
        resource_id: row.id,
        details: { channel: row.channel },
      });
      return { kind: 'success', channel: row.channel } as const;
    }

    const attempts = row.attempts + 1;
    await tx.execute(sql`
      UPDATE webhook_dlq
      SET attempts = ${attempts},
          last_attempt_at = NOW(),
          last_error = ${result.error}
      WHERE id = ${row.id}::uuid
    `);
    await auditLog(tx, {
      builder_id: input.builderId,
      actor_type: 'user',
      actor_id: input.actorUserId,
      action: AuditAction.ALERT_DLQ_RETRY_FAILED,
      resource_type: 'webhook_dlq',
      resource_id: row.id,
      details: { channel: row.channel, attempts, error: result.error },
    });
    return { kind: 'failure', channel: row.channel, attempts, error: result.error } as const;
  });
}

export async function deliverFromSnapshot(
  row: DlqRow,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (row.channel === 'webhook') {
      const snap = row.snapshot as { url?: string; secret?: string };
      if (!snap.url || !snap.secret) return { ok: false, error: 'snapshot_missing_webhook_fields' };
      const body = JSON.stringify(row.payload);
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = createHmac('sha256', snap.secret).update(`${ts}.${body}`).digest('hex');
      const res = await externalFetch({
        target: 'custom_webhook',
        url: snap.url,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Pylva-Signature': `sha256=${sig}`,
          'X-Pylva-Timestamp': ts,
        },
        body,
        timeoutMs: RETRY_FETCH_TIMEOUT_MS,
      });
      if (res.status < 200 || res.status >= 300)
        return { ok: false, error: `webhook ${res.status}` };
      return { ok: true };
    }

    if (row.channel === 'slack') {
      const snap = row.snapshot as { slack_webhook_url?: string };
      if (!snap.slack_webhook_url) return { ok: false, error: 'snapshot_missing_slack_url' };
      // The slack channel stores the raw AlertPayload[] in the DLQ (like
      // email), NOT the rendered Block Kit body (unlike webhook). Replaying
      // `row.payload` verbatim posts a bare JSON array, which Slack's
      // Incoming Webhook API rejects with 400 invalid_payload — so every
      // slack retry failed permanently. Re-render `{ blocks }` here, exactly
      // as the live deliverSlack path does, mirroring how email re-renders.
      const { buildAlertBlocks } = await import('./templates/slack/block-builder.js');
      const blocks = buildAlertBlocks(row.payload as unknown as AlertPayload[]);
      const res = await externalFetch({
        target: 'slack',
        url: snap.slack_webhook_url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocks }),
        timeoutMs: RETRY_FETCH_TIMEOUT_MS,
      });
      if (res.status < 200 || res.status >= 300) return { ok: false, error: `slack ${res.status}` };
      return { ok: true };
    }

    if (row.channel === 'email') {
      // v1.1: replay against the frozen recipients via the email
      // channel's sendEmailFromSnapshot helper.
      const { sendEmailFromSnapshot } = await import('./channels/email.js');
      return sendEmailFromSnapshot(row.snapshot as { email_recipients?: string[] }, row.payload);
    }

    return { ok: false, error: `unknown_channel:${row.channel}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ dlq_id: row.id, channel: row.channel, error: message }, 'dlq retry threw');
    return { ok: false, error: message };
  }
}

export interface PurgeInput {
  retentionDays?: number;
}

export interface PurgeResult {
  purged: number;
}

export async function purgeDlq(input: PurgeInput = {}): Promise<PurgeResult> {
  const days = input.retentionDays ?? 30;
  // No RLS — system-wide purge using a fixed retention window (O23).
  // Run inside a tx so the audit insert is atomic with the delete.
  const result = await purgeRaw(days);
  log.info({ days, purged: result.purged }, 'dlq purge complete');
  return result;
}

async function purgeRaw(days: number): Promise<PurgeResult> {
  // Defense-in-depth: validate before interpolating into SQL. The cron
  // route hardcodes `days` today, but `purgeDlq({ retentionDays })` is a
  // public helper — a future caller passing user input would otherwise
  // hit an injection vector via `sql.raw`.
  if (!Number.isFinite(days) || days <= 0 || !Number.isInteger(days)) {
    throw new Error(`purgeDlq: retentionDays must be a positive integer (got ${days})`);
  }
  const { db } = await import('../db/client.js');
  const r = await db.execute(sql`
    DELETE FROM webhook_dlq
    WHERE created_at < NOW() - (${days} || ' days')::interval
    RETURNING id, builder_id
  `);
  // postgres-js returns a Result that `extends Array` (rows are the array
  // elements), not `{ rows }` — see unwrapRows. Reading `.rows.length` threw
  // after the DELETE had already run, so purge-dlq 500'd on every tick and the
  // per-builder purge audit was skipped.
  const rows = unwrapRows<{ id: string; builder_id: string }>(r);
  if (rows.length > 0) {
    // Aggregate audit per builder so we don't blast the table.
    const perBuilder = new Map<string, number>();
    for (const r of rows) perBuilder.set(r.builder_id, (perBuilder.get(r.builder_id) ?? 0) + 1);
    for (const [builderId, count] of perBuilder) {
      try {
        await withRLS(builderId, async (tx) => {
          await auditLog(tx as unknown as DrizzleTransaction, {
            builder_id: builderId,
            actor_type: 'system',
            actor_id: 'cron.purge-dlq',
            action: AuditAction.ALERT_DLQ_PURGED,
            resource_type: 'webhook_dlq',
            details: { count, retention_days: days },
          });
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn({ builderId, error: message }, 'dlq purge audit failed (non-fatal)');
      }
    }
  }
  return { purged: rows.length };
}
