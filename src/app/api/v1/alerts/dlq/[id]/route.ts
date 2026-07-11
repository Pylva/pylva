// Track 1 PR 1.4 — DELETE /api/v1/alerts/dlq/[id] = dismiss.
// Per O18, member role may dismiss; owner also allowed.

import { NextResponse, type NextRequest } from 'next/server.js';
import { and, eq } from 'drizzle-orm';
import { ErrorCode } from '@pylva/shared';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { auditLog } from '@/lib/auth/audit-log';
import { AuditAction } from '@/lib/audit/actions';
import { withRLS } from '@/lib/db/rls';
import { webhookDlq } from '@/lib/db/schema';
import { authError, notFoundError } from '@/lib/errors';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.userId) return authError(ErrorCode.INVALID_API_KEY, 'No user context');

  const { id } = await params;
  const rows = await withRLS(ctx.builderId, async (tx) =>
    tx
      .delete(webhookDlq)
      .where(and(eq(webhookDlq.id, id), eq(webhookDlq.builder_id, ctx.builderId)))
      .returning({ id: webhookDlq.id, channel: webhookDlq.channel }),
  );
  if (rows.length === 0) return notFoundError(ErrorCode.NOT_FOUND, 'DLQ entry not found');

  await withRLS(ctx.builderId, async (tx) => {
    await auditLog(tx, {
      builder_id: ctx.builderId,
      actor_type: 'user',
      actor_id: ctx.userId!,
      action: AuditAction.ALERT_DLQ_DISMISS,
      resource_type: 'webhook_dlq',
      resource_id: id,
      details: { channel: rows[0]!.channel, role: ctx.role ?? null },
    });
  });

  return NextResponse.json({ ok: true });
}
