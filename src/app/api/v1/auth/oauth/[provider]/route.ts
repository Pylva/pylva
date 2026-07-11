// B2a — OAuth initiate. State cookie + PKCE verifier cookie + 302.
// GitHub primary (D10); Google secondary. Both providers use PKCE so the
// callback can prove it is completing the flow that this browser initiated.

import { NextResponse, type NextRequest } from 'next/server.js';
import { generateCodeVerifier } from 'arctic';
import {
  OAUTH_COOKIE_PREFIX,
  createOAuthAuthorizationUrl,
  generateOAuthState,
  oauthCookieNames,
} from '@/lib/auth/oauth';
import { OAuthProvider } from '@pylva/shared';
import { env } from '@/lib/config';
import { validationError } from '@/lib/errors';
import { validateAuthNext } from '@/lib/auth/post-auth-redirect';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
): Promise<NextResponse> {
  const { provider } = await params;
  if (provider !== OAuthProvider.GITHUB && provider !== OAuthProvider.GOOGLE) {
    return validationError('Unsupported OAuth provider', 'provider');
  }

  const next = validateAuthNext(request.nextUrl.searchParams.get('next'));
  const { raw, hmac } = generateOAuthState(next);
  const codeVerifier = generateCodeVerifier();
  const url = createOAuthAuthorizationUrl(provider, raw, codeVerifier);

  const response = NextResponse.redirect(url.toString());
  const cookieOpts = {
    httpOnly: true,
    secure: env.SESSION_COOKIE_SECURE && env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 600, // 10 min
  };
  // Per-flow names (suffixed by state digest) so two concurrent login flows
  // in one browser don't clobber each other's state/PKCE. Flow cookies expire
  // in 10 min, so accumulation is bounded to flows started within that
  // window; past 5 pending flows (3 cookies each) sweep them ALL as a
  // header-bloat backstop. The sweep can't tell fresh flows from stale ones
  // (no age in the name), so it deliberately trades the pathological case —
  // 6+ logins started inside 10 minutes — for a clean slate; the swept flows
  // fail with oauth_state_mismatch and a retry succeeds.
  const existingFlowCookies = request.cookies
    .getAll()
    .filter((cookie) => cookie.name.startsWith(OAUTH_COOKIE_PREFIX));
  if (existingFlowCookies.length >= 15) {
    for (const cookie of existingFlowCookies) {
      response.cookies.set(cookie.name, '', { path: '/', maxAge: 0 });
    }
  }
  const names = oauthCookieNames(raw);
  response.cookies.set(names.state, raw, cookieOpts);
  response.cookies.set(names.nonce, hmac, cookieOpts);
  response.cookies.set(names.pkce, codeVerifier, cookieOpts);
  return response;
}
