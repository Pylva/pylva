// SPDX-License-Identifier: Elastic-2.0
// Track 4 PR 4.1 — POST /api/v1/portal/links/[id]/revoke. Owner-only.
//
// Marks the link revoked. The portal session table cascades on link
// delete, but we also actively delete sessions tied to this jti so any
// in-flight tabs lose access on the next request.

import { NextResponse, type NextRequest } from 'next/server.js';
import { and, eq } from 'drizzle-orm';
import { ErrorCode, PortalLinkStatus, type Role as RoleType } from '@pylva/shared';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { withRole, Role } from '@/lib/auth/middleware';
import { auditLog } from '@/lib/auth/audit-log';
import { AuditAction } from '@/lib/audit/actions';
import { withRLS } from '@/lib/db/rls';
import { portalLinks, portalSessions } from '@/lib/db/schema';
import { checkPortalEntitlement } from '@/lib/portal/entitlement';
import { authError, notFoundError } from '@/lib/errors';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.userId) return authError(ErrorCode.INVALID_API_KEY, 'No user context');
  const gate = withRole([Role.OWNER], ctx.role as RoleType | null);
  if (gate) return gate;
  const entitlement = await checkPortalEntitlement(ctx.builderId);
  if (entitlement) return entitlement;

  const { id } = await params;
  const now = new Date();

  const [updated] = await withRLS(ctx.builderId, async (tx) => {
    const rows = await tx
      .update(portalLinks)
      .set({ status: PortalLinkStatus.REVOKED, revoked_at: now })
      .where(and(eq(portalLinks.id, id), eq(portalLinks.builder_id, ctx.builderId)))
      .returning();
    if (rows.length === 0) return [];
    // Drop any active sessions tied to this jti — sliding-window check
    // would still see them otherwise until last_activity_at + 8h.
    await tx.delete(portalSessions).where(eq(portalSessions.jti, rows[0]!.jti));
    return rows;
  });

  if (!updated) return notFoundError(ErrorCode.NOT_FOUND, 'Portal link not found');

  await withRLS(ctx.builderId, async (tx) => {
    await auditLog(tx, {
      builder_id: ctx.builderId,
      actor_type: 'user',
      actor_id: ctx.userId!,
      action: AuditAction.PORTAL_LINK_REVOKE,
      resource_type: 'portal_link',
      resource_id: updated.id,
    });
  });

  return NextResponse.json({ ok: true });
}
