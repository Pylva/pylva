// Backup-model price-change watcher (D31). Runs as a tail step of the
// daily pricing-sync cron: scans every active reliability_failover rule
// with a captured consent snapshot, compares against the current
// llm_pricing row, and dispatches `BACKUP_MODEL_PRICE_CHANGED` when the
// (input + output) sum has drifted >10% since consent.
//
// Best-effort: a failure on one rule must not block the rest, mirroring
// the per-builder error isolation pattern from health/runner.ts.

import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  RuleStatus,
  RuleType,
  WebhookEventType,
  type BackupModelPriceChangedPayload,
  type ReliabilityFailoverConfig,
} from '@pylva/shared';
import { db } from '../db/client.js';
import { logger } from '../logger.js';
import { deliverBuilderAlert } from '../alerts/builder-alert.js';
import { fetchActiveBackupPrice } from './backup-price-snapshot.js';

const log = logger.child({ module: 'rules.backup-price-watcher' });

const PRICE_CHANGE_THRESHOLD_PCT = 10;

export interface WatcherResult {
  scanned_rules: number;
  alerts_dispatched: number;
  skipped_no_snapshot: number;
  skipped_no_pricing: number;
  errors: number;
}

interface CandidateRow extends Record<string, unknown> {
  id: string;
  builder_id: string;
  config: Record<string, unknown>;
}

export async function runBackupPriceWatcher(now: Date = new Date()): Promise<WatcherResult> {
  const result: WatcherResult = {
    scanned_rules: 0,
    alerts_dispatched: 0,
    skipped_no_snapshot: 0,
    skipped_no_pricing: 0,
    errors: 0,
  };

  // Reads outside withRLS — this is a server-side sweep across all
  // builders. Filters for active+enabled to skip drafts; the watcher
  // shouldn't nudge builders about rules they haven't committed to.
  const candidates = await db.execute<CandidateRow>(sql`
    SELECT id, builder_id, config
    FROM rules
    WHERE type = ${RuleType.RELIABILITY_FAILOVER}
      AND status = ${RuleStatus.ACTIVE}
      AND enabled = true
  `);

  result.scanned_rules = candidates.length;

  for (const row of candidates) {
    try {
      const cfg = row.config as unknown as ReliabilityFailoverConfig;
      const decision = evaluateRule(cfg);
      if (decision === 'no_snapshot') {
        result.skipped_no_snapshot += 1;
        continue;
      }

      const current = await fetchActiveBackupPrice(cfg.backup_provider, cfg.backup_model!, now);
      if (!current) {
        result.skipped_no_pricing += 1;
        continue;
      }

      const delta = computeDeltaPct(cfg, current.input_per_1m_usd, current.output_per_1m_usd);
      if (Math.abs(delta) < PRICE_CHANGE_THRESHOLD_PCT) continue;

      const payload = buildPayload(row.builder_id, row.id, cfg, current, delta);
      await deliverBuilderAlert({ builderId: row.builder_id, payload });
      result.alerts_dispatched += 1;
      log.info(
        {
          builder_id: row.builder_id,
          rule_id: row.id,
          backup_provider: cfg.backup_provider,
          backup_model: cfg.backup_model,
          delta_pct: delta,
          consent_observed_at: cfg.consent_observed_at,
        },
        'backup-price drift alert dispatched',
      );
    } catch (err) {
      result.errors += 1;
      log.warn(
        {
          builder_id: row.builder_id,
          rule_id: row.id,
          error: err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err),
        },
        'backup-price watcher failed for rule',
      );
    }
  }

  log.info(result, 'backup-price watcher cycle complete');
  return result;
}

type Decision = 'no_snapshot' | 'check';

export function evaluateRule(cfg: ReliabilityFailoverConfig): Decision {
  if (
    !cfg.backup_model ||
    cfg.consent_backup_input_per_1m_usd == null ||
    cfg.consent_backup_output_per_1m_usd == null
  ) {
    return 'no_snapshot';
  }
  return 'check';
}

export function computeDeltaPct(
  cfg: ReliabilityFailoverConfig,
  currentInput: number,
  currentOutput: number,
): number {
  const consentSum =
    (cfg.consent_backup_input_per_1m_usd ?? 0) + (cfg.consent_backup_output_per_1m_usd ?? 0);
  if (consentSum === 0) return 0;
  const currentSum = currentInput + currentOutput;
  return Math.round(((currentSum - consentSum) / consentSum) * 10_000) / 100;
}

function buildPayload(
  builderId: string,
  ruleId: string,
  cfg: ReliabilityFailoverConfig,
  current: { input_per_1m_usd: number; output_per_1m_usd: number },
  deltaPct: number,
): BackupModelPriceChangedPayload {
  return {
    id: crypto.randomUUID(),
    type: WebhookEventType.BACKUP_MODEL_PRICE_CHANGED,
    builder_id: builderId,
    timestamp: new Date().toISOString(),
    data: {
      rule_id: ruleId,
      customer_id: cfg.customer_id,
      backup_provider: cfg.backup_provider,
      backup_model: cfg.backup_model!,
      consent_observed_at: cfg.consent_observed_at!,
      consent_input_per_1m_usd: cfg.consent_backup_input_per_1m_usd!,
      consent_output_per_1m_usd: cfg.consent_backup_output_per_1m_usd!,
      current_input_per_1m_usd: current.input_per_1m_usd,
      current_output_per_1m_usd: current.output_per_1m_usd,
      delta_pct: deltaPct,
    },
  };
}
