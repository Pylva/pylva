// SPDX-License-Identifier: Elastic-2.0
// B2b T2-E — shared impl for the monthly-drafts cron + ad-hoc CLI runs.
//
// Enqueues the newly closed month for every monthly (builder, customer) pair,
// then calls `generateInvoice` for every pending period. A period leaves the
// queue only after generation succeeds. Authoritative usage projection can
// therefore remain unavailable for any length of time without losing the
// invoice when a retry window or a later month boundary passes. The generator's
// deterministic draft keys make retries and concurrent cron runs safe.
//
// Billing period math: D6 says monthly only for B2b; weekly/custom
// supported on the column but not exercised. We compute the previous
// period as [firstOfPriorMonth, firstOfThisMonth). The cron fires daily: every
// run idempotently records that period and drains all outstanding periods.

import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { generateInvoice, BillingError } from '@/lib/billing/invoice-generator';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'scripts.generate-monthly-drafts' });

interface PendingMonthlyPeriod extends Record<string, unknown> {
  builder_id: string;
  customer_id: string;
  period_start: Date;
  period_end: Date;
}

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

async function enqueueClosedPeriod(periodStart: Date, periodEnd: Date): Promise<void> {
  await db.execute(sql`
    INSERT INTO monthly_invoice_periods (
      builder_id,
      customer_id,
      period_start,
      period_end
    )
    SELECT
      DISTINCT period_pricing.builder_id,
      period_pricing.customer_id,
      ${periodStart},
      ${periodEnd}
    FROM customer_pricing AS period_pricing
    -- The cadence at the closing boundary owns the completed period. A row
    -- that was monthly only earlier in the month must not make this cron bill
    -- a later weekly/custom slice. Include a row ending exactly at the
    -- boundary because it covered the final instant of the half-open period.
    WHERE period_pricing.billing_period = 'monthly'
      AND period_pricing.effective_from < ${periodEnd}
      AND (
        period_pricing.effective_to IS NULL
        OR period_pricing.effective_to >= ${periodEnd}
      )
    ON CONFLICT (builder_id, customer_id, period_start) DO NOTHING
  `);
}

async function listPendingPeriods(): Promise<PendingMonthlyPeriod[]> {
  const rows = await db.execute<PendingMonthlyPeriod>(sql`
    SELECT builder_id, customer_id, period_start, period_end
    FROM monthly_invoice_periods
    WHERE status = 'pending'
    ORDER BY period_start ASC, builder_id ASC, customer_id ASC
  `);
  return rows as PendingMonthlyPeriod[];
}

async function completePeriod(period: PendingMonthlyPeriod): Promise<void> {
  await db.execute(sql`
    UPDATE monthly_invoice_periods
    SET status = 'completed',
        completed_at = NOW(),
        last_error = NULL
    WHERE builder_id = ${period.builder_id}::uuid
      AND customer_id = ${period.customer_id}::uuid
      AND period_start = ${period.period_start}
      AND status = 'pending'
  `);
}

async function recordFailedAttempt(period: PendingMonthlyPeriod, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db.execute(sql`
    UPDATE monthly_invoice_periods
    SET attempts = attempts + 1,
        last_attempt_at = NOW(),
        last_error = ${message}
    WHERE builder_id = ${period.builder_id}::uuid
      AND customer_id = ${period.customer_id}::uuid
      AND period_start = ${period.period_start}
      AND status = 'pending'
  `);
}

export async function generateMonthlyDrafts(opts: {
  now: Date;
}): Promise<GenerateMonthlyDraftsResult> {
  const now = opts.now;
  const thisMonthStart = firstOfMonth(now);
  const priorMonthStart = firstOfPriorMonth(now);

  await enqueueClosedPeriod(priorMonthStart, thisMonthStart);
  const periods = await listPendingPeriods();

  const result: GenerateMonthlyDraftsResult = {
    scanned_builders: new Set(periods.map((period) => period.builder_id)).size,
    generated: 0,
    skipped_pricing_not_configured: 0,
    skipped_capabilities_pending: 0,
    skipped_other: 0,
    window_start: priorMonthStart.toISOString(),
    window_end: thisMonthStart.toISOString(),
  };

  for (const period of periods) {
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
      const periodStart = new Date(period.period_start);
      const periodEnd = new Date(period.period_end);
      const draftKeyBase = `monthly:${periodStart.toISOString().slice(0, 10)}:${period.customer_id}`;
      const drafts = await generateInvoice({
        builderId: period.builder_id,
        customerId: period.customer_id,
        period: { start: periodStart, end: periodEnd },
        draftKeyBase,
      });
      result.generated += drafts.length;
      await completePeriod(period);
    } catch (err) {
      await recordFailedAttempt(period, err);
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
        {
          builder_id: period.builder_id,
          customer_id: period.customer_id,
          period_start: new Date(period.period_start).toISOString(),
          error: message,
        },
        'draft generation skipped',
      );
    }
  }

  return result;
}
