// SPDX-License-Identifier: Elastic-2.0
// B2b T2 — GET /api/v1/billing/connect/return?account=acct_...
//
// Stripe redirects the browser here after Onboarding completes (success or
// partial). We retrieve the account, check capabilities, write the final
// status, and 302 to the dashboard settings page.
//
// Capabilities gate (I-T2-14): we only flip `capabilities_ok=true` when
// BOTH `card_payments` is active AND `payouts_enabled`. Otherwise status =
// 'connected_pending_capabilities' — a banner on the dashboard prompts the
// user to finish the missing steps in Stripe.

import { NextResponse, type NextRequest } from 'next/server.js';
import { and, eq } from 'drizzle-orm';
import { ErrorCode, StripeConnectStatus } from '@pylva/shared';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { checkBuilderFeatureGate } from '@/lib/auth/tier-enforcement';
import { auditLog } from '@/lib/auth/audit-log';
import { AuditAction } from '@/lib/audit/actions';
import { stripeFor } from '@/lib/stripe/client';
import { withRLS } from '@/lib/db/rls';
import { stripeConnect } from '@/lib/db/schema';
import { env } from '@/lib/config';
import { apiError, validationError, internalError } from '@/lib/errors';
import { isStripeConfigurationError } from '@/lib/stripe/config-error';
import { logger } from '@/lib/logger';
import Stripe from 'stripe';
import { ORG_HEADER } from '@/lib/dashboard/request-context';

const log = logger.child({ module: 'billing.connect.return' });

function hasRequiredCapabilities(account: Stripe.Account): boolean {
  const cardPayments = account.capabilities?.card_payments;
  const payoutsEnabled = account.payouts_enabled === true;
  return cardPayments === 'active' && payoutsEnabled;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;
  const tierGate = await checkBuilderFeatureGate(ctx.builderId, 'billing');
  if (tierGate) return tierGate;

  const url = new URL(request.url);
  const accountId = url.searchParams.get('account');
  if (!accountId || !accountId.startsWith('acct_')) {
    return validationError('Missing or malformed `account` query param', 'account');
  }

  // Verify the account id belongs to this builder. If not, 404 — don't leak
  // info about other builders' Stripe accounts.
  const existing = await withRLS(ctx.builderId, async (tx) => {
    const rows = await tx
      .select({ id: stripeConnect.id, stripe_account_id: stripeConnect.stripe_account_id })
      .from(stripeConnect)
      .where(
        and(
          eq(stripeConnect.builder_id, ctx.builderId),
          eq(stripeConnect.stripe_account_id, accountId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  });

  if (!existing) {
    return validationError('Unknown Stripe account for this builder', 'account');
  }

  try {
    const stripe = stripeFor();
    const account = await stripe.accounts.retrieve(accountId);

    const capabilitiesOk = hasRequiredCapabilities(account);
    const newStatus = capabilitiesOk
      ? StripeConnectStatus.CONNECTED
      : StripeConnectStatus.CONNECTED_PENDING_CAPABILITIES;

    await withRLS(ctx.builderId, async (tx) => {
      await tx
        .update(stripeConnect)
        .set({
          status: newStatus,
          capabilities_ok: capabilitiesOk,
          connected_at: new Date(),
          updated_at: new Date(),
        })
        .where(eq(stripeConnect.builder_id, ctx.builderId));

      if (ctx.userId) {
        await auditLog(tx, {
          builder_id: ctx.builderId,
          actor_type: 'user',
          actor_id: ctx.userId,
          action: capabilitiesOk
            ? AuditAction.BILLING_STRIPE_CONNECTED
            : AuditAction.BILLING_STRIPE_CONNECTED_PENDING_CAPABILITIES,
          resource_type: 'stripe_connect',
          resource_id: accountId,
          details: {
            card_payments: account.capabilities?.card_payments ?? null,
            payouts_enabled: account.payouts_enabled ?? null,
          },
        });
      }
    });

    // Middleware re-injects only the validated page org. Never derive this
    // destination from Referer: the browser arrived cross-origin from Stripe.
    const pageOrg = request.headers.get(ORG_HEADER);
    const redirectTo = new URL(
      pageOrg ? `/o/${pageOrg}/dashboard/settings/billing` : '/',
      env.OAUTH_REDIRECT_BASE_URL,
    );
    redirectTo.searchParams.set('stripe', capabilitiesOk ? 'connected' : 'pending_capabilities');
    return NextResponse.redirect(redirectTo, 302);
  } catch (err) {
    if (isStripeConfigurationError(err)) {
      return apiError(503, 'api_error', ErrorCode.INTERNAL_ERROR, err.message, 'stripe');
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { builder_id: ctx.builderId, account_id: accountId, error: message },
      'stripe account retrieve failed',
    );
    return internalError('Failed to finalize Stripe onboarding');
  }
}
