// SPDX-License-Identifier: Elastic-2.0
// B2b T2-C — invoice generator. Orchestrates the full draft-invoice pipeline:
//
//   load stripe_connect → check capabilities (I-T2-14) → load versions in
//   period → detectBoundary → for each slice: usage → applyFormula →
//   ensureStripeCustomer → stripe.invoices.create(send_invoice, connected account) →
//   INSERT invoices (status=draft) → audit.
//
// When slices.length > 1 all drafts share a single `billing_cycle_id` UUID
// (I-T2-10 auto-split). Each slice's period_start/period_end is the slice's
// clamped range, not the full period.
//
// Invariants covered: I-T2-2 (formula via applyFormula), I-T2-3 (stripeFor
// with accountId attaches header), I-T2-5 (has_unpriced_events surfaced),
// I-T2-7 (audit entry per invoice), I-T2-8 (pinned API version — stripeFor),
// I-T2-9 (ensureStripeCustomer), I-T2-10 (auto-split), I-T2-14 (capabilities
// gate before any Stripe call).

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { InvoiceGenerateResponse, InvoiceLineItem } from '@pylva/shared';
import { withRLS } from '../db/rls.js';
import { invoices, stripeConnect } from '../db/schema.js';
import { auditLog } from '../auth/audit-log.js';
import { AuditAction } from '../audit/actions.js';
import { resolveCustomerComposite } from '../clickhouse/customer-id.js';
import { stripeFor } from '../stripe/client.js';
import { ensureStripeCustomer } from '../stripe/ensure-customer.js';
import { applyFormula } from './formulas.js';
import { billingCycleIdFor, detectBoundary, type SplitSlice } from './auto-split.js';
import { getUsageForPeriod } from './clickhouse-usage.js';
import { getVersionsInPeriod, rowToCustomerPricing } from './pricing-versioning.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'billing.invoice-generator' });
const STRIPE_READABLE_LINE_LIMIT = 50;
const STRIPE_INVOICE_DAYS_UNTIL_DUE = 30;

interface StripeInvoiceLine {
  description: string;
  amountCents: number;
}

export class BillingError extends Error {
  constructor(
    public code: 'pricing_not_configured' | 'stripe_not_connected' | 'stripe_capabilities_pending',
    message: string,
  ) {
    super(message);
  }
}

interface StripeConnectSnapshot {
  stripe_account_id: string;
  status: string;
  capabilities_ok: boolean;
}

function usdToCents(amountUsd: number): number {
  return Math.round(amountUsd * 100);
}

function normalizeStripeInvoiceLines(
  lineItems: InvoiceLineItem[],
  expectedAmountUsd: number,
): StripeInvoiceLine[] {
  const toStripeLine = (line: InvoiceLineItem): StripeInvoiceLine => ({
    description: line.description,
    amountCents: usdToCents(line.total_usd),
  });

  let stripeLines: StripeInvoiceLine[];
  if (lineItems.length <= STRIPE_READABLE_LINE_LIMIT) {
    stripeLines = lineItems.map(toStripeLine);
  } else {
    const markupLines = lineItems.filter((line) => line.metric === 'markup');
    const usageLines = lineItems
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.metric !== 'markup')
      .sort((a, b) => {
        const byAmount = usdToCents(b.line.total_usd) - usdToCents(a.line.total_usd);
        return byAmount === 0 ? a.index - b.index : byAmount;
      });
    const topUsageCount = Math.max(0, STRIPE_READABLE_LINE_LIMIT - markupLines.length - 1);
    const topUsageLines = usageLines.slice(0, topUsageCount).map(({ line }) => line);
    const omittedUsageLines = usageLines.slice(topUsageCount).map(({ line }) => line);
    const otherUsageCents = omittedUsageLines.reduce(
      (sum, line) => sum + usdToCents(line.total_usd),
      0,
    );

    stripeLines = topUsageLines.map(toStripeLine);
    if (omittedUsageLines.length > 0) {
      stripeLines.push({
        description: `Other usage (${omittedUsageLines.length} metrics)`,
        amountCents: otherUsageCents,
      });
    }
    stripeLines.push(...markupLines.map(toStripeLine));
  }

  const actualCents = stripeLines.reduce((sum, line) => sum + line.amountCents, 0);
  const expectedCents = usdToCents(expectedAmountUsd);
  if (actualCents !== expectedCents) {
    throw new Error(
      `Stripe invoice item cents (${actualCents}) do not match invoice amount (${expectedCents})`,
    );
  }
  if (stripeLines.length > 250) {
    throw new Error(
      `Stripe invoice item count ${stripeLines.length} exceeds Stripe's 250 item cap`,
    );
  }
  return stripeLines;
}

