import { and, eq } from 'drizzle-orm';
import { NextResponse, type NextRequest } from 'next/server.js';
import { JwtAudience } from '@pylva/shared';
import {
  requestHasActiveSession,
  setDashboardSessionCookies,
  withJwtAuth,
} from '@/lib/auth/middleware';
import { signJwt } from '@/lib/auth/jwt';
import { env } from '@/lib/config';
import { db } from '@/lib/db/client';
import { builders, userBuilderMemberships } from '@/lib/db/schema';

// Redirects must be built from the configured public origin, not request.url:
// behind the proxy the request host is the server bind address (e.g. 0.0.0.0:3000).
function redirectToLogin(): NextResponse {
  const loginUrl = new URL('/login', env.OAUTH_REDIRECT_BASE_URL);
  loginUrl.searchParams.set('next', '/settings/keys');
  return NextResponse.redirect(loginUrl);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authResult = await withJwtAuth(request, JwtAudience.DASHBOARD);
  if (authResult instanceof NextResponse) return redirectToLogin();

  const { context, refreshToken, sessionToken } = authResult;
  if (!context.userId) return redirectToLogin();

  const rows = await db
    .select({ slug: builders.slug })
    .from(builders)
    .innerJoin(userBuilderMemberships, eq(userBuilderMemberships.builder_id, builders.id))
    .where(
      and(eq(builders.id, context.builderId), eq(userBuilderMemberships.user_id, context.userId)),
    )
    .limit(1);

  const slug = rows[0]?.slug;
  if (!slug) return new NextResponse('Not found', { status: 404 });

  const response = NextResponse.redirect(
    new URL(`/o/${slug}/dashboard/settings/api-keys`, env.OAUTH_REDIRECT_BASE_URL),
  );
  let token = refreshToken;
  if (!context.orgSlug) {
    token = await signJwt({
      builder_id: context.builderId,
      audience: JwtAudience.DASHBOARD,
      session_id: context.revocationId,
      user_id: context.userId,
      org_slug: slug,
      ...(context.role ? { role: context.role } : {}),
      ...(context.tier ? { tier: context.tier } : {}),
    });
  }
  const activeSlug = context.orgSlug ?? slug;
  if (token || !requestHasActiveSession(request, context.userId, activeSlug)) {
    setDashboardSessionCookies(response, {
      token: token ?? sessionToken,
      userId: context.userId,
      orgSlug: activeSlug,
    });
  }
  return response;
}
