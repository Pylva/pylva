// SPDX-License-Identifier: Elastic-2.0
// B2b T2-C — POST /api/v1/billing/invoices/[id]/finalize
//
// Owner-only (I-T2-13). Calls stripe.invoices.sendInvoice on the connected
// account (I-T2-3); Stripe automatically finalizes draft invoices before
// sending, then emails the end-user with the hosted invoice link (D9).
//
// We still 409 our side if status is not 'draft' to keep the local state
// machine explicit.

import { NextResponse, type NextRequest } from 'next/server.js';
import * as v from 'valibot';
import { and, eq } from 'drizzle-orm';
import { Role, type Role as RoleType, ErrorCode } from '@pylva/shared';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { withRole } from '@/lib/auth/middleware';
import { checkBuilderFeatureGate } from '@/lib/auth/tier-enforcement';
import { auditLog } from '@/lib/auth/audit-log';
import { AuditAction } from '@/lib/audit/actions';
import { withRLS } from '@/lib/db/rls';
import { customers, invoices, stripeConnect } from '@/lib/db/schema';
import { validationError, notFoundError, apiError, internalError } from '@/lib/errors';
import { stripeFor } from '@/lib/stripe/client';
import { isStripeConfigurationError } from '@/lib/stripe/config-error';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'billing.invoices.finalize' });

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;
  const tierGate = await checkBuilderFeatureGate(ctx.builderId, 'billing');
  if (tierGate) return tierGate;

  const roleGate = withRole([Role.OWNER], ctx.role as RoleType | null);
  if (roleGate) return roleGate;

  const { id } = await params;
  if (!v.is(v.pipe(v.string(), v.uuid()), id)) return validationError('Invalid invoice id', 'id');

  const [invoiceRow, connectRow] = await Promise.all([
    withRLS(ctx.builderId, async (tx) =>
      tx
        .select()
        .from(invoices)
        .where(and(eq(invoices.builder_id, ctx.builderId), eq(invoices.id, id)))
        .limit(1)
        .then((r) => r[0] ?? null),
    ),
    withRLS(ctx.builderId, async (tx) =>
      tx
        .select({
          stripe_account_id: stripeConnect.stripe_account_id,
          status: stripeConnect.status,
          capabilities_ok: stripeConnect.capabilities_ok,
        })
        .from(stripeConnect)
        .where(eq(stripeConnect.builder_id, ctx.builderId))
        .limit(1)
        .then((r) => r[0] ?? null),
    ),
  ]);

  if (!invoiceRow) return notFoundError(ErrorCode.NOT_FOUND, 'Invoice not found');
  if (invoiceRow.status !== 'draft') {
    return apiError(
      409,
      'invalid_request_error',
      ErrorCode.VALIDATION_ERROR,
      `Cannot finalize invoice in status '${invoiceRow.status}'`,
      'status',
    );
  }
  if (!connectRow?.stripe_account_id || !invoiceRow.stripe_invoice_id) {
    return validationError('Stripe account not connected', 'stripe');
  }
  // I-T2-14 capabilities gate. Finalizing is the charge-triggering action,
  // so re-check the account is chargeable here too — not just at draft
  // generation. A soft-disconnect (POST /disconnect) leaves stripe_account_id
  // populated but flips capabilities_ok=false / status='disconnected'; without
  // this guard an owner could still finalize (and thus charge an end-customer
  // on) an account they explicitly disconnected.
  if (!connectRow.capabilities_ok) {
    return apiError(
      409,
      'invalid_request_error',
      ErrorCode.VALIDATION_ERROR,
      `Stripe account is not chargeable (status '${connectRow.status}') — reconnect to finalize`,
      'stripe',
    );
  }

  const customerRow = await withRLS(ctx.builderId, async (tx) =>
    tx
      .select({ email: customers.email })
      .from(customers)
      .where(and(eq(customers.builder_id, ctx.builderId), eq(customers.id, invoiceRow.customer_id)))
      .limit(1)
      .then((r) => r[0] ?? null),
  );
  if (!customerRow?.email) {
    return validationError('Customer email is required before sending invoice', 'customer_email');
  }

  try {
    const stripe = stripeFor(connectRow.stripe_account_id);
    await stripe.invoices.sendInvoice(invoiceRow.stripe_invoice_id);

    await withRLS(ctx.builderId, async (tx) => {
      await tx
        .update(invoices)
        .set({ status: 'pending' })
        .where(and(eq(invoices.id, id), eq(invoices.builder_id, ctx.builderId)));
      if (ctx.userId) {
        await auditLog(tx, {
          builder_id: ctx.builderId,
          actor_type: 'user',
          actor_id: ctx.userId,
          action: AuditAction.BILLING_INVOICE_FINALIZED,
          resource_type: 'invoice',
          resource_id: id,
          details: { stripe_invoice_id: invoiceRow.stripe_invoice_id },
        });
      }
    });

    return NextResponse.json({ id, status: 'pending' });
  } catch (err) {
    if (isStripeConfigurationError(err)) {
      return apiError(503, 'api_error', ErrorCode.INTERNAL_ERROR, err.message, 'stripe');
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error({ builder_id: ctx.builderId, invoice_id: id, error: message }, 'finalize failed');
    return internalError('Failed to finalize invoice');
  }
}
