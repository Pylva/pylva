// B2a — OAuth callback. Verify state HMAC → exchange code → fetch profile →
// upsert user → find/create builder+owner membership → JWT + cookie → redirect
// to /o/{slug}/dashboard.

import { NextResponse, type NextRequest } from 'next/server.js';
import {
  OAUTH_NONCE_COOKIE,
  OAUTH_PKCE_COOKIE,
  OAUTH_STATE_COOKIE,
  exchangeOAuthCode,
  oauthCookieNames,
  upsertUserFromOAuth,
  verifyOAuthState,
} from '@/lib/auth/oauth';
import { findOrCreateBuilderForUser, resolveSlugForUser } from '@/lib/auth/org';
import { signJwt } from '@/lib/auth/jwt';
import { setDashboardSessionCookies } from '@/lib/auth/middleware';
import { env } from '@/lib/config';
import { validationError } from '@/lib/errors';
import { JwtAudience, OAuthProvider } from '@pylva/shared';
import { logger } from '@/lib/logger';
import { auditLog } from '@/lib/auth/audit-log';
import { AuditAction } from '@/lib/audit/actions';
import { withRLS } from '@/lib/db/rls';
import { externalFetch } from '@/lib/external-egress';
import {
  buildPostAuthRedirectUrl,
  decodeOAuthStateNext,
  nextPathOrgSlug,
  type AllowedAuthNextPath,
} from '@/lib/auth/post-auth-redirect';
import { safeErrorMetadata } from '@/lib/safe-error-metadata';
import { readPendingInviteToken } from '@/lib/auth/pending-invite';

const log = logger.child({ module: 'auth.oauth.callback' });
const GITHUB_REST_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'Pylva',
  'X-GitHub-Api-Version': '2022-11-28',
};

type OAuthStage =
  | 'token_exchange'
  | 'profile_fetch'
  | 'user_upsert'
  | 'org_create'
  | 'jwt_sign'
  | 'audit_log';

interface GitHubProfile {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
}

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

interface GoogleProfile {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  picture?: string;
}

async function fetchGitHubProfile(
  accessToken: string,
): Promise<{ email: string; name: string | null; avatar: string | null }> {
  const userRes = await externalFetch({
    target: 'github',
    url: 'https://api.github.com/user',
    headers: { ...GITHUB_REST_HEADERS, Authorization: `Bearer ${accessToken}` },
  });
  if (userRes.status < 200 || userRes.status >= 300)
    throw new Error(`github /user: ${userRes.status}`);
  const user = JSON.parse(userRes.body) as GitHubProfile;

  // `/user.email` is only the public profile field and carries no verification
  // bit. Never use it for identity linking: legacy builder adoption grants the
  // matching email owner access. The OAuth flow requests `user:email`, so always
  // select from the endpoint that explicitly reports `verified`.
  const emailsRes = await externalFetch({
    target: 'github',
    url: 'https://api.github.com/user/emails',
    headers: { ...GITHUB_REST_HEADERS, Authorization: `Bearer ${accessToken}` },
  });
  if (emailsRes.status < 200 || emailsRes.status >= 300) {
    throw new Error(`github /user/emails: ${emailsRes.status}`);
  }
  const emails = JSON.parse(emailsRes.body) as GitHubEmail[];
  const verified = Array.isArray(emails)
    ? (emails.find((e) => e.primary === true && e.verified === true) ??
      emails.find((e) => e.verified === true))
    : undefined;
  if (!verified || typeof verified.email !== 'string' || verified.email.length === 0) {
    throw new Error('github profile missing verified email');
  }
  return { email: verified.email, name: user.name ?? user.login, avatar: user.avatar_url };
}

