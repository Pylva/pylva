// SPDX-License-Identifier: Elastic-2.0
// B2b T2 — POST /api/v1/billing/connect
//
// Owner-only (I-T2-13). Creates a Stripe standard Connect account +
// accountLinks.create({type:'account_onboarding'}), UPSERTs a
// stripe_connect row with status='pending_onboarding', and returns the
// hosted onboarding URL for browser redirect.
//
// Decision D1: embedded Onboarding (not OAuth). Standard account. No
// platform fee. Dashboard redirects to the returned onboarding_url.

import { NextResponse, type NextRequest } from 'next/server.js';
import { and, eq, isNotNull } from 'drizzle-orm';
import { ErrorCode, Role, type Role as RoleType, StripeConnectStatus } from '@pylva/shared';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { withRole } from '@/lib/auth/middleware';
import { checkBuilderFeatureGate } from '@/lib/auth/tier-enforcement';
import { auditLog } from '@/lib/auth/audit-log';
import { AuditAction } from '@/lib/audit/actions';
import { stripeFor } from '@/lib/stripe/client';
import { withRLS } from '@/lib/db/rls';
import { customerPricing, stripeConnect } from '@/lib/db/schema';
import { env } from '@/lib/config';
import { apiError, internalError } from '@/lib/errors';
import { isStripeConfigurationError } from '@/lib/stripe/config-error';
import { logger } from '@/lib/logger';
import {
  ORG_HEADER,
  PAGE_SESSION_HEADER,
  withDashboardContext,
} from '@/lib/dashboard/request-context';

const log = logger.child({ module: 'billing.connect' });

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;
  const tierGate = await checkBuilderFeatureGate(ctx.builderId, 'billing');
  if (tierGate) return tierGate;

  const roleGate = withRole([Role.OWNER], ctx.role as RoleType | null);
  if (roleGate) return roleGate;

  try {
    const stripe = stripeFor();
    const account = await stripe.accounts.create({
      type: 'standard',
      metadata: {
        pylva_builder_id: ctx.builderId,
      },
    });

    const base = env.PYLVA_BACKEND_URL;
    const pageOrg = request.headers.get(ORG_HEADER);
    const pageSession = request.headers.get(PAGE_SESSION_HEADER);
    const refreshUrl = pageOrg
      ? `${base}/o/${pageOrg}/dashboard/settings/billing?connect=retry`
      : `${base}/dashboard/settings/billing?connect=retry`;
    const bareReturnPath = `/api/v1/billing/connect/return?account=${encodeURIComponent(account.id)}`;
    const returnPath =
      pageOrg && pageSession
        ? withDashboardContext(bareReturnPath, { orgSlug: pageOrg, pageSession })
        : bareReturnPath;
    const returnUrl = `${base}${returnPath}`;

    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: 'account_onboarding',
    });

    await withRLS(ctx.builderId, async (tx) => {
      await tx
        .insert(stripeConnect)
        .values({
          builder_id: ctx.builderId,
          stripe_account_id: account.id,
          status: StripeConnectStatus.PENDING_ONBOARDING,
          capabilities_ok: false,
        })
        .onConflictDoUpdate({
          target: stripeConnect.builder_id,
          set: {
            stripe_account_id: account.id,
            status: 'pending_onboarding',
            capabilities_ok: false,
            updated_at: new Date(),
          },
        });

      // This route always mints a fresh Stripe account, so any
      // customer_pricing.stripe_customer_id cached from a previous
      // connection belongs to the OLD account and is invalid on the new
      // one. If left in place, ensureStripeCustomer returns the stale id
      // and every stripe.invoices.create on the new account fails with
      // "No such customer" — the monthly-drafts cron then silently skips
      // the customer (missed invoices). Clear the cache so the next
      // invoice run re-creates customers on the new account (I-T2-9).
      await tx
        .update(customerPricing)
        .set({ stripe_customer_id: null, updated_at: new Date() })
        .where(
          and(
            eq(customerPricing.builder_id, ctx.builderId),
            isNotNull(customerPricing.stripe_customer_id),
          ),
        );

      if (ctx.userId) {
        await auditLog(tx, {
          builder_id: ctx.builderId,
          actor_type: 'user',
          actor_id: ctx.userId,
          action: AuditAction.BILLING_CONNECT_INITIATED,
          resource_type: 'stripe_connect',
          resource_id: account.id,
          details: { slug: pageOrg },
        });
      }
    });

    return NextResponse.json({ onboarding_url: accountLink.url, account_id: account.id });
  } catch (err) {
    if (isStripeConfigurationError(err)) {
      return apiError(503, 'api_error', ErrorCode.INTERNAL_ERROR, err.message, 'stripe');
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error({ builder_id: ctx.builderId, error: message }, 'stripe connect initiate failed');
    return internalError('Failed to initiate Stripe Connect onboarding');
  }
}
