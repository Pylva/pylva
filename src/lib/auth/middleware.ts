// Auth middleware — API key, JWT, rate limiting, and (B2a) role/membership.
// Decision #17: Stripe-style error responses.

import { type NextRequest, NextResponse } from 'next/server.js';
import { ErrorCode, JwtAudience, Role, type Role as RoleType } from '@pylva/shared';
import { validateApiKey } from './api-key.js';
import { assertSameOrigin } from './csrf.js';
import { verifyJwt, refreshJwtIfNeeded } from './jwt.js';
import { resolveSlugForUserCached } from './membership-cache.js';
import type { MembershipContext } from './org.js';
import {
  authError,
  forbiddenError,
  rateLimitError as rateLimitErrorResponse,
  notFoundError,
} from '../errors.js';
import { ensureRedisCommandClient, redisClient } from '../redis/client.js';
import { rateLimitBreaker } from '../redis/circuit-breaker.js';
import { env } from '../config.js';
import {
  ACTIVE_SESSION_COOKIE,
  decodeActiveSessionValue,
  encodeActiveSessionValue,
  sessionFingerprint,
} from './session-fingerprint.js';

export interface ApiKeyAuthContext {
  builderId: string;
  /** Persisted scope value — display/audit only; every valid key has universal access. */
  scope: string;
  keyId: string;
}

const MISSING_API_KEY_MESSAGE =
  'Missing API key: provide X-Pylva-Key header or Authorization: Bearer pv_(live|cli)_{keyId}_{randomPart}';

function readApiKey(request: NextRequest): string | null {
  const explicit = request.headers.get('X-Pylva-Key');
  if (explicit) return explicit;

  const authz = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(pv_(?:live|cli)_[a-f0-9]{8}_[a-f0-9]{32})$/.exec(authz);
  return match?.[1] ?? null;
}

// One universal key (migration 048): a valid key grants access to every
// machine endpoint, so there is no required-scope parameter and no
// WRONG_SCOPE path. Rows still carrying a pre-048 scope value authenticate
// the same way.
export async function withApiKeyAuth(
  request: NextRequest,
): Promise<ApiKeyAuthContext | NextResponse> {
  const key = readApiKey(request);
  if (!key) return authError(ErrorCode.INVALID_API_KEY, MISSING_API_KEY_MESSAGE);
  const result = await validateApiKey(key);
  if (!result) return authError(ErrorCode.INVALID_API_KEY, 'Invalid API key');
  return { builderId: result.builderId, scope: result.scope, keyId: result.keyId };
}

// --- JWT Auth Middleware ---

export interface JwtAuthContext {
  builderId: string;
  userId: string | null;
  orgSlug: string | null;
  role: RoleType | null;
  tier: string | null;
  jti: string;
  revocationId: string;
}

function readSessionCookie(request: NextRequest): string | null {
  // B2a SESSION_COOKIE_NAME (default pylva_session); legacy
  // pylva_token preserved for B1 routes that haven't migrated yet.
  const primary = request.cookies.get(env.SESSION_COOKIE_NAME)?.value;
  if (primary) return primary;
  const legacy = request.cookies.get('pylva_token')?.value;
  return legacy ?? null;
}

export async function withJwtAuth(
  request: NextRequest,
  expectedAudience: string,
): Promise<
  { context: JwtAuthContext; refreshToken: string | null; sessionToken: string } | NextResponse
> {
  // CSRF: reject cross-site state-changing requests on the cookie-authenticated
  // dashboard surface (portal is excluded — custom domains differ by design).
  if (expectedAudience === JwtAudience.DASHBOARD) {
    const csrf = assertSameOrigin(request);
    if (csrf) return csrf;
  }

  const token = readSessionCookie(request);
  if (!token) return authError(ErrorCode.INVALID_API_KEY, 'Missing authentication token');

  try {
    const payload = await verifyJwt(token, expectedAudience);
    const newToken = await refreshJwtIfNeeded(payload);
    return {
      context: {
        builderId: payload.builder_id,
        userId: (payload.user_id as string) ?? null,
        orgSlug: (payload.org_slug as string) ?? null,
        role: (payload.role as RoleType) ?? null,
        tier: (payload.tier as string) ?? null,
        jti: payload.jti,
        // Logout and org switching revoke the stable session family, not only
        // this refresh token's leaf jti.
        revocationId: payload.revocation_id,
      },
      refreshToken: newToken,
      sessionToken: token,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid token';
    if (message.includes('audience')) {
      return authError(ErrorCode.AUDIENCE_MISMATCH, 'Token audience mismatch');
    }
    return authError(ErrorCode.INVALID_API_KEY, message);
  }
}

/** Set sliding-window refresh token cookie on response. */
export function setRefreshCookie(response: NextResponse, token: string): void {
  response.cookies.set(env.SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.SESSION_COOKIE_SECURE && env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  });
}

