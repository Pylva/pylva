// SPDX-License-Identifier: Elastic-2.0
// B2b T2-C — GET /api/v1/billing/invoices/[id]
//
// Invoice detail. Member + Owner both allowed. Void + finalize live in
// sibling route files (./void/route.ts, ./finalize/route.ts).

import { NextResponse, type NextRequest } from 'next/server.js';
import * as v from 'valibot';
import { and, eq } from 'drizzle-orm';
import { ErrorCode } from '@pylva/shared';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { checkBuilderFeatureGate } from '@/lib/auth/tier-enforcement';
import { withRLS } from '@/lib/db/rls';
import { invoices } from '@/lib/db/schema';
import { validationError, notFoundError } from '@/lib/errors';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;
  const tierGate = await checkBuilderFeatureGate(ctx.builderId, 'billing');
  if (tierGate) return tierGate;

  const { id } = await params;
  if (!v.is(v.pipe(v.string(), v.uuid()), id)) return validationError('Invalid invoice id', 'id');

  const invoice = await withRLS(ctx.builderId, async (tx) => {
    const rows = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.builder_id, ctx.builderId), eq(invoices.id, id)))
      .limit(1);
    return rows[0] ?? null;
  });

  if (!invoice) return notFoundError(ErrorCode.NOT_FOUND, 'Invoice not found');
  return NextResponse.json({ invoice });
}