async function deleteStripeDraftInvoice(
  stripe: ReturnType<typeof stripeFor>,
  stripeInvoiceId: string,
  context: Record<string, unknown>,
): Promise<string | null> {
  try {
    await stripe.invoices.del(stripeInvoiceId);
    log.warn(
      { ...context, stripe_invoice_id: stripeInvoiceId },
      'deleted Stripe draft invoice after local invoice generation did not complete',
    );
    return null;
  } catch (cleanupErr) {
    const cleanupMessage = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
    log.error(
      { ...context, stripe_invoice_id: stripeInvoiceId, cleanup_error: cleanupMessage },
      'failed to delete Stripe draft invoice after local invoice generation did not complete',
    );
    return `failed to delete Stripe draft invoice ${stripeInvoiceId}: ${cleanupMessage}`;
  }
}

async function loadStripeConnect(builderId: string): Promise<StripeConnectSnapshot | null> {
  const rows = await withRLS(builderId, async (tx) =>
    tx
      .select({
        stripe_account_id: stripeConnect.stripe_account_id,
        status: stripeConnect.status,
        capabilities_ok: stripeConnect.capabilities_ok,
      })
      .from(stripeConnect)
      .where(eq(stripeConnect.builder_id, builderId))
      .limit(1),
  );
  const r = rows[0];
  if (!r || !r.stripe_account_id) return null;
  return {
    stripe_account_id: r.stripe_account_id,
    status: r.status,
    capabilities_ok: r.capabilities_ok,
  };
}

interface GenerateInput {
  builderId: string;
  customerId: string;
  period: { start: Date; end: Date };
  actorUserId?: string;
  /**
   * Track 1 PR 1.5 (O28): deterministic per-(builder, customer, period,
   * pricing_version, slice_idx) key for monthly-cron dedupe. When set,
   * the insert uses ON CONFLICT DO NOTHING on the partial unique index
   * (builder_id, draft_key) WHERE draft_key IS NOT NULL — re-running
   * the cron the same day is a no-op.
   *
   * Single-customer invoice POSTs derive an attempt-scoped base from the
   * persisted idempotency claim. That lets an interrupted auto-split resume
   * without extending the public key's 24-hour idempotency window forever.
   */
  draftKeyBase?: string;
}

