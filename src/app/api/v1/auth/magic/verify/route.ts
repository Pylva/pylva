// B2a — GET /api/v1/auth/magic/verify?token=...
// Atomic GETDEL on Redis (I-T1-5), upsert user, find/create builder+owner
// membership, sign JWT, set cookie, 302 /o/{slug}/dashboard.
// Fail-closed on Redis outage → 503 (D13).

import { NextResponse, type NextRequest } from 'next/server.js';
import { AuthDegraded, consumeMagicToken } from '@/lib/auth/magic-link';
import { findOrCreateBuilderForUser, resolveSlugForUser } from '@/lib/auth/org';
import { signJwt } from '@/lib/auth/jwt';
import { setDashboardSessionCookies } from '@/lib/auth/middleware';
import { withRLS } from '@/lib/db/rls';
import { auditLog } from '@/lib/auth/audit-log';
import { AuditAction } from '@/lib/audit/actions';
import { env } from '@/lib/config';
import { JwtAudience } from '@pylva/shared';
import { apiError } from '@/lib/errors';
import { ErrorCode } from '@pylva/shared';
import { logger } from '@/lib/logger';
import {
  buildPostAuthRedirectUrl,
  nextPathOrgSlug,
  validateAuthNext,
} from '@/lib/auth/post-auth-redirect';
import { safeErrorMetadata } from '@/lib/safe-error-metadata';
import { setPendingInviteCookie } from '@/lib/auth/pending-invite';

const log = logger.child({ module: 'auth.magic.verify' });

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token');
  if (!token) {
    return NextResponse.redirect(`${env.OAUTH_REDIRECT_BASE_URL}/login?error=magic_missing_token`);
  }

  try {
    const result = await consumeMagicToken(token);
    if (!result) {
      // Expired or already-used.
      return NextResponse.redirect(`${env.OAUTH_REDIRECT_BASE_URL}/login?error=magic_expired`);
    }

    const org = await findOrCreateBuilderForUser({
      userId: result.userId,
      email: result.email,
      displayName: null,
      avatarUrl: null,
    });

    // Same next-org override as the OAuth callback: land the user back in the
    // org they were bounced out of, provided they hold membership there.
    let target = { builderId: org.builderId, slug: org.slug, role: org.role, tier: org.tier };
    const next = validateAuthNext(result.next);
    if (next) {
      const nextSlug = nextPathOrgSlug(next);
      if (nextSlug !== org.slug) {
        // Non-fatal: the one-time token is already consumed, so a transient
        // lookup failure must degrade to the default org, not fail the login.
        try {
          const membership = await resolveSlugForUser({ slug: nextSlug, userId: result.userId });
          if (membership) {
            target = {
              builderId: membership.builderId,
              slug: nextSlug,
              role: membership.role,
              tier: membership.tier,
            };
          }
        } catch (err) {
          log.warn(safeErrorMetadata(err), 'magic verify next-org lookup failed — using default');
        }
      }
    }

    const jwt = await signJwt({
      builder_id: target.builderId,
      audience: JwtAudience.DASHBOARD,
      user_id: result.userId,
      org_slug: target.slug,
      role: target.role,
      tier: target.tier,
    });

    await withRLS(target.builderId, async (tx) => {
      await auditLog(tx, {
        builder_id: target.builderId,
        actor_type: 'user',
        actor_id: result.userId,
        action: AuditAction.AUTH_MAGIC_LINK_SENT,
        resource_type: 'user',
        resource_id: result.userId,
        details: { is_new_user: result.isNewUser, is_new_builder: org.isNew },
      });
    });

    const response = NextResponse.redirect(
      result.pendingInviteToken
        ? `${env.OAUTH_REDIRECT_BASE_URL}/api/v1/invites/accept`
        : buildPostAuthRedirectUrl({
            baseUrl: env.OAUTH_REDIRECT_BASE_URL,
            orgSlug: target.slug,
            next,
          }),
    );
    setDashboardSessionCookies(response, {
      token: jwt,
      userId: result.userId,
      orgSlug: target.slug,
    });
    if (result.pendingInviteToken) {
      setPendingInviteCookie(response, result.pendingInviteToken);
    }
    return response;
  } catch (err) {
    if (err instanceof AuthDegraded) {
      // I-T1-5 fail-closed on Redis outage.
      return apiError(503, 'api_error', ErrorCode.INTERNAL_ERROR, 'auth service degraded');
    }
    log.warn(safeErrorMetadata(err), 'magic verify failed');
    return NextResponse.redirect(`${env.OAUTH_REDIRECT_BASE_URL}/login?error=magic_failed`);
  }
}
