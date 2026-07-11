// LiteLLM pricing sync (B1 — D29, D30).
//
// Fetches BerriAI/litellm model_prices_and_context_window.json, field-validates
// each entry, upserts into llm_pricing. On >50% invalid entries or fetch/parse
// failure, aborts without touching llm_pricing + Slack-alerts + records a
// `status='aborted'` row in pricing_sync_log. After 3 consecutive failures the
// caller can run syncFromSnapshot() to populate from the committed snapshot.

import { sql as drizzleSql } from 'drizzle-orm';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db/client.js';
import { unwrapRows } from '../db/query-utils.js';
import { postSlackAlert } from '../alerts/slack.js';
import { externalFetch } from '../external-egress.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'pricing.litellm-sync' });

const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = path.resolve(__dirname, '../../../packages/shared/pricing-snapshot.json');

export interface SyncResult {
  status: 'success' | 'aborted' | 'partial';
  synced: number;
  skipped: number;
  failure_reason?: string;
  attempt_number: number;
  source: 'litellm' | 'snapshot';
}

interface LiteLlmEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  max_tokens?: number;
  litellm_provider?: string;
  mode?: string;
}

interface ValidatedEntry {
  provider: string;
  model: string;
  input_per_1m: number;
  output_per_1m: number;
}

function validateEntry(model: string, entry: unknown): ValidatedEntry | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const e = entry as LiteLlmEntry;
  // "sample_spec" is LiteLLM's metadata stub, not a real model
  if (model === 'sample_spec') return null;
  if (typeof e.input_cost_per_token !== 'number' || e.input_cost_per_token < 0) return null;
  if (typeof e.output_cost_per_token !== 'number' || e.output_cost_per_token < 0) return null;
  if (typeof e.litellm_provider !== 'string' || e.litellm_provider.length === 0) return null;
  const mode = e.mode;
  if (mode !== 'chat' && mode !== 'completion' && mode !== 'embedding') return null;
  return {
    provider: e.litellm_provider,
    model,
    input_per_1m: e.input_cost_per_token * 1_000_000,
    output_per_1m: e.output_cost_per_token * 1_000_000,
  };
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await externalFetch({
    target: 'litellm',
    url,
    headers: { accept: 'application/json' },
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
  return JSON.parse(res.body);
}

async function currentAttemptNumber(): Promise<number> {
  const result = await db.execute<{ status: string }>(drizzleSql`
    SELECT status FROM pricing_sync_log ORDER BY run_at DESC LIMIT 5
  `);
  let streak = 0;
  for (const r of unwrapRows<{ status: string }>(result)) {
    if (r.status === 'aborted') streak += 1;
    else break;
  }
  return streak + 1;
}

async function applyEntries(entries: ValidatedEntry[]): Promise<void> {
  const effectiveFrom = new Date().toISOString();
  await db.transaction(async (tx) => {
    for (const entry of entries) {
      // Close any currently-open row for this (provider, model)
      await tx.execute(drizzleSql`
        UPDATE llm_pricing
        SET effective_to = ${effectiveFrom}::timestamptz
        WHERE provider = ${entry.provider}
          AND model = ${entry.model}
          AND effective_to IS NULL
          AND (
            input_per_1m != ${entry.input_per_1m}::numeric
            OR output_per_1m != ${entry.output_per_1m}::numeric
          )
      `);
      // Insert new row if no currently-open matching row exists.
      await tx.execute(drizzleSql`
        INSERT INTO llm_pricing (provider, model, input_per_1m, output_per_1m, effective_from, source)
        SELECT ${entry.provider}, ${entry.model}, ${entry.input_per_1m}, ${entry.output_per_1m},
               ${effectiveFrom}::timestamptz, 'auto'
        WHERE NOT EXISTS (
          SELECT 1 FROM llm_pricing
          WHERE provider = ${entry.provider}
            AND model = ${entry.model}
            AND effective_to IS NULL
        )
      `);
    }
  });
}

async function recordLog(
  status: SyncResult['status'],
  synced: number,
  skipped: number,
  attempt: number,
  source: 'litellm' | 'snapshot',
  failureReason?: string,
): Promise<void> {
  await db.execute(drizzleSql`
    INSERT INTO pricing_sync_log (status, models_synced, models_skipped, attempt_number, source, failure_reason)
    VALUES (${status}, ${synced}, ${skipped}, ${attempt}, ${source}, ${failureReason ?? null})
  `);
}

/** Run a LiteLLM sync. Call from the /api/cron/pricing-sync route. */
export async function runLitellmSync(): Promise<SyncResult> {
  const attempt = await currentAttemptNumber();

  let raw: unknown;
  try {
    raw = await fetchJson(LITELLM_URL);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error({ attempt, error: reason }, 'litellm fetch failed');
    await recordLog('aborted', 0, 0, attempt, 'litellm', `fetch_failed: ${reason}`);
    await postSlackAlert(`Pylva: LiteLLM sync attempt ${attempt} failed (fetch): ${reason}`);
    return {
      status: 'aborted',
      synced: 0,
      skipped: 0,
      failure_reason: reason,
      attempt_number: attempt,
      source: 'litellm',
    };
  }

  if (typeof raw !== 'object' || raw === null) {
    await recordLog('aborted', 0, 0, attempt, 'litellm', 'not_an_object');
    await postSlackAlert(
      `Pylva: LiteLLM sync attempt ${attempt} — payload is not a JSON object`,
    );
    return {
      status: 'aborted',
      synced: 0,
      skipped: 0,
      failure_reason: 'not_an_object',
      attempt_number: attempt,
      source: 'litellm',
    };
  }

  const valid: ValidatedEntry[] = [];
  let skipped = 0;
  for (const [model, entry] of Object.entries(raw as Record<string, unknown>)) {
    const v = validateEntry(model, entry);
    if (v) valid.push(v);
    else skipped += 1;
  }

  const total = valid.length + skipped;
  if (total > 0 && skipped / total > 0.5) {
    const reason = `too_many_invalid: ${skipped}/${total} entries failed validation`;
    await recordLog('aborted', 0, skipped, attempt, 'litellm', reason);
    await postSlackAlert(`Pylva: LiteLLM sync attempt ${attempt} aborted — ${reason}`);
    return {
      status: 'aborted',
      synced: 0,
      skipped,
      failure_reason: reason,
      attempt_number: attempt,
      source: 'litellm',
    };
  }

  try {
    await applyEntries(valid);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error({ attempt, error: reason }, 'litellm apply failed');
    await recordLog('aborted', 0, skipped, attempt, 'litellm', `apply_failed: ${reason}`);
    await postSlackAlert(`Pylva: LiteLLM sync attempt ${attempt} failed (apply): ${reason}`);
    return {
      status: 'aborted',
      synced: 0,
      skipped,
      failure_reason: reason,
      attempt_number: attempt,
      source: 'litellm',
    };
  }

  const finalStatus: SyncResult['status'] = skipped > 0 ? 'partial' : 'success';
  await recordLog(finalStatus, valid.length, skipped, attempt, 'litellm');
  log.info({ synced: valid.length, skipped, attempt }, 'litellm sync complete');
  return {
    status: finalStatus,
    synced: valid.length,
    skipped,
    attempt_number: attempt,
    source: 'litellm',
  };
}

/** Snapshot fallback — reads packages/shared/pricing-snapshot.json and applies it. */
export async function syncFromSnapshot(): Promise<SyncResult> {
  const attempt = await currentAttemptNumber();
  try {
    const text = await fs.readFile(SNAPSHOT_PATH, 'utf-8');
    const raw = JSON.parse(text) as Array<{
      provider: string;
      model: string;
      input_per_1m: number;
      output_per_1m: number;
    }>;
    if (!Array.isArray(raw)) throw new Error('snapshot is not an array');

    const valid: ValidatedEntry[] = raw
      .filter((r) => r && typeof r.provider === 'string' && typeof r.model === 'string')
      .map((r) => ({
        provider: r.provider,
        model: r.model,
        input_per_1m: Number(r.input_per_1m),
        output_per_1m: Number(r.output_per_1m),
      }))
      .filter((r) => r.input_per_1m >= 0 && r.output_per_1m >= 0);

    // An empty (or fully-invalid) snapshot must NOT count as a successful
    // sync: applyEntries([]) would touch nothing, yet the 'success' row in
    // pricing_sync_log resets the consecutive-failure streak that drives
    // the escalation alert — silently masking a LiteLLM outage while
    // llm_pricing drifts ever further from live rates.
    if (valid.length === 0) {
      const reason = `snapshot_empty: 0 valid entries in ${SNAPSHOT_PATH}`;
      log.error({ snapshot_path: SNAPSHOT_PATH }, 'snapshot fallback aborted — empty snapshot');
      await recordLog('aborted', 0, raw.length, attempt, 'snapshot', reason);
      await postSlackAlert(`Pylva: pricing snapshot fallback aborted — ${reason}`);
      return {
        status: 'aborted',
        synced: 0,
        skipped: raw.length,
        failure_reason: reason,
        attempt_number: attempt,
        source: 'snapshot',
      };
    }

    await applyEntries(valid);
    await recordLog('success', valid.length, 0, attempt, 'snapshot');
    log.info({ synced: valid.length }, 'snapshot sync complete');
    return {
      status: 'success',
      synced: valid.length,
      skipped: 0,
      attempt_number: attempt,
      source: 'snapshot',
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error({ error: reason }, 'snapshot sync failed');
    await recordLog('aborted', 0, 0, attempt, 'snapshot', reason);
    await postSlackAlert(`Pylva: pricing snapshot fallback aborted — ${reason}`);
    return {
      status: 'aborted',
      synced: 0,
      skipped: 0,
      failure_reason: reason,
      attempt_number: attempt,
      source: 'snapshot',
    };
  }
}
