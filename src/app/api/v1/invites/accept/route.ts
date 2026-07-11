// B2a — GET /api/v1/invites/accept?token=...
// Claims an invite atomically, creates membership if needed, and rotates the
// dashboard session into the accepted organization.

import { NextResponse, type NextRequest } from 'next/server.js';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { setDashboardSessionCookies, withJwtAuth } from '@/lib/auth/middleware';
import { invalidateMembershipCache } from '@/lib/auth/membership-cache';
import { revokeJwt, signJwt } from '@/lib/auth/jwt';
import {
  clearPendingInviteCookie,
  readPendingInviteToken,
  setPendingInviteCookie,
  validInviteToken,
} from '@/lib/auth/pending-invite';
import { withRLS } from '@/lib/db/rls';
import { db } from '@/lib/db/client';
import { builders, invites, userBuilderMemberships, users } from '@/lib/db/schema';
import { auditLog } from '@/lib/auth/audit-log';
import { AuditAction } from '@/lib/audit/actions';
import { ErrorCode, JwtAudience, type Role as RoleType } from '@pylva/shared';
import { goneError, validationError } from '@/lib/errors';
import { env } from '@/lib/config';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'invites.accept' });

function terminalInviteError(message: string): NextResponse {
  const response = goneError(ErrorCode.NOT_FOUND, message);
  clearPendingInviteCookie(response);
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const urlToken = new URL(request.url).searchParams.get('token');
  const token = validInviteToken(urlToken) ?? readPendingInviteToken(request);
  if (!token) {
    const response = validationError('Missing or invalid token', 'token');
    clearPendingInviteCookie(response);
    return response;
  }

  // This preflight avoids an unnecessary authentication round trip for
  // already-terminal tokens. The transaction below repeats every predicate;
  // this lookup is not relied on for correctness.
  const candidate = await db
    .select({
      id: invites.id,
      builder_id: invites.builder_id,
      email: invites.email,
    })
    .from(invites)
    .where(
      and(
        eq(invites.token, token),
        isNull(invites.accepted_at),
        gt(invites.expires_at, new Date()),
      ),
    )
    .limit(1);

  if (candidate.length === 0) return terminalInviteError('Invite expired or already used');
  const invite = candidate[0]!;

  const authResult = await withJwtAuth(request, JwtAudience.DASHBOARD);
  if (authResult instanceof NextResponse) {
    const response = NextResponse.redirect(`${env.OAUTH_REDIRECT_BASE_URL}/login?invite=1`);
    setPendingInviteCookie(response, token);
    return response;
  }
  const { context } = authResult;
  const userId = context.userId;
  if (!userId) {
    const response = NextResponse.redirect(`${env.OAUTH_REDIRECT_BASE_URL}/login?invite=1`);
    setPendingInviteCookie(response, token);
    return response;
  }

  const userRow = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const userEmail = userRow[0]?.email;
  if (!userEmail || userEmail.toLowerCase() !== invite.email.toLowerCase()) {
    return terminalInviteError('Invite is for a different email');
  }

  const accepted = await withRLS(invite.builder_id, async (tx) => {
    const now = new Date();
    const claimed = await tx
      .update(invites)
      .set({ accepted_at: now })
      .where(
        and(
          eq(invites.id, invite.id),
          eq(invites.builder_id, invite.builder_id),
          eq(invites.token, token),
          eq(invites.email, userEmail),
          isNull(invites.accepted_at),
          gt(invites.expires_at, now),
        ),
      )
      .returning({ id: invites.id, role: invites.role });
    if (claimed.length === 0) return null;

    await tx
      .insert(userBuilderMemberships)
      .values({
        user_id: userId,
        builder_id: invite.builder_id,
        role: claimed[0]!.role as RoleType,
      })
      .onConflictDoNothing();

    // The committed membership is authoritative. An existing member keeps
    // their current role; accepting an invite never silently promotes them.
    const memberships = await tx
      .select({
        role: userBuilderMemberships.role,
        slug: builders.slug,
        tier: builders.tier,
      })
      .from(userBuilderMemberships)
      .innerJoin(builders, eq(builders.id, userBuilderMemberships.builder_id))
      .where(
        and(
          eq(userBuilderMemberships.user_id, userId),
          eq(userBuilderMemberships.builder_id, invite.builder_id),
        ),
      )
      .limit(1);
    const membership = memberships[0];
    if (!membership) throw new Error('Invite claim did not produce a membership');

    await auditLog(tx, {
      builder_id: invite.builder_id,
      actor_type: 'user',
      actor_id: userId,
      action: AuditAction.ORG_MEMBER_JOINED,
      resource_type: 'invite',
      resource_id: invite.id,
      details: { role: membership.role },
    });

    return {
      role: membership.role as RoleType,
      slug: membership.slug,
      tier: membership.tier,
    };
  });

  if (!accepted) return terminalInviteError('Invite expired or already used');

  await invalidateMembershipCache(userId, accepted.slug);

  // Sign first so a signing failure cannot revoke the browser's only usable
  // family. Invite acceptance intentionally starts a fresh family.
  const jwt = await signJwt({
    builder_id: invite.builder_id,
    audience: JwtAudience.DASHBOARD,
    user_id: userId,
    org_slug: accepted.slug,
    role: accepted.role,
    tier: accepted.tier,
  });

  try {
    await revokeJwt(context.revocationId, JwtAudience.DASHBOARD, 24 * 60 * 60);
  } catch {
    // The replacement is still coherent if revocation storage is unavailable.
  }

  log.info({ builder_id: invite.builder_id, user_id: userId }, 'invite accepted');

  const response = NextResponse.redirect(
    `${env.OAUTH_REDIRECT_BASE_URL}/o/${accepted.slug}/dashboard`,
  );
  setDashboardSessionCookies(response, {
    token: jwt,
    userId,
    orgSlug: accepted.slug,
  });
  clearPendingInviteCookie(response);
  return response;
}
