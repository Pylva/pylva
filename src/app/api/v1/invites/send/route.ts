// B2a — POST /api/v1/invites/send  (Owner-only, I-T1-10)
// Creates an invites row (token, expires_at) and emails the invitee with a
// link to the accept endpoint. Resend used when RESEND_API_KEY is set;
// otherwise the link is logged server-side (dev smoke).

import crypto from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server.js';
import * as v from 'valibot';
import { withRole, Role } from '@/lib/auth/middleware';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { withRLS } from '@/lib/db/rls';
import { invites } from '@/lib/db/schema';
import { auditLog } from '@/lib/auth/audit-log';
import { AuditAction } from '@/lib/audit/actions';
import { env } from '@/lib/config';
import { authError, validationError } from '@/lib/errors';
import { ErrorCode, type Role as RoleType } from '@pylva/shared';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'invites.send' });

const BodySchema = v.object({
  email: v.pipe(v.string(), v.email()),
  role: v.picklist(['owner', 'member']),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Middleware already verified the JWT (+ CSRF) and injected the org-bound
  // context: when the page declared x-pylva-org, x-builder-id/x-user-role are
  // scoped to THAT org's membership. Deriving from the raw JWT here instead
  // would send the invite to whichever org the session was last minted for —
  // a wrong-org write when another tab switched accounts.
  const context = readBuilderContextFromDashboard(request);
  if (context instanceof NextResponse) return context;
  if (!context.userId) return authError(ErrorCode.INVALID_API_KEY, 'No user context');

  const gate = withRole([Role.OWNER], context.role as RoleType | null);
  if (gate) return gate;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError('Invalid JSON body', 'body');
  }
  const parsed = v.safeParse(BodySchema, body);
  if (!parsed.success) return validationError(parsed.issues[0]?.message ?? 'Invalid body', 'email');

  const { email, role } = parsed.output;
  const token = crypto.randomBytes(32).toString('hex');
  const ttlMs = env.INVITE_TTL_HOURS * 60 * 60 * 1000;
  const expiresAt = new Date(Date.now() + ttlMs);

  const inserted = await withRLS(context.builderId, async (tx) => {
    const rows = await tx
      .insert(invites)
      .values({
        builder_id: context.builderId,
        email: email.toLowerCase(),
        role,
        token,
        expires_at: expiresAt,
        invited_by_user_id: context.userId!,
      })
      .returning({ id: invites.id });
    await auditLog(tx, {
      builder_id: context.builderId,
      actor_type: 'user',
      actor_id: context.userId!,
      action: AuditAction.ORG_MEMBER_INVITED,
      resource_type: 'invite',
      resource_id: rows[0]!.id,
      details: { email, role },
    });
    return rows[0]!;
  });

  const inviteUrl = `${env.OAUTH_REDIRECT_BASE_URL}/api/v1/invites/accept?token=${encodeURIComponent(token)}`;

  if (env.RESEND_API_KEY) {
    try {
      const { Resend } = await import('resend');
      const client = new Resend(env.RESEND_API_KEY);
      await client.emails.send({
        from: env.INVITE_FROM_EMAIL,
        to: [email],
        subject: 'You are invited to Pylva',
        html: renderInviteHtml({ inviteUrl, expiresAt, role }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ error: msg, invite_id: inserted.id }, 'invite email send failed — row persisted');
    }
  } else {
    log.warn({ email }, 'RESEND_API_KEY not set — invite email skipped');
    console.warn(`[DEV] Invite link for ${email}:\n${inviteUrl}`);
  }

  return NextResponse.json({
    ok: true,
    invite_id: inserted.id,
    expires_at: expiresAt.toISOString(),
  });
}

function renderInviteHtml(p: { inviteUrl: string; expiresAt: Date; role: string }): string {
  const safeUrl = p.inviteUrl.replace(/"/g, '&quot;');
  return `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;max-width:560px;margin:32px auto;color:#222">
  <h2 style="font-size:18px">You've been invited to Pylva</h2>
  <p>You were invited as <strong>${p.role}</strong>. Click below to accept (link expires ${p.expiresAt.toISOString()}).</p>
  <p><a href="${safeUrl}" style="display:inline-block;padding:10px 16px;background:#004845;color:#fff;border-radius:6px;text-decoration:none">Accept invite</a></p>
</body></html>`;
}
