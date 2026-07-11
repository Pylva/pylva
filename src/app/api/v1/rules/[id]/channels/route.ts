// B2a T3 — /api/v1/rules/[id]/channels
// GET list channels for a rule. POST to add. DELETE /channels/[channel_id]
// for removal lives in ./[channel_id]/route.ts.

import { NextResponse, type NextRequest } from 'next/server.js';
import * as v from 'valibot';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { addChannel, getRule, listChannelsForRule } from '@/lib/rules/repository';
import { withRole, Role } from '@/lib/auth/middleware';
import { checkBuilderFeatureGate } from '@/lib/auth/tier-enforcement';
import { auditLog } from '@/lib/auth/audit-log';
import { AuditAction } from '@/lib/audit/actions';
import { withRLS } from '@/lib/db/rls';
import { authError, validationError, notFoundError } from '@/lib/errors';
import { AlertDeliveryChannel, ErrorCode, type Role as RoleType } from '@pylva/shared';

const slackWebhookUrlSchema = v.pipe(
  v.string(),
  v.url(),
  v.check(
    (url) => url.startsWith('https://hooks.slack.com/services/'),
    'Slack webhook URL must start with https://hooks.slack.com/services/',
  ),
);

const ChannelSchema = v.variant('channel', [
  v.object({
    channel: v.literal('webhook'),
    enabled: v.optional(v.boolean(), true),
    webhook_config_id: v.pipe(v.string(), v.uuid()),
  }),
  v.object({
    channel: v.literal('email'),
    enabled: v.optional(v.boolean(), true),
    email_recipients: v.pipe(
      v.array(v.pipe(v.string(), v.email())),
      v.minLength(1),
      v.maxLength(10),
    ),
  }),
  v.object({
    channel: v.literal('slack'),
    enabled: v.optional(v.boolean(), true),
    slack_webhook_url: slackWebhookUrlSchema,
  }),
]);

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;

  // RLS: ensure the rule exists for this builder before exposing channels.
  const rule = await getRule(ctx.builderId, id);
  if (!rule) return notFoundError(ErrorCode.NOT_FOUND, 'Rule not found');

  const channels = await listChannelsForRule(ctx.builderId, id);
  return NextResponse.json({ channels });
}

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
  const rule = await getRule(ctx.builderId, id);
  if (!rule) return notFoundError(ErrorCode.NOT_FOUND, 'Rule not found');

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError('Invalid JSON body', 'body');
  }
  const parsed = v.safeParse(ChannelSchema, body);
  if (!parsed.success)
    return validationError(parsed.issues[0]?.message ?? 'Invalid channel', 'body');
  if (parsed.output.channel === AlertDeliveryChannel.WEBHOOK) {
    const tierGate = await checkBuilderFeatureGate(ctx.builderId, 'webhooks');
    if (tierGate) return tierGate;
  }

  const created = await addChannel(ctx.builderId, {
    rule_id: id,
    ...parsed.output,
  });
  if (!created) {
    return notFoundError(ErrorCode.NOT_FOUND, 'Rule or channel target not found');
  }

  await withRLS(ctx.builderId, async (tx) => {
    await auditLog(tx, {
      builder_id: ctx.builderId,
      actor_type: 'user',
      actor_id: ctx.userId!,
      action: AuditAction.RULE_CHANNEL_ADD,
      resource_type: 'rule_alert_channel',
      resource_id: created.id,
      details: { rule_id: id, channel: parsed.output.channel },
    });
  });

  return NextResponse.json({ channel: created }, { status: 201 });
}
