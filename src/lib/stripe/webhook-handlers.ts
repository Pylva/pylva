// SPDX-License-Identifier: Elastic-2.0
// B2b T2-D — Stripe webhook event handlers. Each handler is keyed by
// event.type. They UPDATE the matching invoices row (if any), append an
// audit entry, and for payment_failed + dispute call deliverBuilderAlert.
//
// Exact event-id replay idempotency lives at the Connect route layer
// (stripe_connect_event_log). These handlers still guard status transitions
// so out-of-order first deliveries cannot regress an invoice.
//
// Orphan race (webhook arrives before invoices row exists): UPDATE matches
// 0 rows, we audit `alert_skipped_no_invoice` and return 200. Stripe won't
// retry 2xx. Documented as rare per plan §10 risk #5.

import type Stripe from 'stripe';
import { and, eq, notInArray } from 'drizzle-orm';
import type { BillingPaymentFailedPayload, BillingDisputeCreatedPayload } from '@pylva/shared';
import { WebhookEventType } from '@pylva/shared';
import { withRLS } from '../db/rls.js';
import { invoices } from '../db/schema.js';
import { auditLog } from '../auth/audit-log.js';
import { AuditAction } from '../audit/actions.js';
import { deliverBuilderAlert } from '../alerts/builder-alert.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'stripe.webhook-handlers' });

interface HandlerContext {
  builderId: string;
  eventId: string;
  eventCreated: number;
}

async function updateInvoiceByStripeId(params: {
  builderId: string;
  stripeInvoiceId: string;
  set: Record<string, unknown>;
  auditAction: AuditAction;
  auditDetails?: Record<string, unknown>;
  blockWhenStatusIn?: readonly string[];
}): Promise<{ matched: boolean; invoiceId: string | null }> {
  return withRLS(params.builderId, async (tx) => {
    const guard = params.blockWhenStatusIn;
    const byInvoice = and(
      eq(invoices.builder_id, params.builderId),
      eq(invoices.stripe_invoice_id, params.stripeInvoiceId),
    );
    const where =
      guard && guard.length > 0
        ? and(byInvoice, notInArray(invoices.status, guard as string[]))
        : byInvoice;

    const updated = await tx
      .update(invoices)
      .set(params.set)
      .where(where)
      .returning({ id: invoices.id });

    const row = updated[0];
    if (row) {
      await auditLog(tx, {
        builder_id: params.builderId,
        actor_type: 'system',
        actor_id: 'stripe-webhook',
        action: params.auditAction,
        resource_type: 'invoice',
        resource_id: row.id,
        details: { stripe_invoice_id: params.stripeInvoiceId, ...params.auditDetails },
      });
      return { matched: true, invoiceId: row.id };
    }

    let existingId: string | null = null;
    if (guard && guard.length > 0) {
      const found = await tx.select({ id: invoices.id }).from(invoices).where(byInvoice).limit(1);
      existingId = found[0]?.id ?? null;
    }

    await auditLog(tx, {
      builder_id: params.builderId,
      actor_type: 'system',
      actor_id: 'stripe-webhook',
      action: existingId
        ? AuditAction.BILLING_WEBHOOK_REPLAY_IGNORED
        : AuditAction.ALERT_SKIPPED_NO_INVOICE,
      resource_type: 'invoice',
      resource_id: existingId ?? undefined,
      details: { stripe_invoice_id: params.stripeInvoiceId, ...params.auditDetails },
    });
    return { matched: false, invoiceId: null };
  });
}

export async function handleInvoicePaid(event: Stripe.Event, ctx: HandlerContext): Promise<void> {
  const invoice = event.data.object as Stripe.Invoice;
  if (!invoice.id) return;
  await updateInvoiceByStripeId({
    builderId: ctx.builderId,
    stripeInvoiceId: invoice.id,
    set: { status: 'paid', paid_at: new Date(ctx.eventCreated * 1000) },
    auditAction: AuditAction.BILLING_INVOICE_PAID,
    auditDetails: { event_id: ctx.eventId, amount_paid: invoice.amount_paid ?? 0 },
    blockWhenStatusIn: ['paid', 'void'],
  });
}

