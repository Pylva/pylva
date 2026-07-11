// Track 1 PR 1.3 — webhook secret rotation with fixed 24h grace (O14).
// Moves current secret → secret_prior, mints a new secret, stamps
// secret_rotated_at = NOW(). Existing alert dispatcher signs with current
// secret; receivers can verify against secret OR secret_prior for 24h
// (verifyWebhook semantics already documented in src/lib/alerts/channels/webhook.ts).

import { NextResponse, type NextRequest } from 'next/server.js';
import crypto from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { ErrorCode, type Role as RoleType } from '@pylva/shared';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { withRole, Role } from '@/lib/auth/middleware';
import { checkBuilderFeatureGate } from '@/lib/auth/tier-enforcement';
import { auditLog } from '@/lib/auth/audit-log';
import { AuditAction } from '@/lib/audit/actions';
import { withRLS } from '@/lib/db/rls';
import { webhookConfigs } from '@/lib/db/schema';
import { authError, notFoundError } from '@/lib/errors';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;
  const tierGate = await checkBuilderFeatureGate(ctx.builderId, 'webhooks');
  if (tierGate) return tierGate;
  if (!ctx.userId) return authError(ErrorCode.INVALID_API_KEY, 'No user context');
  const gate = withRole([Role.OWNER], ctx.role as RoleType | null);
  if (gate) return gate;

  const { id } = await params;
  const newSecret = `whsec_${crypto.randomBytes(24).toString('hex')}`;
  const now = new Date();

  const [next] = await withRLS(ctx.builderId, async (tx) => {
    const existing = await tx
      .select({ secret: webhookConfigs.secret })
      .from(webhookConfigs)
      .where(and(eq(webhookConfigs.id, id), eq(webhookConfigs.builder_id, ctx.builderId)))
      .limit(1);
    if (existing.length === 0) return [];
    return tx
      .update(webhookConfigs)
      .set({
        secret: newSecret,
        secret_prior: existing[0]!.secret,
        secret_rotated_at: now,
        updated_at: now,
      })
      .where(and(eq(webhookConfigs.id, id), eq(webhookConfigs.builder_id, ctx.builderId)))
      .returning();
  });
  if (!next) return notFoundError(ErrorCode.NOT_FOUND, 'Webhook not found');

  await withRLS(ctx.builderId, async (tx) => {
    await auditLog(tx, {
      builder_id: ctx.builderId,
      actor_type: 'user',
      actor_id: ctx.userId!,
      action: AuditAction.WEBHOOK_ROTATE_SECRET,
      resource_type: 'webhook_config',
      resource_id: id,
      details: { rotated_at: now.toISOString() },
    });
  });

  return NextResponse.json({
    webhook: {
      id: next.id,
      secret: newSecret,
      secret_rotated_at: next.secret_rotated_at,
    },
  });
}