/**
 * Companion cookie to the session JWT: JS-readable session fingerprint +
 * active org slug (see session-fingerprint.ts). Set at every point that
 * mints a session (login, invite accept, org switch) so open tabs can detect
 * the browser's session slot changing hands.
 */
export function setActiveSessionCookie(
  response: NextResponse,
  userId: string,
  orgSlug: string,
): void {
  response.cookies.set(ACTIVE_SESSION_COOKIE, encodeActiveSessionValue(userId, orgSlug), {
    httpOnly: false,
    secure: env.SESSION_COOKIE_SECURE && env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
  });
}

/** Emit the authenticated browser session as one coherent cookie bundle. */
export function setDashboardSessionCookies(
  response: NextResponse,
  params: { token: string; userId: string; orgSlug: string },
): void {
  setRefreshCookie(response, params.token);
  setActiveSessionCookie(response, params.userId, params.orgSlug);
}

/** Whether the request carried the marker that belongs to this JWT identity. */
export function requestHasActiveSession(
  request: NextRequest,
  userId: string,
  orgSlug: string,
): boolean {
  const marker = decodeActiveSessionValue(request.cookies.get(ACTIVE_SESSION_COOKIE)?.value);
  return marker?.fingerprint === sessionFingerprint(userId) && marker.slug === orgSlug;
}

export function clearSessionCookie(response: NextResponse): void {
  const cookieNames = new Set([env.SESSION_COOKIE_NAME, 'pylva_token', ACTIVE_SESSION_COOKIE]);
  for (const name of cookieNames) {
    response.cookies.set(name, '', {
      httpOnly: name !== ACTIVE_SESSION_COOKIE,
      secure: env.SESSION_COOKIE_SECURE && env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });
  }
}

// --- B2a: slug-membership check ---

/**
 * I-T1-9: every /o/{slug}/* request must prove the authenticated user has
 * membership in the slug's builder. On miss → 404 (don't leak existence).
 * Resolution is Redis-cached for 30s (membership-cache.ts); negatives are
 * never cached, and Redis failure falls open to the direct Postgres path.
 */
export async function withMembership(params: {
  slug: string;
  userId: string;
}): Promise<MembershipContext | NextResponse> {
  const ctx = await resolveSlugForUserCached({ slug: params.slug, userId: params.userId });
  if (!ctx) return notFoundError(ErrorCode.NOT_FOUND, 'Resource not found');
  return ctx;
}

// --- B2a: role gate ---

/**
 * I-T1-10: destructive actions are Owner-only. Wrap a dashboard-audience
 * route handler with this. Member → 403. Owner → passes.
 */
export function withRole(allowed: RoleType[], ctxRole: RoleType | null): NextResponse | null {
  if (ctxRole === null) {
    return forbiddenError(ErrorCode.INSUFFICIENT_PERMISSIONS, 'Role missing from session token');
  }
  if (!allowed.includes(ctxRole)) {
    return forbiddenError(
      ErrorCode.INSUFFICIENT_PERMISSIONS,
      `Only ${allowed.join(', ')} can perform this action`,
    );
  }
  return null;
}

// --- Rate Limiting ---

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

export const RATE_LIMIT_PRESETS = {
  telemetry: { maxRequests: 1000, windowMs: 60_000 } satisfies RateLimitConfig,
  controlPlane: { maxRequests: 100, windowMs: 60_000 } satisfies RateLimitConfig,
  // B2a D39 — dashboard reads generous, writes restricted
  dashboardRead: { maxRequests: 120, windowMs: 60_000 } satisfies RateLimitConfig,
  dashboardWrite: { maxRequests: 30, windowMs: 60_000 } satisfies RateLimitConfig,
};

export async function withRateLimit(
  key: string,
  config: RateLimitConfig,
): Promise<NextResponse | null> {
  try {
    const result = (await rateLimitBreaker.fire(async () => {
      // Middleware module graph: lazily connect (see redis/client.ts) —
      // otherwise every rate-limit call fails open against a closed client.
      await ensureRedisCommandClient();
      const now = Date.now();
      const windowKey = `rate_limit:${key}:${Math.floor(now / config.windowMs)}`;
      const multi = redisClient.multi();
      multi.incr(windowKey);
      multi.pExpire(windowKey, config.windowMs);
      const replies = await multi.exec();
      return replies[0] as unknown as number;
    })) as number | null;
    if (result === null) {
      // Breaker open / fallback: rate limiting is temporarily disabled. Log at
      // error level so this fail-open window is observable (Sentry captures
      // server console.error) rather than silently permitting unlimited traffic.
      console.error('[rate-limit] breaker open — rate limiting disabled (fail-open)');
      return null;
    }
    if (result > config.maxRequests) {
      const retryAfter = Math.ceil(config.windowMs / 1000);
      return rateLimitErrorResponse(retryAfter);
    }
    return null;
  } catch {
    console.error('[rate-limit] Redis error, allowing request (fail-open)');
    return null;
  }
}

// Re-export for readability in routes that compose withRole after withJwtAuth.
export { Role };