async function persistOneDraft(
  input: GenerateInput,
  slice: SplitSlice,
  stripeAccountId: string,
  billingCycleId: string | null,
  sliceIdx: number,
): Promise<InvoiceGenerateResponse> {
  const pricing = rowToCustomerPricing(slice.version);

  // Track 1 PR 1.5 (O28): if a draft_key is in play for this run, check
  // the partial unique index *before* any Stripe / DB write. Re-running
  // the monthly cron the same day must be a no-op.
  const draftKey = input.draftKeyBase
    ? `${input.draftKeyBase}:v${pricing.version}:s${sliceIdx}`
    : null;
  if (draftKey) {
    const existing = await withRLS(input.builderId, async (tx) =>
      tx
        .select({
          id: invoices.id,
          stripe_invoice_id: invoices.stripe_invoice_id,
          amount_usd: invoices.amount_usd,
          billing_cycle_id: invoices.billing_cycle_id,
          has_unpriced_events: invoices.has_unpriced_events,
        })
        .from(invoices)
        .where(and(eq(invoices.builder_id, input.builderId), eq(invoices.draft_key, draftKey)))
        .limit(1),
    );
    if (existing.length > 0) {
      const r = existing[0]!;
      // PR #74 follow-up — emit a dedupe-hit audit so ops can see how
      // often the deterministic key short-circuits a duplicate run.
      // Without this, the only signal a re-run happened is the absence
      // of a matching billing.invoice_generated audit row, which is
      // hard to alert on.
      if (input.actorUserId) {
        await withRLS(input.builderId, async (tx) => {
          await auditLog(tx, {
            builder_id: input.builderId,
            actor_type: 'user',
            actor_id: input.actorUserId!,
            action: AuditAction.BILLING_INVOICE_DEDUPE_HIT,
            resource_type: 'invoice',
            resource_id: r.id,
            details: {
              customer_id: input.customerId,
              draft_key: draftKey,
              pricing_version: pricing.version,
            },
          });
        });
      } else {
        log.info(
          { builder_id: input.builderId, customer_id: input.customerId, draft_key: draftKey },
          'invoice dedupe hit — existing draft returned',
        );
      }
      return {
        invoice_id: r.id,
        stripe_invoice_id: r.stripe_invoice_id ?? '',
        amount_usd: Number(r.amount_usd),
        has_unpriced_events: r.has_unpriced_events,
        ...(r.billing_cycle_id ? { billing_cycle_id: r.billing_cycle_id } : {}),
      };
    }
  }

  // PR #84 review (bug_024) — getUsageForPeriod queries ClickHouse
  // cost_events.customer_id which ingest writes as `${builder}:${external}`,
  // not the internal customers.id UUID. Resolve once here so usage SUMs
  // actually match the events. Without this, monthly-drafts silently
  // creates $0 Stripe invoices for every pay-as-you-go builder.
  const compositeCustomerId = await resolveCustomerComposite(input.builderId, input.customerId);
  if (!compositeCustomerId) {
    throw new BillingError(
      'pricing_not_configured',
      `customer ${input.customerId} not found or missing external_id`,
    );
  }
  const usage = await getUsageForPeriod({
    builderId: input.builderId,
    customerId: compositeCustomerId,
    from: slice.slice_start,
    to: slice.slice_end,
  });
  const formula = applyFormula(pricing, usage);
  const stripeLineItems = normalizeStripeInvoiceLines(formula.line_items, formula.amount_usd);

  const { stripe_customer_id } = await ensureStripeCustomer({
    builderId: input.builderId,
    customerId: input.customerId,
    stripeAccountId,
    metadata: { pylva_pricing_version: String(pricing.version) },
  });

  const stripe = stripeFor(stripeAccountId);
  const stripeInvoice = await stripe.invoices.create({
    customer: stripe_customer_id,
    collection_method: 'send_invoice',
    days_until_due: STRIPE_INVOICE_DAYS_UNTIL_DUE,
    auto_advance: false,
    metadata: {
      pylva_builder_id: input.builderId,
      pylva_customer_id: input.customerId,
      pylva_pricing_version: String(pricing.version),
      pylva_period_start: slice.slice_start.toISOString(),
      pylva_period_end: slice.slice_end.toISOString(),
      ...(billingCycleId ? { pylva_billing_cycle_id: billingCycleId } : {}),
    },
  });

  let cleanupAttempted = false;
  try {
    // Push each computed line item onto the Stripe invoice. Without this the
    // invoice we create above is an empty shell: `applyFormula`'s amount lives
    // only in our `invoices.amount_usd` column and is never sent to Stripe, so
    // `finalizeInvoice` (the /finalize route) would charge the end-customer $0.
    for (const li of stripeLineItems) {
      await stripe.invoiceItems.create({
        customer: stripe_customer_id,
        invoice: stripeInvoice.id,
        amount: li.amountCents,
        currency: 'usd',
        description: li.description,
      });
    }

    const inserted = await withRLS(input.builderId, async (tx) => {
      // PR #74 follow-up — close the TOCTOU race the SELECT-then-INSERT
      // pattern leaves open. Two cron pods that interleave between the
      // pre-flight SELECT and this INSERT both pass the existence check;
      // the second-arriving INSERT then violates the partial unique
      // (builder_id, draft_key) WHERE draft_key IS NOT NULL index. With
      // ON CONFLICT DO NOTHING the second INSERT is a no-op; we re-SELECT
      // the winning row so the caller still gets a valid response.
      //
      // Bare .onConflictDoNothing() — Drizzle's typed `target` form can't
      // restate a partial-index predicate (`WHERE draft_key IS NOT NULL`),
      // so passing `target: [...]` raises 42P10 ("no unique or exclusion
      // constraint matching the ON CONFLICT specification"). Same pattern
      // is documented in src/lib/anomaly/repository.ts:65 and used by
      // src/lib/billing/idempotency.ts:46.
      const rows = await tx
        .insert(invoices)
        .values({
          builder_id: input.builderId,
          customer_id: input.customerId,
          stripe_invoice_id: stripeInvoice.id,
          amount_usd: String(formula.amount_usd),
          period_start: slice.slice_start,
          period_end: slice.slice_end,
          status: 'draft',
          line_items: formula.line_items,
          billing_cycle_id: billingCycleId,
          pricing_version: pricing.version,
          has_unpriced_events: formula.has_unpriced_events,
          draft_key: draftKey,
        })
        .onConflictDoNothing()
        .returning({
          id: invoices.id,
          stripe_invoice_id: invoices.stripe_invoice_id,
          amount_usd: invoices.amount_usd,
          has_unpriced_events: invoices.has_unpriced_events,
          billing_cycle_id: invoices.billing_cycle_id,
        });

      const winner = rows[0];

      if (winner) {
        // Happy path — this pod inserted.
        const result: InvoiceGenerateResponse = {
          invoice_id: winner.id,
          stripe_invoice_id: winner.stripe_invoice_id ?? '',
          amount_usd: Number(winner.amount_usd),
          has_unpriced_events: winner.has_unpriced_events,
        };
        if (winner.billing_cycle_id) result.billing_cycle_id = winner.billing_cycle_id;

        if (input.actorUserId) {
          await auditLog(tx, {
            builder_id: input.builderId,
            actor_type: 'user',
            actor_id: input.actorUserId,
            action: AuditAction.BILLING_INVOICE_GENERATED,
            resource_type: 'invoice',
            resource_id: winner.id,
            details: {
              customer_id: input.customerId,
              stripe_invoice_id: stripeInvoice.id ?? null,
              pricing_version: pricing.version,
              amount_usd: formula.amount_usd,
              has_unpriced_events: formula.has_unpriced_events,
              ...(billingCycleId ? { billing_cycle_id: billingCycleId } : {}),
            },
          });
        }
        return { result, raceLost: false };
      }

      // Race lost — another pod won the INSERT. Re-SELECT the winner so
      // the caller gets the winner's response, then delete this pod's loser
      // Stripe draft after the DB transaction commits.
      if (!draftKey) {
        throw new Error('invoice insert returned no row and no draft_key for re-SELECT');
      }
      const existing = await tx
        .select({
          id: invoices.id,
          stripe_invoice_id: invoices.stripe_invoice_id,
          amount_usd: invoices.amount_usd,
          has_unpriced_events: invoices.has_unpriced_events,
          billing_cycle_id: invoices.billing_cycle_id,
        })
        .from(invoices)
        .where(and(eq(invoices.builder_id, input.builderId), eq(invoices.draft_key, draftKey)))
        .limit(1);
      const r = existing[0];
      if (!r) {
        throw new Error('invoice insert race lost but no existing row found for draft_key');
      }
      log.warn(
        {
          builder_id: input.builderId,
          customer_id: input.customerId,
          draft_key: draftKey,
          loser_stripe_invoice_id: stripeInvoice.id ?? null,
          winner_invoice_id: r.id,
        },
        'invoice draft_key race lost — deleting loser Stripe draft',
      );
      const result: InvoiceGenerateResponse = {
        invoice_id: r.id,
        stripe_invoice_id: r.stripe_invoice_id ?? '',
        amount_usd: Number(r.amount_usd),
        has_unpriced_events: r.has_unpriced_events,
      };
      if (r.billing_cycle_id) result.billing_cycle_id = r.billing_cycle_id;

      // Audit as DEDUPE_HIT (not GENERATED) — this pod did not generate
      // the invoice. Mirror the early-exit dedupe path's action choice.
      if (input.actorUserId) {
        await auditLog(tx, {
          builder_id: input.builderId,
          actor_type: 'user',
          actor_id: input.actorUserId,
          action: AuditAction.BILLING_INVOICE_DEDUPE_HIT,
          resource_type: 'invoice',
          resource_id: r.id,
          details: {
            customer_id: input.customerId,
            draft_key: draftKey,
            pricing_version: pricing.version,
            race_loss: true,
            loser_stripe_invoice_id: stripeInvoice.id ?? null,
          },
        });
      }
      return { result, raceLost: true };
    });

    if (inserted.raceLost) {
      cleanupAttempted = true;
      const cleanupFailure = await deleteStripeDraftInvoice(stripe, stripeInvoice.id, {
        builder_id: input.builderId,
        customer_id: input.customerId,
        draft_key: draftKey,
        reason: 'draft_key_conflict_loser',
      });
      if (cleanupFailure) throw new Error(cleanupFailure);
    }

    return inserted.result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!cleanupAttempted) {
      cleanupAttempted = true;
      const cleanupFailure = await deleteStripeDraftInvoice(stripe, stripeInvoice.id, {
        builder_id: input.builderId,
        customer_id: input.customerId,
        draft_key: draftKey,
        original_error: message,
      });
      if (cleanupFailure) {
        throw new Error(`${message}; additionally ${cleanupFailure}`);
      }
    }
    throw err;
  }
}

