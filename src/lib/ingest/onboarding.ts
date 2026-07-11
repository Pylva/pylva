// pricing_onboarding_tasks upserts for unpriced events (B1 — D35).
//
// When ingest sees an event we can't price, we open (or touch) an onboarding
// task so the builder sees a "N models need pricing input" banner in B2.
// Closed by the hourly backfill job once custom_pricing / llm_pricing lands.

import { sql as drizzleSql } from 'drizzle-orm';
import type { DrizzleTransaction } from '../db/rls.js';

export interface OnboardingKey {
  provider: string | null;
  model: string | null;
  metric: string | null;
}

/**
 * Insert an onboarding task row, keyed by (builder_id, provider, model) or
 * (builder_id, metric). No-op if the row already exists (ON CONFLICT).
 * Caller is expected to be inside withRLS(builderId).
 */
export async function ensureOnboardingTask(
  tx: DrizzleTransaction,
  builderId: string,
  key: OnboardingKey,
): Promise<void> {
  if (key.metric != null) {
    await tx.execute(drizzleSql`
      INSERT INTO pricing_onboarding_tasks (builder_id, metric, status)
      VALUES (${builderId}::uuid, ${key.metric}, 'open')
      ON CONFLICT DO NOTHING
    `);
    return;
  }
  if (key.provider != null && key.model != null) {
    await tx.execute(drizzleSql`
      INSERT INTO pricing_onboarding_tasks (builder_id, provider, model, status)
      VALUES (${builderId}::uuid, ${key.provider}, ${key.model}, 'open')
      ON CONFLICT DO NOTHING
    `);
  }
}
