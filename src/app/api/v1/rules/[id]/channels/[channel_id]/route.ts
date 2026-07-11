// B2a T3 — DELETE /api/v1/rules/[id]/channels/[channel_id]
// Track 1 PR 1.1: owner-only + audit log entry on channel removal.

import { NextResponse, type NextRequest } from 'next/server.js';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { removeChannel } from '@/lib/rules/repository';
import { withRole, Role } from '@/lib/auth/middleware';
import { auditLog } from '@/lib/auth/audit-log';
import { AuditAction } from '@/lib/audit/actions';
import { withRLS } from '@/lib/db/rls';
import { authError, notFoundError } from '@/lib/errors';
import { ErrorCode, type Role as RoleType } from '@pylva/shared';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; channel_id: string }> },
): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.userId) return authError(ErrorCode.INVALID_API_KEY, 'No user context');
  const gate = withRole([Role.OWNER], ctx.role as RoleType | null);
  if (gate) return gate;

  const { id, channel_id } = await params;
  const ok = await removeChannel(ctx.builderId, id, channel_id);
  if (!ok) return notFoundError(ErrorCode.NOT_FOUND, 'Channel not found');

  await withRLS(ctx.builderId, async (tx) => {
    await auditLog(tx, {
      builder_id: ctx.builderId,
      actor_type: 'user',
      actor_id: ctx.userId!,
      action: AuditAction.RULE_CHANNEL_REMOVE,
      resource_type: 'rule_alert_channel',
      resource_id: channel_id,
      details: { rule_id: id },
    });
  });

  return NextResponse.json({ ok: true });
}
