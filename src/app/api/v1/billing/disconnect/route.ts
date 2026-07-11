// SPDX-License-Identifier: Elastic-2.0
// B2b T2 — POST /api/v1/billing/disconnect
//
// Owner-only (I-T2-13). Soft-disconnects by setting all capabilities inactive
// on the connected account + updating `stripe_connect.status='disconnected'`.
// Existing invoices remain; new invoice generation will be blocked by the
// capabilities gate (I-T2-14).
//
// We intentionally do NOT call `stripe.accounts.del` — that would permanently
// sever the connection and historical invoices on Stripe's side would become
// unreachable. Soft-disconnect preserves the account and lets the builder
// reconnect without data loss.

import { NextResponse, type NextRequest } from 'next/server.js';
import { eq } from 'drizzle-orm';
import { ErrorCode, Role, type Role as RoleType, StripeConnectStatus } from '@pylva/shared';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { withRole } from '@/lib/auth/middleware';
import { checkBuilderFeatureGate } from '@/lib/auth/tier-enforcement';
import { auditLog } from '@/lib/auth/audit-log';
import { AuditAction } from '@/lib/audit/actions';
import { stripeFor } from '@/lib/stripe/client';
import { withRLS } from '@/lib/db/rls';
import { stripeConnect } from '@/lib/db/schema';
import { apiError, validationError, internalError } from '@/lib/errors';
import { isStripeConfigurationError } from '@/lib/stripe/config-error';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'billing.disconnect' });

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;
  const tierGate = await checkBuilderFeatureGate(ctx.builderId, 'billing');
  if (tierGate) return tierGate;

  const roleGate = withRole([Role.OWNER], ctx.role as RoleType | null);
  if (roleGate) return roleGate;

  const row = await withRLS(ctx.builderId, async (tx) => {
    const rows = await tx
      .select({
        stripe_account_id: stripeConnect.stripe_account_id,
        status: stripeConnect.status,
      })
      .from(stripeConnect)
      .where(eq(stripeConnect.builder_id, ctx.builderId))
      .limit(1);
    return rows[0] ?? null;
  });

  if (!row || !row.stripe_account_id) {
    return validationError('No connected Stripe account for this builder', 'builder_id');
  }
  if (
    row.status === StripeConnectStatus.DISCONNECTED ||
    row.status === StripeConnectStatus.NOT_CONNECTED
  ) {
    return validationError(`Stripe account is already in status '${row.status}'`, 'status');
  }

  try {
    // Soft-disable: mark capabilities inactive. Stripe accepts an empty update
    // of individual capabilities; we also flip our own status + capabilities_ok
    // to block invoice gen immediately.
    const stripe = stripeFor();
    await stripe.accounts.update(row.stripe_account_id, {
      capabilities: {
        card_payments: { requested: false },
        transfers: { requested: false },
      },
    });

    await withRLS(ctx.builderId, async (tx) => {
      await tx
        .update(stripeConnect)
        .set({
          status: StripeConnectStatus.DISCONNECTED,
          capabilities_ok: false,
          updated_at: new Date(),
        })
        .where(eq(stripeConnect.builder_id, ctx.builderId));

      if (ctx.userId) {
        await auditLog(tx, {
          builder_id: ctx.builderId,
          actor_type: 'user',
          actor_id: ctx.userId,
          action: AuditAction.BILLING_STRIPE_DISCONNECTED,
          resource_type: 'stripe_connect',
          resource_id: row.stripe_account_id ?? undefined,
        });
      }
    });

    return NextResponse.json({ disconnected: true });
  } catch (err) {
    if (isStripeConfigurationError(err)) {
      return apiError(503, 'api_error', ErrorCode.INTERNAL_ERROR, err.message, 'stripe');
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { builder_id: ctx.builderId, account_id: row.stripe_account_id, error: message },
      'stripe disconnect failed',
    );
    return internalError('Failed to disconnect Stripe account');
  }
}