async function fetchGoogleProfile(
  accessToken: string,
): Promise<{ email: string; name: string | null; avatar: string | null }> {
  const res = await externalFetch({
    target: 'google_oauth',
    url: 'https://openidconnect.googleapis.com/v1/userinfo',
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`google /userinfo: ${res.status}`);
  const p = JSON.parse(res.body) as GoogleProfile;
  if (!p.email_verified) throw new Error('google email not verified');
  return { email: p.email, name: p.name ?? null, avatar: p.picture ?? null };
}

// Clear THIS flow's suffixed triplet plus the legacy fixed names — never
// other flows' cookies: a concurrent login sitting on the provider's
// authorize page must survive this callback completing (that isolation is
// the whole point of per-flow cookies). Abandoned flows expire via their
// 10-min maxAge; the initiate route additionally caps accumulation.
function clearOAuthCookies(response: NextResponse, stateRaw: string | null): void {
  const names = new Set<string>([OAUTH_STATE_COOKIE, OAUTH_NONCE_COOKIE, OAUTH_PKCE_COOKIE]);
  if (stateRaw) {
    const flow = oauthCookieNames(stateRaw);
    names.add(flow.state);
    names.add(flow.nonce);
    names.add(flow.pkce);
  }
  for (const name of names) {
    response.cookies.set(name, '', { path: '/', maxAge: 0 });
  }
}

function redirectLogin(error: string): NextResponse {
  return NextResponse.redirect(`${env.OAUTH_REDIRECT_BASE_URL}/login?error=${error}`);
}

function logOAuthFailure(provider: string, stage: OAuthStage, err: unknown): void {
  log.warn({ provider, stage, ...safeErrorMetadata(err) }, 'oauth callback failed');
}

function logOAuthAuditFailure(provider: string, err: unknown): void {
  log.warn(
    { provider, stage: 'audit_log', ...safeErrorMetadata(err) },
    'oauth audit log failed after session creation',
  );
}

function failOAuth(
  stateRaw: string | null,
  provider: string,
  stage: OAuthStage,
  err: unknown,
): NextResponse {
  logOAuthFailure(provider, stage, err);
  const response = redirectLogin('oauth_failed');
  clearOAuthCookies(response, stateRaw);
  return response;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
): Promise<NextResponse> {
  const { provider } = await params;
  if (provider !== OAuthProvider.GITHUB && provider !== OAuthProvider.GOOGLE) {
    return validationError('Unsupported OAuth provider', 'provider');
  }

  const { searchParams } = new URL(request.url);
  const providerError = searchParams.get('error');
  if (providerError) {
    const response = redirectLogin(
      providerError === 'access_denied' ? 'oauth_denied' : 'oauth_failed',
    );
    clearOAuthCookies(response, searchParams.get('state'));
    return response;
  }

  const code = searchParams.get('code');
  const state = searchParams.get('state');
  if (!code) return validationError('Missing authorization code', 'code');
  if (!state) return validationError('Missing OAuth state', 'state');

  // Per-flow cookies keyed by the returned state; legacy fixed names read as
  // fallback so a flow initiated just before deploy still completes.
  const names = oauthCookieNames(state);
  const cookieState =
    request.cookies.get(names.state)?.value ?? request.cookies.get(OAUTH_STATE_COOKIE)?.value;
  const cookieHmac =
    request.cookies.get(names.nonce)?.value ?? request.cookies.get(OAUTH_NONCE_COOKIE)?.value;
  if (!cookieState || !cookieHmac || cookieState !== state) {
    return redirectLogin('oauth_state_mismatch');
  }
  if (!verifyOAuthState(cookieState, cookieHmac)) {
    return redirectLogin('oauth_state_invalid');
  }

  const pkce =
    request.cookies.get(names.pkce)?.value ?? request.cookies.get(OAUTH_PKCE_COOKIE)?.value;
  if (!pkce) {
    return redirectLogin('oauth_state_mismatch');
  }

  try {
    const tokens = await exchangeOAuthCode(provider, code, pkce);
    const accessToken = tokens.accessToken();
    return continueOAuthCallback(
      state,
      provider,
      accessToken,
      decodeOAuthStateNext(cookieState),
      readPendingInviteToken(request),
    );
  } catch (err) {
    return failOAuth(state, provider, 'token_exchange', err);
  }
}

async function continueOAuthCallback(
  stateRaw: string,
  provider: OAuthProvider,
  accessToken: string,
  next: AllowedAuthNextPath | null,
  pendingInviteToken: string | null,
): Promise<NextResponse> {
  let profile: { email: string; name: string | null; avatar: string | null };
  try {
    profile =
      provider === OAuthProvider.GITHUB
        ? await fetchGitHubProfile(accessToken)
        : await fetchGoogleProfile(accessToken);
  } catch (err) {
    return failOAuth(stateRaw, provider, 'profile_fetch', err);
  }

  let upsert;
  try {
    upsert = await upsertUserFromOAuth({
      email: profile.email,
      displayName: profile.name,
      avatarUrl: profile.avatar,
      provider,
    });
  } catch (err) {
    return failOAuth(stateRaw, provider, 'user_upsert', err);
  }

  let org;
  try {
    org = await findOrCreateBuilderForUser({
      userId: upsert.userId,
      email: profile.email,
      displayName: profile.name,
      avatarUrl: profile.avatar,
    });
  } catch (err) {
    return failOAuth(stateRaw, provider, 'org_create', err);
  }

  // `next` restore: if the user was bounced off a page in an org other than
  // their default, and they hold membership there, mint the session for THAT
  // org so the redirect lands where they left off. Non-members silently fall
  // back to the default org (buildPostAuthRedirectUrl drops the mismatched
  // next), so this can't be used to probe org membership.
  let target = { builderId: org.builderId, slug: org.slug, role: org.role, tier: org.tier };
  if (next) {
    const nextSlug = nextPathOrgSlug(next);
    if (nextSlug !== org.slug) {
      try {
        const membership = await resolveSlugForUser({ slug: nextSlug, userId: upsert.userId });
        if (membership) {
          target = {
            builderId: membership.builderId,
            slug: nextSlug,
            role: membership.role,
            tier: membership.tier,
          };
        }
      } catch (err) {
        // Non-fatal: fall back to the default org.
        logOAuthFailure(provider, 'org_create', err);
      }
    }
  }

  let jwt: string;
  try {
    jwt = await signJwt({
      builder_id: target.builderId,
      audience: JwtAudience.DASHBOARD,
      user_id: upsert.userId,
      org_slug: target.slug,
      role: target.role,
      tier: target.tier,
    });
  } catch (err) {
    return failOAuth(stateRaw, provider, 'jwt_sign', err);
  }

  try {
    // Log against the builder the session was actually minted for.
    await withRLS(target.builderId, async (tx) => {
      await auditLog(tx, {
        builder_id: target.builderId,
        actor_type: 'user',
        actor_id: upsert.userId,
        action: AuditAction.AUTH_LOGIN,
        resource_type: 'user',
        resource_id: upsert.userId,
        details: { provider, is_new_user: upsert.isNew, is_new_builder: org.isNew },
      });
      if (upsert.previousAuthProvider && upsert.previousAuthProvider !== `oauth_${provider}`) {
        await auditLog(tx, {
          builder_id: target.builderId,
          actor_type: 'user',
          actor_id: upsert.userId,
          action: AuditAction.AUTH_OAUTH_LINKED,
          resource_type: 'user',
          resource_id: upsert.userId,
          details: { provider, previous: upsert.previousAuthProvider },
        });
      }
    });
  } catch (err) {
    logOAuthAuditFailure(provider, err);
  }

  const redirectUrl = pendingInviteToken
    ? `${env.OAUTH_REDIRECT_BASE_URL}/api/v1/invites/accept`
    : buildPostAuthRedirectUrl({
        baseUrl: env.OAUTH_REDIRECT_BASE_URL,
        orgSlug: target.slug,
        next,
      });
  const response = NextResponse.redirect(redirectUrl);
  setDashboardSessionCookies(response, {
    token: jwt,
    userId: upsert.userId,
    orgSlug: target.slug,
  });
  clearOAuthCookies(response, stateRaw);
  return response;
}
