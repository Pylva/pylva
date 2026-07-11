// Backup-model price snapshot helpers (D31). Used by the failover-rule
// activate route to stamp `consent_*` fields onto the rule config, and
// by `backup-price-watcher.ts` (pricing-sync hook) to compare snapshots
// against current llm_pricing rows.
//
// Reads the active `llm_pricing` row at `now` for (backup_provider,
// backup_model). When no row exists, returns null — the caller skips
// snapshotting (older rules without `backup_model` also skip).

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { ReliabilityFailoverConfig } from '@pylva/shared';

export interface ActivePrice {
  input_per_1m_usd: number;
  output_per_1m_usd: number;
  observed_at: string; // ISO 8601
}

interface PriceRow extends Record<string, unknown> {
  input_per_1m: string;
  output_per_1m: string;
}

export async function fetchActiveBackupPrice(
  provider: string,
  model: string,
  now: Date = new Date(),
): Promise<ActivePrice | null> {
  // ISO string, not Date: raw db.execute (postgres.js unsafe()) rejects
  // Date params — this crashed failover activation's price snapshot.
  const nowIso = now.toISOString();
  const rows = await db.execute<PriceRow>(sql`
    SELECT input_per_1m, output_per_1m
    FROM llm_pricing
    WHERE provider = ${provider}
      AND model = ${model}
      AND effective_from <= ${nowIso}
      AND (effective_to IS NULL OR effective_to > ${nowIso})
    ORDER BY effective_from DESC
    LIMIT 1
  `);
  const row = rows[0];
  if (!row) return null;
  return {
    input_per_1m_usd: Number(row.input_per_1m),
    output_per_1m_usd: Number(row.output_per_1m),
    observed_at: now.toISOString(),
  };
}

/**
 * Returns the patched ReliabilityFailoverConfig with the consent_*
 * fields stamped, or `null` when no snapshot is possible (no
 * `backup_model` configured, or no active llm_pricing row). The caller
 * decides whether to log+skip or surface to the UI.
 */
export async function snapshotBackupPrice(
  cfg: ReliabilityFailoverConfig,
  now: Date = new Date(),
): Promise<ReliabilityFailoverConfig | null> {
  if (!cfg.backup_model) return null;
  const price = await fetchActiveBackupPrice(cfg.backup_provider, cfg.backup_model, now);
  if (!price) return null;
  return {
    ...cfg,
    consent_backup_input_per_1m_usd: price.input_per_1m_usd,
    consent_backup_output_per_1m_usd: price.output_per_1m_usd,
    consent_observed_at: price.observed_at,
  };
}
