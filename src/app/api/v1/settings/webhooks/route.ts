// Track 1 PR 1.3 — webhook config CRUD.
// Owner-only mutations per O18; member read-only metadata.

import { NextResponse, type NextRequest } from 'next/server.js';
import * as v from 'valibot';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { ErrorCode, type Role as RoleType } from '@pylva/shared';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { withRole, Role } from '@/lib/auth/middleware';
import { checkBuilderFeatureGate } from '@/lib/auth/tier-enforcement';
import { auditLog } from '@/lib/auth/audit-log';
import { AuditAction } from '@/lib/audit/actions';
import { withRLS } from '@/lib/db/rls';
import { webhookConfigs } from '@/lib/db/schema';
import { authError, validationError } from '@/lib/errors';
import { assertWebhookUrlAllowed } from '@/lib/external-egress';

const CreateSchema = v.object({
  url: v.pipe(v.string(), v.url()),
  events: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1), v.maxLength(50)),
  enabled: v.optional(v.boolean(), true),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;
  const tierGate = await checkBuilderFeatureGate(ctx.builderId, 'webhooks');
  if (tierGate) return tierGate;

  const rows = await withRLS(ctx.builderId, async (tx) =>
    tx
      .select({
        id: webhookConfigs.id,
        url: webhookConfigs.url,
        events: webhookConfigs.events,
        enabled: webhookConfigs.enabled,
        secret_rotated_at: webhookConfigs.secret_rotated_at,
        created_at: webhookConfigs.created_at,
        updated_at: webhookConfigs.updated_at,
      })
      .from(webhookConfigs)
      .where(eq(webhookConfigs.builder_id, ctx.builderId)),
  );

  return NextResponse.json({ webhooks: rows });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;
  const tierGate = await checkBuilderFeatureGate(ctx.builderId, 'webhooks');
  if (tierGate) return tierGate;
  if (!ctx.userId) return authError(ErrorCode.INVALID_API_KEY, 'No user context');
  const gate = withRole([Role.OWNER], ctx.role as RoleType | null);
  if (gate) return gate;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError('Invalid JSON body', 'body');
  }
  const parsed = v.safeParse(CreateSchema, body);
  if (!parsed.success) return validationError(parsed.issues[0]?.message ?? 'Invalid body', 'body');

  // SSRF guard at creation: reject non-https, localhost/.local, private-IP, or
  // URLs whose DNS resolves to a private address before we ever store them.
  try {
    await assertWebhookUrlAllowed(parsed.output.url);
  } catch {
    return validationError('Webhook URL must be a public https:// endpoint', 'url');
  }

  // Generate the secret server-side so plaintext exposure happens exactly once
  // (returned in this response only — never persisted in dashboard state).
  const secret = `whsec_${crypto.randomBytes(24).toString('hex')}`;

  const [created] = await withRLS(ctx.builderId, async (tx) => {
    const rows = await tx
      .insert(webhookConfigs)
      .values({
        builder_id: ctx.builderId,
        url: parsed.output.url,
        events: parsed.output.events,
        secret,
        enabled: parsed.output.enabled,
      })
      .returning();
    return rows;
  });

  await withRLS(ctx.builderId, async (tx) => {
    await auditLog(tx, {
      builder_id: ctx.builderId,
      actor_type: 'user',
      actor_id: ctx.userId!,
      action: AuditAction.WEBHOOK_CREATE,
      resource_type: 'webhook_config',
      resource_id: created!.id,
      details: { url: parsed.output.url, events: parsed.output.events },
    });
  });

  return NextResponse.json(
    {
      webhook: {
        id: created!.id,
        url: created!.url,
        events: created!.events,
        enabled: created!.enabled,
        secret,
      },
    },
    { status: 201 },
  );
}
