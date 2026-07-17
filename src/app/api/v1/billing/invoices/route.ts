// SPDX-License-Identifier: Elastic-2.0
// B2b T2-C — /api/v1/billing/invoices
//
// GET  — list invoices with filters (customer_id, status, period, billing_cycle_id,
//        paginated). RLS-scoped by x-builder-id.
// POST — generate draft invoice(s) for a period. Owner-only (I-T2-13).
//        Requires Idempotency-Key header (I-T2-1). Returns N-array when
//        auto-split fires (I-T2-10).

import { NextResponse, type NextRequest } from 'next/server.js';
import * as v from 'valibot';
import { and, desc, eq, gte, lt } from 'drizzle-orm';
import { Role, type Role as RoleType, ErrorCode } from '@pylva/shared';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { withRole } from '@/lib/auth/middleware';
import { checkBuilderFeatureGate } from '@/lib/auth/tier-enforcement';
import { withRLS } from '@/lib/db/rls';
import { invoices } from '@/lib/db/schema';
import { validationError, apiError, internalError } from '@/lib/errors';
import { generateInvoice, BillingError } from '@/lib/billing/invoice-generator';
import { checkOrClaim, commitClaim, hashBody, releaseClaim } from '@/lib/billing/idempotency';
import { isStripeConfigurationError } from '@/lib/stripe/config-error';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'billing.invoices' });

const GenerateBody = v.object({
  customer_id: v.pipe(v.string(), v.uuid()),
  period_start: v.pipe(v.string(), v.isoTimestamp()),
  period_end: v.pipe(v.string(), v.isoTimestamp()),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;
  const tierGate = await checkBuilderFeatureGate(ctx.builderId, 'billing');
  if (tierGate) return tierGate;

  const url = new URL(request.url);
  const customerId = url.searchParams.get('customer_id');
  const status = url.searchParams.get('status');
  const periodStart = url.searchParams.get('period_start');
  const periodEnd = url.searchParams.get('period_end');
  const billingCycleId = url.searchParams.get('billing_cycle_id');
  const limit = Math.min(Number(url.searchParams.get('limit') ?? '100'), 500);
  const offset = Math.max(Number(url.searchParams.get('offset') ?? '0'), 0);

  const conditions = [eq(invoices.builder_id, ctx.builderId)];
  if (customerId) {
    if (!v.is(v.pipe(v.string(), v.uuid()), customerId)) {
      return validationError('Invalid customer_id', 'customer_id');
    }
    conditions.push(eq(invoices.customer_id, customerId));
  }
  if (status) {
    const allowedStatuses = ['draft', 'pending', 'paid', 'failed', 'void'] as const;
    if (!(allowedStatuses as readonly string[]).includes(status)) {
      return validationError('Invalid status', 'status');
    }
    conditions.push(eq(invoices.status, status));
  }
  if (periodStart) conditions.push(gte(invoices.period_start, new Date(periodStart)));
  if (periodEnd) conditions.push(lt(invoices.period_end, new Date(periodEnd)));
  if (billingCycleId) {
    if (!v.is(v.pipe(v.string(), v.uuid()), billingCycleId)) {
      return validationError('Invalid billing_cycle_id', 'billing_cycle_id');
    }
    conditions.push(eq(invoices.billing_cycle_id, billingCycleId));
  }

  const rows = await withRLS(ctx.builderId, async (tx) =>
    tx
      .select()
      .from(invoices)
      .where(and(...conditions))
      .orderBy(desc(invoices.created_at))
      .limit(limit)
      .offset(offset),
  );

  return NextResponse.json({ invoices: rows, limit, offset });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;
  const tierGate = await checkBuilderFeatureGate(ctx.builderId, 'billing');
  if (tierGate) return tierGate;

  const roleGate = withRole([Role.OWNER], ctx.role as RoleType | null);
  if (roleGate) return roleGate;

  const idempotencyKey = request.headers.get('idempotency-key');
  if (!idempotencyKey) {
    return validationError('Idempotency-Key header is required for POST', 'Idempotency-Key');
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError('Invalid JSON body', 'body');
  }
  const parsed = v.safeParse(GenerateBody, body);
  if (!parsed.success) return validationError(parsed.issues[0]?.message ?? 'Invalid body', 'body');

  const bodyHash = hashBody(parsed.output);
  const claim = await checkOrClaim({ builderId: ctx.builderId, key: idempotencyKey, bodyHash });

  if (claim.status === 'conflict') {
    return apiError(
      409,
      'invalid_request_error',
      ErrorCode.VALIDATION_ERROR,
      'Idempotency-Key was already used with a different request body',
      'Idempotency-Key',
    );
  }
  if (claim.status === 'replay') {
    if (claim.invoiceId) {
      return NextResponse.json({ invoices: [{ invoice_id: claim.invoiceId }], replayed: true });
    }
    // An uncommitted claim can mean a prior attempt stopped after persisting
    // only some auto-split slices. Resume with the deterministic draft keys;
    // persistOneDraft returns existing winners and creates only missing slices.
  }

  // Give manual invoice generation the same resumable per-slice dedupe rail
  // as the monthly cron. The persisted claim timestamp keeps retries inside
  // one 24-hour claim on the same namespace, while a key legitimately reused
  // after the claim is purged gets a new namespace. Hash before storing so
  // caller-supplied key material is never persisted in invoices.draft_key.
  const draftKeyBase = `oneoff:${hashBody({
    key: idempotencyKey,
    bodyHash,
    claimCreatedAt: claim.claimCreatedAt.toISOString(),
  })}`;

  try {
    const results = await generateInvoice({
      builderId: ctx.builderId,
      customerId: parsed.output.customer_id,
      period: {
        start: new Date(parsed.output.period_start),
        end: new Date(parsed.output.period_end),
      },
      actorUserId: ctx.userId ?? undefined,
      draftKeyBase,
    });

    // Record the first invoice id against the key — for auto-split both drafts
    // belong to this request but the simple mapping is key→single-invoice.
    if (results[0]) {
      await commitClaim({
        builderId: ctx.builderId,
        key: idempotencyKey,
        invoiceId: results[0].invoice_id,
      });
    }

    return NextResponse.json({ invoices: results }, { status: 201 });
  } catch (err) {
    if (err instanceof BillingError || isStripeConfigurationError(err)) {
      try {
        await releaseClaim({ builderId: ctx.builderId, key: idempotencyKey, bodyHash });
      } catch (releaseErr) {
        const releaseMessage =
          releaseErr instanceof Error ? releaseErr.message : String(releaseErr);
        log.warn(
          { builder_id: ctx.builderId, error: releaseMessage },
          'failed to release invoice idempotency claim after billing preflight error',
        );
      }
      if (isStripeConfigurationError(err)) {
        return apiError(503, 'api_error', ErrorCode.INTERNAL_ERROR, err.message, 'stripe');
      }
      return apiError(
        400,
        'invalid_request_error',
        ErrorCode.VALIDATION_ERROR,
        err.message,
        err.code,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error({ builder_id: ctx.builderId, error: message }, 'invoice generation failed');
    return internalError('Failed to generate invoice');
  }
}
