// Track 1 PR 1.3 — webhook update / disable / delete.
// Owner-only.

import { NextResponse, type NextRequest } from 'next/server.js';
import * as v from 'valibot';
import { and, eq } from 'drizzle-orm';
import { ErrorCode, type Role as RoleType } from '@pylva/shared';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { withRole, Role } from '@/lib/auth/middleware';
import { checkBuilderFeatureGate } from '@/lib/auth/tier-enforcement';
import { auditLog } from '@/lib/auth/audit-log';
import { AuditAction } from '@/lib/audit/actions';
import { withRLS } from '@/lib/db/rls';
import { webhookConfigs } from '@/lib/db/schema';
import { authError, notFoundError, validationError } from '@/lib/errors';

const PatchSchema = v.object({
  url: v.optional(v.pipe(v.string(), v.url())),
  events: v.optional(v.pipe(v.array(v.string()), v.minLength(1), v.maxLength(50))),
  enabled: v.optional(v.boolean()),
});

export async function PATCH(
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
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError('Invalid JSON body', 'body');
  }
  const parsed = v.safeParse(PatchSchema, body);
  if (!parsed.success) return validationError(parsed.issues[0]?.message ?? 'Invalid body', 'body');

  const updates: Record<string, unknown> = { updated_at: new Date() };
  if (parsed.output.url !== undefined) updates['url'] = parsed.output.url;
  if (parsed.output.events !== undefined) updates['events'] = parsed.output.events;
  if (parsed.output.enabled !== undefined) updates['enabled'] = parsed.output.enabled;

  const [next] = await withRLS(ctx.builderId, async (tx) =>
    tx
      .update(webhookConfigs)
      .set(updates)
      .where(and(eq(webhookConfigs.id, id), eq(webhookConfigs.builder_id, ctx.builderId)))
      .returning(),
  );
  if (!next) return notFoundError(ErrorCode.NOT_FOUND, 'Webhook not found');

  await withRLS(ctx.builderId, async (tx) => {
    await auditLog(tx, {
      builder_id: ctx.builderId,
      actor_type: 'user',
      actor_id: ctx.userId!,
      action:
        parsed.output.enabled === false ? AuditAction.WEBHOOK_DISABLE : AuditAction.WEBHOOK_UPDATE,
      resource_type: 'webhook_config',
      resource_id: id,
      details: parsed.output as Record<string, unknown>,
    });
  });

  return NextResponse.json({
    webhook: {
      id: next.id,
      url: next.url,
      events: next.events,
      enabled: next.enabled,
      secret_rotated_at: next.secret_rotated_at,
    },
  });
}

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
  const rows = await withRLS(ctx.builderId, async (tx) =>
    tx
      .delete(webhookConfigs)
      .where(and(eq(webhookConfigs.id, id), eq(webhookConfigs.builder_id, ctx.builderId)))
      .returning({ id: webhookConfigs.id }),
  );
  if (rows.length === 0) return notFoundError(ErrorCode.NOT_FOUND, 'Webhook not found');

  await withRLS(ctx.builderId, async (tx) => {
    await auditLog(tx, {
      builder_id: ctx.builderId,
      actor_type: 'user',
      actor_id: ctx.userId!,
      action: AuditAction.WEBHOOK_DELETE,
      resource_type: 'webhook_config',
      resource_id: id,
    });
  });

  return NextResponse.json({ ok: true });
}
