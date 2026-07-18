// SPDX-License-Identifier: Elastic-2.0
// B2b T2-E — shared impl for the monthly-drafts cron + ad-hoc CLI runs.
//
// Finds every (builder, customer) whose billing_period cycle just rolled
// over and calls `generateInvoice` for each. The same closed month is retried
// daily for one week: authoritative usage projection can still be reconciling
// at the first run, and the generator's deterministic draft keys make later
// attempts safe. Auto-split + capabilities gate + pricing-not-configured are
// handled by the generator; this loop only counts successes vs skips.
//
// Billing period math: D6 says monthly only for B2b; weekly/custom
// supported on the column but not exercised. We compute the previous
// period as [firstOfPriorMonth, firstOfThisMonth) when now is within the
// first 24h of the month. The cron fires daily but only does work on
// month-boundary days.

import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { generateInvoice, BillingError } from '@/lib/billing/invoice-generator';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'scripts.generate-monthly-drafts' });
const MONTHLY_DRAFT_RETRY_WINDOW_HOURS = 7 * 24;

export interface GenerateMonthlyDraftsResult {
  scanned_builders: number;
  generated: number;
  skipped_pricing_not_configured: number;
  skipped_capabilities_pending: number;
  skipped_other: number;
  window_start: string;
  window_end: string;
}

function firstOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

function firstOfPriorMonth(d: Date): Date {
  const month = d.getUTCMonth();
  const year = d.getUTCFullYear();
  return new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
}

/**
 * Find every (builder, customer) pair with an open pricing row + monthly
 * billing_period. We iterate the active-version rows directly (partial
 * unique index on effective_to IS NULL makes this fast) — no need to join
 * invoices to detect "no draft yet" because the idempotency rails in
 * generateInvoice absorb duplicates if we happen to call twice.
 */
async function listActivePairs(): Promise<Array<{ builder_id: string; customer_id: string }>> {
  const rows = await db.execute<{ builder_id: string; customer_id: string }>(
    sql`SELECT builder_id, customer_id
        FROM customer_pricing
        WHERE effective_to IS NULL
          AND billing_period = 'monthly'`,
  );
  return rows as Array<{ builder_id: string; customer_id: string }>;
}

export async function generateMonthlyDrafts(opts: {
  now: Date;
}): Promise<GenerateMonthlyDraftsResult> {
  const now = opts.now;
  const thisMonthStart = firstOfMonth(now);
  const priorMonthStart = firstOfPriorMonth(now);

  // Retry throughout the first week. A single 24h window gives the daily
  // schedule only one attempt; if authoritative projection is pending at that
  // run, the whole month is otherwise skipped permanently. Deterministic
  // draft keys absorb successful re-runs without creating another invoice.
  const hoursSinceBoundary = (now.getTime() - thisMonthStart.getTime()) / 3_600_000;
  if (hoursSinceBoundary < 0 || hoursSinceBoundary >= MONTHLY_DRAFT_RETRY_WINDOW_HOURS) {
    return {
      scanned_builders: 0,
      generated: 0,
      skipped_pricing_not_configured: 0,
      skipped_capabilities_pending: 0,
      skipped_other: 0,
      window_start: priorMonthStart.toISOString(),
      window_end: thisMonthStart.toISOString(),
    };
  }

  const pairs = await listActivePairs();

  const result: GenerateMonthlyDraftsResult = {
    scanned_builders: new Set(pairs.map((p) => p.builder_id)).size,
    generated: 0,
    skipped_pricing_not_configured: 0,
    skipped_capabilities_pending: 0,
    skipped_other: 0,
    window_start: priorMonthStart.toISOString(),
    window_end: thisMonthStart.toISOString(),
  };

  for (const pair of pairs) {
    try {
      // Track 1 PR 1.5 (O28): deterministic per-(builder, customer,
      // period) base. The generator suffixes with :v{version}:s{slice}
      // so split-window invoices get distinct keys. Re-running the
      // monthly cron the same day is a no-op via the partial unique
      // index uq_invoices_builder_draft_key.
      //
      // For the monthly cron, period_end is implicit in period_start
      // (priorMonthStart deterministically yields thisMonthStart), so
      // the 4-segment shape is sufficient and stable. PR #84's review
      // surfaced that PR #74 already wrote rows with this exact shape
      // on 2026-04-29 — changing the shape now would break dedupe with
      // those in-flight rows and cause duplicate Stripe invoices on
      // the next cron run inside the 24h boundary window (bug_005).
      // Future non-monthly callers passing draftKeyBase MUST encode
      // period_end themselves (e.g. `oneoff:{start}:{end}:{customer}`).
      const draftKeyBase = `monthly:${priorMonthStart.toISOString().slice(0, 10)}:${pair.customer_id}`;
      const drafts = await generateInvoice({
        builderId: pair.builder_id,
        customerId: pair.customer_id,
        period: { start: priorMonthStart, end: thisMonthStart },
        draftKeyBase,
      });
      result.generated += drafts.length;
    } catch (err) {
      if (err instanceof BillingError) {
        if (err.code === 'pricing_not_configured') result.skipped_pricing_not_configured += 1;
        else if (err.code === 'stripe_capabilities_pending')
          result.skipped_capabilities_pending += 1;
        else result.skipped_other += 1;
        continue;
      }
      result.skipped_other += 1;
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        { builder_id: pair.builder_id, customer_id: pair.customer_id, error: message },
        'draft generation skipped',
      );
    }
  }

  return result;
}
