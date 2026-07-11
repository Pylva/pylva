// B2b T2-B — /api/v1/customers/[id]/pricing
//
// GET — returns current version + full version history. Member and Owner
//       can read.
// POST — validates + writes a new version (atomic close-prior + insert-new).
//        Owner-only (I-T2-13). Audit `billing.pricing_set`.
//
// Customer `id` here is the pylva `customers.id` UUID, not the external
// id. The dashboard resolves external → id before navigating here.

import { NextResponse, type NextRequest } from 'next/server.js';
import * as v from 'valibot';
import { eq, and } from 'drizzle-orm';
import { Role, type Role as RoleType } from '@pylva/shared';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { withRole } from '@/lib/auth/middleware';
import { auditLog } from '@/lib/auth/audit-log';
import { AuditAction } from '@/lib/audit/actions';
import { withRLS } from '@/lib/db/rls';
import { customers } from '@/lib/db/schema';
import { validationError, notFoundError, internalError } from '@/lib/errors';
import { ErrorCode } from '@pylva/shared';
import { pricingUpdateSchema } from '@/lib/billing/pricing-validator';
import {
  insertNewVersion,
  getActiveVersion,
  getAllVersions,
} from '@/lib/billing/pricing-versioning';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'billing.pricing' });

async function resolveCustomerExists(builderId: string, customerId: string): Promise<boolean> {
  const rows = await withRLS(builderId, async (tx) =>
    tx
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.builder_id, builderId), eq(customers.id, customerId)))
      .limit(1),
  );
  return rows.length > 0;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;

  const { id: customerId } = await params;
  if (!v.is(v.pipe(v.string(), v.uuid()), customerId)) {
    return validationError('Invalid customer id', 'id');
  }

  if (!(await resolveCustomerExists(ctx.builderId, customerId))) {
    return notFoundError(ErrorCode.NOT_FOUND, 'Customer not found');
  }

  const [current, history] = await Promise.all([
    getActiveVersion({ builderId: ctx.builderId, customerId }),
    getAllVersions({ builderId: ctx.builderId, customerId }),
  ]);

  return NextResponse.json({ current, history });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;

  const roleGate = withRole([Role.OWNER], ctx.role as RoleType | null);
  if (roleGate) return roleGate;

  const { id: customerId } = await params;
  if (!v.is(v.pipe(v.string(), v.uuid()), customerId)) {
    return validationError('Invalid customer id', 'id');
  }

  if (!(await resolveCustomerExists(ctx.builderId, customerId))) {
    return notFoundError(ErrorCode.NOT_FOUND, 'Customer not found');
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError('Invalid JSON body', 'body');
  }

  const parsed = v.safeParse(pricingUpdateSchema, body);
  if (!parsed.success) {
    const issue = parsed.issues[0];
    const path = issue?.path
      ?.map((p) => (typeof p.key === 'string' || typeof p.key === 'number' ? String(p.key) : ''))
      .filter(Boolean)
      .join('.');
    return validationError(issue?.message ?? 'Invalid pricing payload', path || 'body');
  }

  try {
    const result = await insertNewVersion({
      builderId: ctx.builderId,
      customerId,
      input: parsed.output,
    });

    if (ctx.userId) {
      await withRLS(ctx.builderId, async (tx) => {
        await auditLog(tx, {
          builder_id: ctx.builderId,
          actor_type: 'user',
          actor_id: ctx.userId!,
          action: AuditAction.BILLING_PRICING_SET,
          resource_type: 'customer_pricing',
          resource_id: result.id,
          details: {
            customer_id: customerId,
            version: result.version,
            pricing_model: parsed.output.pricing_model,
          },
        });
      });
    }

    return NextResponse.json({ id: result.id, version: result.version }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { builder_id: ctx.builderId, customer_id: customerId, error: message },
      'pricing version insert failed',
    );
    return internalError('Failed to update pricing');
  }
}