export async function handleInvoicePaymentFailed(
  event: Stripe.Event,
  ctx: HandlerContext,
): Promise<void> {
  const invoice = event.data.object as Stripe.Invoice;
  if (!invoice.id) return;
  const result = await updateInvoiceByStripeId({
    builderId: ctx.builderId,
    stripeInvoiceId: invoice.id,
    set: { status: 'failed', payment_failed_at: new Date(ctx.eventCreated * 1000) },
    auditAction: AuditAction.BILLING_INVOICE_PAYMENT_FAILED,
    auditDetails: { event_id: ctx.eventId },
    blockWhenStatusIn: ['paid', 'void'],
  });

  if (!result.matched || !result.invoiceId) return;

  const amountUsd = (invoice.amount_due ?? 0) / 100;
  const customerMetadata = (invoice.metadata?.['pylva_customer_id'] ?? '') as string;
  const payload: BillingPaymentFailedPayload = {
    id: ctx.eventId,
    type: WebhookEventType.BILLING_PAYMENT_FAILED,
    builder_id: ctx.builderId,
    timestamp: new Date(ctx.eventCreated * 1000).toISOString(),
    data: {
      customer_id: customerMetadata,
      invoice_id: result.invoiceId,
      stripe_invoice_id: invoice.id,
      amount_usd: amountUsd,
      failure_reason:
        typeof invoice.last_finalization_error?.message === 'string'
          ? invoice.last_finalization_error.message
          : null,
      hosted_invoice_url: invoice.hosted_invoice_url ?? null,
    },
  };

  await deliverBuilderAlert({ builderId: ctx.builderId, payload });
}

export async function handleInvoiceViewed(event: Stripe.Event, ctx: HandlerContext): Promise<void> {
  // Stripe emits `invoice.sent` when it dispatches the hosted link; we
  // treat it as a "viewed" signal because our column is last_viewed_at.
  // A separate `invoice.viewed` event fires when the recipient opens the
  // hosted page; both map to the same column.
  const invoice = event.data.object as Stripe.Invoice;
  if (!invoice.id) return;
  await updateInvoiceByStripeId({
    builderId: ctx.builderId,
    stripeInvoiceId: invoice.id,
    set: { last_viewed_at: new Date(ctx.eventCreated * 1000) },
    auditAction: AuditAction.BILLING_INVOICE_VIEWED,
    auditDetails: { event_id: ctx.eventId, stripe_event_type: event.type },
  });
}

export async function handleChargeDisputeCreated(
  event: Stripe.Event,
  ctx: HandlerContext,
): Promise<void> {
  const dispute = event.data.object as Stripe.Dispute;
  const chargeId = typeof dispute.charge === 'string' ? dispute.charge : (dispute.charge?.id ?? '');
  const amountUsd = (dispute.amount ?? 0) / 100;

  // Disputes don't map 1:1 to invoices via stripe_invoice_id — we audit + alert
  // with whatever context we have. No DB update needed on `invoices`.
  await withRLS(ctx.builderId, async (tx) => {
    await auditLog(tx, {
      builder_id: ctx.builderId,
      actor_type: 'system',
      actor_id: 'stripe-webhook',
      action: AuditAction.BILLING_DISPUTE_CREATED,
      resource_type: 'dispute',
      resource_id: dispute.id,
      details: {
        event_id: ctx.eventId,
        charge_id: chargeId,
        amount_usd: amountUsd,
        reason: dispute.reason ?? null,
      },
    });
  });

  const payload: BillingDisputeCreatedPayload = {
    id: ctx.eventId,
    type: WebhookEventType.BILLING_DISPUTE_CREATED,
    builder_id: ctx.builderId,
    timestamp: new Date(ctx.eventCreated * 1000).toISOString(),
    data: {
      dispute_id: dispute.id,
      charge_id: chargeId,
      invoice_id: null, // Stripe dispute → charge → invoice requires another API call; skipped for B2b
      amount_usd: amountUsd,
      reason: dispute.reason ?? null,
    },
  };
  await deliverBuilderAlert({ builderId: ctx.builderId, payload });
}

/**
 * Dispatch table — keyed by event.type. Unknown types fall through to a
 * logger.info + 200 response (Stripe sends many event types; we only
 * care about the subset enumerated here).
 */
export async function dispatch(event: Stripe.Event, ctx: HandlerContext): Promise<void> {
  // Compare as string: `invoice.viewed` is a real Stripe webhook event that
  // the SDK's Event.type union doesn't include, and the narrowing fights
  // us if we use the typed literal.
  const type = event.type as string;
  switch (type) {
    case 'invoice.paid':
      return handleInvoicePaid(event, ctx);
    case 'invoice.payment_failed':
      return handleInvoicePaymentFailed(event, ctx);
    case 'invoice.sent':
    case 'invoice.viewed':
      return handleInvoiceViewed(event, ctx);
    case 'charge.dispute.created':
      return handleChargeDisputeCreated(event, ctx);
    default:
      log.info({ event_id: ctx.eventId, type }, 'ignoring unhandled Stripe event');
  }
}
