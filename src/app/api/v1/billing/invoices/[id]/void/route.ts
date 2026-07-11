// SPDX-License-Identifier: Elastic-2.0
// B2b T2-C — POST /api/v1/billing/invoices/[id]/void
//
// Owner-only (I-T2-13). Draft → stripe.invoices.del; pending → voidInvoice.
// Both set our status='void'. 409 when already paid/failed/void.

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
import { invoices, stripeConnect } from '@/lib/db/schema';
import { validationError, notFoundError, apiError, internalError } from '@/lib/errors';
import { stripeFor } from '@/lib/stripe/client';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'billing.invoices.void' });

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
    withRLS(ctx.builderId, async (tx) => {
      const rows = await tx
        .select()
        .from(invoices)
        .where(and(eq(invoices.builder_id, ctx.builderId), eq(invoices.id, id)))
        .limit(1);
      return rows[0] ?? null;
    }),
    withRLS(ctx.builderId, async (tx) => {
      const rows = await tx
        .select({ stripe_account_id: stripeConnect.stripe_account_id })
        .from(stripeConnect)
        .where(eq(stripeConnect.builder_id, ctx.builderId))
        .limit(1);
      return rows[0] ?? null;
    }),
  ]);

  if (!invoiceRow) return notFoundError(ErrorCode.NOT_FOUND, 'Invoice not found');
  if (!['draft', 'pending'].includes(invoiceRow.status)) {
    return apiError(
      409,
      'invalid_request_error',
      ErrorCode.VALIDATION_ERROR,
      `Cannot void invoice in status '${invoiceRow.status}'`,
      'status',
    );
  }
  if (!connectRow?.stripe_account_id || !invoiceRow.stripe_invoice_id) {
    return validationError('Stripe account not connected', 'stripe');
  }

  try {
    const stripe = stripeFor(connectRow.stripe_account_id);
    if (invoiceRow.status === 'draft') {
      await stripe.invoices.del(invoiceRow.stripe_invoice_id);
    } else {
      await stripe.invoices.voidInvoice(invoiceRow.stripe_invoice_id);
    }

    await withRLS(ctx.builderId, async (tx) => {
      await tx
        .update(invoices)
        .set({ status: 'void' })
        .where(and(eq(invoices.id, id), eq(invoices.builder_id, ctx.builderId)));
      if (ctx.userId) {
        await auditLog(tx, {
          builder_id: ctx.builderId,
          actor_type: 'user',
          actor_id: ctx.userId,
          action: AuditAction.BILLING_INVOICE_VOIDED,
          resource_type: 'invoice',
          resource_id: id,
          details: { stripe_invoice_id: invoiceRow.stripe_invoice_id },
        });
      }
    });

    return NextResponse.json({ id, status: 'void' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ builder_id: ctx.builderId, invoice_id: id, error: message }, 'invoice void failed');
    return internalError('Failed to void invoice');
  }
}
