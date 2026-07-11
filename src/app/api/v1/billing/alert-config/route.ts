// SPDX-License-Identifier: Elastic-2.0
// B2b T2-E — /api/v1/billing/alert-config
//
// GET — return current builder_alert_config (may be null).
// PUT — upsert. Validates the channel variant: exactly one of
//       webhook_config_id / email_recipients / slack_webhook_url must match
//       the chosen channel. Owner-only.
//
// RLS-scoped via withRLS (I-T2-6).

import { NextResponse, type NextRequest } from 'next/server.js';
import * as v from 'valibot';
import { eq } from 'drizzle-orm';
import { AlertDeliveryChannel, Role, type Role as RoleType } from '@pylva/shared';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { withRole } from '@/lib/auth/middleware';
import { checkBuilderFeatureGate } from '@/lib/auth/tier-enforcement';
import { withRLS } from '@/lib/db/rls';
import { builderAlertConfig } from '@/lib/db/schema';
import { auditLog } from '@/lib/auth/audit-log';
import { AuditAction } from '@/lib/audit/actions';
import { validationError, internalError } from '@/lib/errors';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'billing.alert-config' });

// Discriminated-by-channel: each variant carries exactly the fields the
// chosen channel needs. Mirrors the DB CHECK constraint from migration 024.
const schema = v.variant('channel', [
  v.object({
    channel: v.literal(AlertDeliveryChannel.WEBHOOK),
    enabled: v.optional(v.boolean(), true),
    webhook_config_id: v.pipe(v.string(), v.uuid()),
  }),
  v.object({
    channel: v.literal(AlertDeliveryChannel.EMAIL),
    enabled: v.optional(v.boolean(), true),
    email_recipients: v.pipe(
      v.array(v.pipe(v.string(), v.email())),
      v.minLength(1),
      v.maxLength(10),
    ),
  }),
  v.object({
    channel: v.literal(AlertDeliveryChannel.SLACK),
    enabled: v.optional(v.boolean(), true),
    slack_webhook_url: v.pipe(v.string(), v.url()),
  }),
]);

export async function GET(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;
  const tierGate = await checkBuilderFeatureGate(ctx.builderId, 'billing');
  if (tierGate) return tierGate;

  const row = await withRLS(ctx.builderId, async (tx) => {
    const rows = await tx
      .select()
      .from(builderAlertConfig)
      .where(eq(builderAlertConfig.builder_id, ctx.builderId))
      .limit(1);
    return rows[0] ?? null;
  });
  return NextResponse.json({ config: row });
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;
  const tierGate = await checkBuilderFeatureGate(ctx.builderId, 'billing');
  if (tierGate) return tierGate;

  const roleGate = withRole([Role.OWNER], ctx.role as RoleType | null);
  if (roleGate) return roleGate;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError('Invalid JSON body', 'body');
  }
  const parsed = v.safeParse(schema, body);
  if (!parsed.success) return validationError(parsed.issues[0]?.message ?? 'Invalid body', 'body');

  const values = {
    builder_id: ctx.builderId,
    channel: parsed.output.channel,
    enabled: parsed.output.enabled,
    webhook_config_id:
      parsed.output.channel === AlertDeliveryChannel.WEBHOOK
        ? parsed.output.webhook_config_id
        : null,
    email_recipients:
      parsed.output.channel === AlertDeliveryChannel.EMAIL ? parsed.output.email_recipients : null,
    slack_webhook_url:
      parsed.output.channel === AlertDeliveryChannel.SLACK ? parsed.output.slack_webhook_url : null,
    updated_at: new Date(),
  };

  try {
    await withRLS(ctx.builderId, async (tx) => {
      await tx
        .insert(builderAlertConfig)
        .values(values)
        .onConflictDoUpdate({ target: builderAlertConfig.builder_id, set: values });

      if (ctx.userId) {
        await auditLog(tx, {
          builder_id: ctx.builderId,
          actor_type: 'user',
          actor_id: ctx.userId,
          action: AuditAction.BILLING_ALERT_CONFIG_SET,
          resource_type: 'builder_alert_config',
          details: { channel: parsed.output.channel, enabled: parsed.output.enabled },
        });
      }
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ builder_id: ctx.builderId, error: message }, 'alert config write failed');
    return internalError('Failed to save alert config');
  }
}
