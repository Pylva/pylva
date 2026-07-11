// B2a — DELETE /api/v1/invites/revoke/[id]  (Owner-only)
// Cancels an outstanding invite by setting expires_at = NOW(). The row is
// preserved for audit; the ON CONFLICT path in /accept will then reject.

import { NextResponse, type NextRequest } from 'next/server.js';
import { and, eq, isNull } from 'drizzle-orm';
import { withRole, Role } from '@/lib/auth/middleware';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { withRLS } from '@/lib/db/rls';
import { invites } from '@/lib/db/schema';
import { auditLog } from '@/lib/auth/audit-log';
import { AuditAction } from '@/lib/audit/actions';
import { authError, notFoundError } from '@/lib/errors';
import { ErrorCode, type Role as RoleType } from '@pylva/shared';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  // Org-bound context from middleware (see invites/send) — never the raw JWT.
  const context = readBuilderContextFromDashboard(request);
  if (context instanceof NextResponse) return context;
  if (!context.userId) return authError(ErrorCode.INVALID_API_KEY, 'No user context');

  const gate = withRole([Role.OWNER], context.role as RoleType | null);
  if (gate) return gate;

  const { id } = await params;
  const result = await withRLS(context.builderId, async (tx) => {
    const updated = await tx
      .update(invites)
      .set({ expires_at: new Date() })
      .where(
        and(
          eq(invites.id, id),
          eq(invites.builder_id, context.builderId),
          isNull(invites.accepted_at),
        ),
      )
      .returning({ id: invites.id });
    if (updated.length > 0) {
      await auditLog(tx, {
        builder_id: context.builderId,
        actor_type: 'user',
        actor_id: context.userId!,
        action: AuditAction.ORG_INVITE_REVOKED,
        resource_type: 'invite',
        resource_id: id,
      });
    }
    return updated;
  });

  if (result.length === 0) return notFoundError(ErrorCode.NOT_FOUND, 'Invite not found');
  return NextResponse.json({ ok: true });
}
