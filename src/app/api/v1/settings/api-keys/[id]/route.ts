// Track 1 PR 1.2 — DELETE /api/v1/settings/api-keys/[id] = revoke.
// Owner-only. id here is the row UUID; we look up its key_id via RLS,
// then revoke immediately and audit-log.

import { NextResponse, type NextRequest } from 'next/server.js';
import { and, eq } from 'drizzle-orm';
import { ErrorCode, type Role as RoleType } from '@pylva/shared';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { withRole, Role } from '@/lib/auth/middleware';
import { revokeApiKey } from '@/lib/auth/api-key';
import { auditLog } from '@/lib/auth/audit-log';
import { AuditAction } from '@/lib/audit/actions';
import { withRLS } from '@/lib/db/rls';
import { apiKeys } from '@/lib/db/schema';
import { authError, notFoundError } from '@/lib/errors';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.userId) return authError(ErrorCode.INVALID_API_KEY, 'No user context');
  const gate = withRole([Role.OWNER], ctx.role as RoleType | null);
  if (gate) return gate;

  const { id } = await params;

  // Scope the lookup by builder_id, not just the row id. RLS is NOT a
  // sufficient backstop here: the app connects as the table-owner role and no
  // table is FORCE ROW LEVEL SECURITY, so policies are bypassed in production
  // (see tests/security/api-key-cross-tenant-revoke.test.ts). Without the
  // builder_id predicate, an owner of one builder could revoke another
  // builder's API key by its (client-exposed) row id. Every sibling [id]
  // route filters on builder_id for the same reason.
  const [row] = await withRLS(ctx.builderId, async (tx) =>
    tx
      .select({ key_id: apiKeys.key_id, scope: apiKeys.scope })
      .from(apiKeys)
      .where(and(eq(apiKeys.id, id), eq(apiKeys.builder_id, ctx.builderId)))
      .limit(1),
  );
  if (!row) return notFoundError(ErrorCode.NOT_FOUND, 'API key not found');

  await revokeApiKey(row.key_id, true);

  await withRLS(ctx.builderId, async (tx) => {
    await auditLog(tx, {
      builder_id: ctx.builderId,
      actor_type: 'user',
      actor_id: ctx.userId!,
      action: AuditAction.API_KEY_REVOKE,
      resource_type: 'api_key',
      resource_id: row.key_id,
      details: { scope: row.scope },
    });
  });

  return NextResponse.json({ ok: true });
}
