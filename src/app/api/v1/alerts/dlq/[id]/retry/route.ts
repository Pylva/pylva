// Track 1 PR 1.4 — POST /api/v1/alerts/dlq/[id]/retry. Owner-only.

import { NextResponse, type NextRequest } from 'next/server.js';
import { ErrorCode, type Role as RoleType } from '@pylva/shared';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { withRole, Role } from '@/lib/auth/middleware';
import { retryDlqEntry } from '@/lib/alerts/dlq-retry';
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

  const { id } = await params;
  const outcome = await retryDlqEntry({
    builderId: ctx.builderId,
    dlqId: id,
    actorUserId: ctx.userId,
  });

  if (outcome.kind === 'not_found') {
    // Concurrent retry returns 404 by design (per O3).
    return notFoundError(ErrorCode.NOT_FOUND, 'DLQ entry not found or already handled');
  }
  if (outcome.kind === 'success') {
    return NextResponse.json({ ok: true, channel: outcome.channel });
  }
  return NextResponse.json(
    { ok: false, channel: outcome.channel, attempts: outcome.attempts, error: outcome.error },
    { status: 502 },
  );
}
