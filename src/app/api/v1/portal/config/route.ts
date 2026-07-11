// SPDX-License-Identifier: Elastic-2.0
// Track 4 PR 4.1 — GET / PUT /api/v1/portal/config.
// Owner-only mutations per O18 + §3 security defaults.

import { NextResponse, type NextRequest } from 'next/server.js';
import * as v from 'valibot';
import { eq } from 'drizzle-orm';
import { ErrorCode, type Role as RoleType } from '@pylva/shared';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { getBuilderTierGate } from '@/lib/auth/dashboard-feature-gate';
import { checkFeatureGate } from '@/lib/auth/tier-enforcement';
import { withRole, Role } from '@/lib/auth/middleware';
import { auditLog } from '@/lib/auth/audit-log';
import { AuditAction } from '@/lib/audit/actions';
import { withRLS } from '@/lib/db/rls';
import { portalConfigs } from '@/lib/db/schema';
import { checkPortalEntitlement, checkPortalEntitlementForTier } from '@/lib/portal/entitlement';
import { hasPortalBrandingFields, portalConfigUpdateSchema } from '@/lib/portal/validator';
import { authError, validationError } from '@/lib/errors';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;
  const entitlement = await checkPortalEntitlement(ctx.builderId);
  if (entitlement) return entitlement;

  const rows = await withRLS(ctx.builderId, async (tx) =>
    tx
      .select()
      .from(portalConfigs)
      .where(eq(portalConfigs.builder_id, ctx.builderId))
      .limit(1),
  );
  return NextResponse.json({ config: rows[0] ?? null });
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.userId) return authError(ErrorCode.INVALID_API_KEY, 'No user context');
  const gate = withRole([Role.OWNER], ctx.role as RoleType | null);
  if (gate) return gate;
  const tier = await getBuilderTierGate(ctx.builderId);
  if (tier instanceof Response) return tier;
  const entitlement = checkPortalEntitlementForTier(tier);
  if (entitlement) return entitlement;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError('Invalid JSON body', 'body');
  }
  const parsed = v.safeParse(portalConfigUpdateSchema, body);
  if (!parsed.success) return validationError(parsed.issues[0]?.message ?? 'Invalid config', 'body');

  const updateValues = parsed.output as Record<string, unknown>;
  if (hasPortalBrandingFields(parsed.output)) {
    const whiteLabelGate = checkFeatureGate(tier, 'white_label_portal');
    if (whiteLabelGate) return whiteLabelGate;
  }

  const insertValues: Record<string, unknown> = {
    builder_id: ctx.builderId,
    ...updateValues,
  };

  const [next] = await withRLS(ctx.builderId, async (tx) =>
    tx
      .insert(portalConfigs)
      .values(insertValues as typeof portalConfigs.$inferInsert)
      .onConflictDoUpdate({
        target: portalConfigs.builder_id,
        set: { ...updateValues, updated_at: new Date() },
      })
      .returning(),
  );

  await withRLS(ctx.builderId, async (tx) => {
    await auditLog(tx, {
      builder_id: ctx.builderId,
      actor_type: 'user',
      actor_id: ctx.userId!,
      action: AuditAction.PORTAL_CONFIG_UPDATE,
      resource_type: 'portal_config',
      resource_id: next!.id,
      details: { fields: Object.keys(updateValues) },
    });
  });

  return NextResponse.json({ config: next });
}