/**
 * Generate draft invoice(s) for the period. Returns one response per slice
 * (length === 1 normally; length > 1 when auto-split fires).
 */
export async function generateInvoice(input: GenerateInput): Promise<InvoiceGenerateResponse[]> {
  const connect = await loadStripeConnect(input.builderId);
  if (!connect)
    throw new BillingError('stripe_not_connected', 'Builder has no Stripe account connected');
  if (!connect.capabilities_ok) {
    throw new BillingError(
      'stripe_capabilities_pending',
      'Stripe capabilities not active — complete onboarding',
    );
  }

  const versions = await getVersionsInPeriod({
    builderId: input.builderId,
    customerId: input.customerId,
    start: input.period.start,
    end: input.period.end,
  });

  const plan = detectBoundary(versions, input.period);
  if (plan.slices.length === 0) {
    throw new BillingError(
      'pricing_not_configured',
      'No pricing version active in the requested period',
    );
  }

  // Auto-split cycle id. For deduplicated generation (draftKeyBase set)
  // derive it deterministically from the dedupe namespace so concurrent pods
  // and same-window re-runs assign the *same* billing_cycle_id to every slice
  // of the cycle — otherwise two invocations that each win the INSERT for a
  // different slice would fracture one cycle across two ids. One-off POSTs
  // (no draftKeyBase, no cross-invocation dedupe) keep a fresh random id.
  let billingCycleId: string | null = null;
  if (plan.split) {
    billingCycleId = input.draftKeyBase
      ? billingCycleIdFor(`${input.builderId}:${input.draftKeyBase}`)
      : randomUUID();
  }
  const results: InvoiceGenerateResponse[] = [];
  for (let i = 0; i < plan.slices.length; i++) {
    const slice = plan.slices[i]!;
    try {
      const result = await persistOneDraft(
        input,
        slice,
        connect.stripe_account_id,
        billingCycleId,
        i,
      );
      results.push(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { builder_id: input.builderId, customer_id: input.customerId, error: message },
        'invoice slice generation failed',
      );
      throw err;
    }
  }

  return results;
}
