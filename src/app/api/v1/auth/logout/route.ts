// B2a — POST /api/v1/auth/logout. Revokes the current JWT (jti → Redis) and
// clears the session cookie. Always redirects to /login regardless of
// revocation success (we err on the side of logging out).

import { NextResponse, type NextRequest } from 'next/server.js';
import { clearSessionCookie, withJwtAuth } from '@/lib/auth/middleware';
import { revokeJwt } from '@/lib/auth/jwt';
import { env } from '@/lib/config';
import { JwtAudience } from '@pylva/shared';
import { withRLS } from '@/lib/db/rls';
import { auditLog } from '@/lib/auth/audit-log';
import { AuditAction } from '@/lib/audit/actions';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'auth.logout' });

export async function POST(request: NextRequest): Promise<NextResponse> {
  const authResult = await withJwtAuth(request, JwtAudience.DASHBOARD);
  // If already unauthed, still clear cookie and redirect.
  if (authResult instanceof NextResponse) {
    // 303 See Other: logout is reached via a POST form submit, so the browser
    // must follow the redirect as a GET. A default 307 would preserve the POST
    // method and re-issue POST /login (a page route with no POST handler → 405).
    const resp = NextResponse.redirect(`${env.OAUTH_REDIRECT_BASE_URL}/login`, 303);
    clearSessionCookie(resp);
    return resp;
  }

  const { context } = authResult;
  // Compute remaining token lifetime from the cookie's payload exp (fallback 24h).
  const remainingTtl = 24 * 60 * 60;
  try {
    await revokeJwt(context.revocationId, JwtAudience.DASHBOARD, remainingTtl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(
      { error: msg, revocation_id: context.revocationId },
      'JWT revoke failed — clearing cookie anyway',
    );
  }

  if (context.userId) {
    try {
      await withRLS(context.builderId, async (tx) => {
        await auditLog(tx, {
          builder_id: context.builderId,
          actor_type: 'user',
          actor_id: context.userId!,
          action: AuditAction.AUTH_LOGOUT,
          resource_type: 'user',
          resource_id: context.userId!,
        });
      });
    } catch {
      // Audit failure isn't fatal.
    }
  }

  // 303 See Other so the POST form submit redirects to /login as a GET.
  const resp = NextResponse.redirect(`${env.OAUTH_REDIRECT_BASE_URL}/login`, 303);
  clearSessionCookie(resp);
  return resp;
}
