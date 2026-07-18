// Next.js Middleware — route-level auth dispatch.
// B2a: adds /api/v1/auth/* public routes, /api/v1/invites/accept public,
// and /o/{slug}/* membership-check + header injection.

import { NextResponse, type NextRequest } from 'next/server.js';
import { ErrorCode, JwtAudience } from '@pylva/shared';
import {
  withApiKeyAuth,
  withJwtAuth,
  withRateLimit,
  requestHasActiveSession,
  setDashboardSessionCookies,
  RATE_LIMIT_PRESETS,
  withMembership,
  type RateLimitConfig,
} from './lib/auth/middleware.js';
import { signJwt } from './lib/auth/jwt.js';
import {
  ORG_HEADER,
  ORG_QUERY_PARAM,
  PAGE_SESSION_HEADER,
  PAGE_SESSION_QUERY_PARAM,
} from './lib/dashboard/request-context.js';
import { SESSION_FINGERPRINT_PATTERN, sessionFingerprint } from './lib/auth/session-fingerprint.js';
import { env } from './lib/config.js';
import { apiError, forbiddenError } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { isAuthoritativeBudgetControlPath } from './lib/budget-control/public-paths.js';

const log = logger.child({ module: 'middleware.dashboard' });

// Trusted context headers. These carry the verified tenant/identity that route
// handlers and RSC pages use to scope every query (RLS `app.builder_id`).
// Because they confer authority, they MUST be derived from the verified session
// — never accepted from the client.
const TRUSTED_CONTEXT_HEADERS = [
  'x-builder-id',
  'x-key-id',
  'x-user-id',
  'x-user-role',
  'x-pathname',
  ORG_HEADER,
  PAGE_SESSION_HEADER,
] as const;

type JwtAuthSuccess = Exclude<Awaited<ReturnType<typeof withJwtAuth>>, NextResponse>;

function dashboardContextError(message: string): NextResponse {
  return apiError(400, 'invalid_request_error', ErrorCode.DASHBOARD_CONTEXT_REQUIRED, message);
}

function readPageClaim(
  request: NextRequest,
  headerName: string,
  queryName: string,
): { value: string | null; contradictory: boolean } {
  const header = request.headers.get(headerName);
  const query = request.nextUrl.searchParams.get(queryName);
  return {
    value: header ?? query,
    contradictory: header !== null && query !== null && header !== query,
  };
}

function readDashboardPageContext(
  request: NextRequest,
  authenticatedUserId: string | null,
): { orgSlug: string; pageSession: string } | NextResponse {
  const org = readPageClaim(request, ORG_HEADER, ORG_QUERY_PARAM);
  const pageSession = readPageClaim(request, PAGE_SESSION_HEADER, PAGE_SESSION_QUERY_PARAM);
  if (org.contradictory || pageSession.contradictory || !org.value || !pageSession.value) {
    return dashboardContextError('Dashboard request context is missing or contradictory');
  }
  if (!authenticatedUserId || !SESSION_FINGERPRINT_PATTERN.test(pageSession.value)) {
    return forbiddenError(
      ErrorCode.SESSION_MISMATCH,
      'The active session no longer matches this dashboard page',
    );
  }
  if (pageSession.value !== sessionFingerprint(authenticatedUserId)) {
    return forbiddenError(
      ErrorCode.SESSION_MISMATCH,
      'The active session no longer matches this dashboard page',
    );
  }
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(org.value)) {
    return forbiddenError(
      ErrorCode.ORG_MISMATCH,
      'The active session does not have access to this organization',
    );
  }
  return { orgSlug: org.value, pageSession: pageSession.value };
}

async function synchronizeDashboardSession(
  response: NextResponse,
  request: NextRequest,
  authResult: JwtAuthSuccess,
  resolved: {
    builderId: string;
    role: (typeof authResult.context)['role'];
    tier: string;
    slug: string;
  },
): Promise<void> {
  const userId = authResult.context.userId;
  if (!userId) return;

  let orgSlug = authResult.context.orgSlug;
  let token = authResult.refreshToken;
  if (!orgSlug) {
    // Deploy transition: mint the legacy token into the same revocation family
    // with an explicit active org, then emit JWT + marker as one bundle.
    orgSlug = resolved.slug;
    token = await signJwt({
      builder_id: resolved.builderId,
      audience: JwtAudience.DASHBOARD,
      session_id: authResult.context.revocationId,
      user_id: userId,
      org_slug: orgSlug,
      ...(resolved.role ? { role: resolved.role } : {}),
      tier: resolved.tier,
    });
  }

  if (token || !requestHasActiveSession(request, userId, orgSlug)) {
    setDashboardSessionCookies(response, {
      token: token ?? authResult.sessionToken,
      userId,
      orgSlug,
    });
  }
}

/**
 * Build the `NextResponse.next()` that forwards the request to the route
 * handler, injecting the verified context as **request** headers.
 *
 * Two correctness/security invariants enforced here:
 *  1. Request-header injection MUST go through `NextResponse.next({ request: {
 *     headers } })`. Setting headers via `response.headers.set(...)` produces a
 *     *response* header (visible to the client, invisible to the handler) — the
 *     handler would then read the client-supplied request header instead, so a
 *     caller could spoof `x-builder-id` and read/write another tenant's data
 *     (cross-tenant RLS escape / IDOR).
 *  2. Any inbound copy of a trusted header is stripped before injecting the
 *     authoritative value, applied even on public passthrough routes (defense
 *     in depth), so the trusted set can never be spoofed.
 */
function nextWithContext(
  request: NextRequest,
  context: Record<string, string | undefined> = {},
): NextResponse {
  const requestHeaders = new Headers(request.headers);
  // Anti-spoofing: drop any client-supplied trusted headers first.
  for (const header of TRUSTED_CONTEXT_HEADERS) requestHeaders.delete(header);
  requestHeaders.set('x-pathname', request.nextUrl.pathname);
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined) requestHeaders.set(key, value);
  }
  return NextResponse.next({ request: { headers: requestHeaders } });
}

// One universal key (migration 048): every machine endpoint accepts any valid
// key. Route groups differ only by rate-limit bucket — prefixes are kept
// distinct so control-plane spam can't starve ingest for the same key.
async function handleApiKeyAuth(
  request: NextRequest,
  rateKeyPrefix: string,
  preset: RateLimitConfig,
  noStoreResponse = false,
): Promise<NextResponse> {
  const authResult = await withApiKeyAuth(request);
  if (authResult instanceof NextResponse) {
    if (noStoreResponse) authResult.headers.set('Cache-Control', 'no-store');
    return authResult;
  }

  const rateLimitResult = await withRateLimit(`${rateKeyPrefix}:${authResult.keyId}`, preset);
  if (rateLimitResult) {
    if (noStoreResponse) rateLimitResult.headers.set('Cache-Control', 'no-store');
    return rateLimitResult;
  }

  const response = nextWithContext(request, {
    'x-builder-id': authResult.builderId,
    'x-key-id': authResult.keyId,
  });
  if (noStoreResponse) response.headers.set('Cache-Control', 'no-store');
  return response;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Public health + liveness checks. /api/v1/livez is the ECS probe
  // target: /api/v1/health 503s while ClickHouse is deferred (T#8).
  if (pathname === '/api/v1/health' || pathname === '/api/v1/livez')
    return nextWithContext(request);

  // Cron endpoints authenticate inside the route (CRON_SECRET).
  if (pathname.startsWith('/api/cron/')) return nextWithContext(request);

  // v1.1 follow-up: portal CSP. The portal page itself runs token
  // verification + customer-scoped data load; here we set a per-builder
  // frame-ancestors header derived from portal_configs.allowed_iframe_origins.
  // Lookup is cached in Redis with 60s TTL. Fails open to 'self'.
  if (pathname.startsWith('/portal') || pathname.startsWith('/api/portal/')) {
    const { buildPortalFrameAncestors } = await import('./lib/portal/iframe-csp.js');
    const url = new URL(request.url);
    const headerToken = (request.headers.get('authorization') ?? '')
      .toLowerCase()
      .startsWith('bearer ')
      ? (request.headers.get('authorization') ?? '').slice(7).trim()
      : null;
    const token = url.searchParams.get('token') ?? headerToken;
    const directive = await buildPortalFrameAncestors(token);
    const response = nextWithContext(request);
    response.headers.set('Content-Security-Policy', directive);
    response.headers.set('Referrer-Policy', 'no-referrer');
    // Token-scoped customer data must never enter a search index.
    response.headers.set('X-Robots-Tag', 'noindex');
    return response;
  }

  // B2a — public auth entry points (OAuth initiate + callback, magic-link,
  // invite accept). These mint / consume sessions themselves.
  // B2b — inbound Stripe Connect webhooks (Stripe signature is the auth; JWT
  // is not available on server-to-server calls from Stripe).
  if (
    pathname.startsWith('/api/v1/auth/oauth/') ||
    pathname === '/api/v1/auth/logout' ||
    pathname === '/api/v1/auth/magic/request' ||
    pathname === '/api/v1/auth/magic/verify' ||
    pathname === '/api/v1/invites/accept' ||
    pathname === '/api/v1/billing/webhooks'
  ) {
    return nextWithContext(request);
  }

  // Authoritative reserve/commit/release/extend and capability discovery are
  // always SDK API-key surfaces. Authentication is intentionally independent
  // of the rollout flag: disabled routes must still never fall through to the
  // dashboard JWT branch. A dedicated prefix isolates control traffic from
  // telemetry for the same universal API key.
  if (isAuthoritativeBudgetControlPath(pathname)) {
    return handleApiKeyAuth(request, 'budget_control', RATE_LIMIT_PRESETS.budgetControl, true);
  }

  // SDK-facing routes (per-keyId rate limit — spec §4.10).
  // B2a: GET /api/v1/rules remains SDK-accessible; POST/PUT/DELETE routes
  // to dashboard JWT below.
  if (
    pathname === '/api/v1/events' ||
    (pathname === '/api/v1/rules' && request.method === 'GET') ||
    pathname === '/api/v1/pricing' ||
    pathname === '/api/v1/budget/sync' ||
    pathname === '/api/v1/whoami' ||
    pathname === '/api/v1/sdk/non-llm-policy' ||
    pathname === '/api/v1/sdk/non-llm-discoveries'
  ) {
    return handleApiKeyAuth(request, 'agent_sdk', RATE_LIMIT_PRESETS.telemetry);
  }

  if (pathname.startsWith('/api/v1/custom-pricing')) {
    return handleApiKeyAuth(request, 'admin_api', RATE_LIMIT_PRESETS.controlPlane);
  }

  // POST /api/v1/cost-sources — machine callers use an API key via either
  // auth header (SDKs send X-Pylva-Key, the CLI sends Bearer); browser calls
  // send neither and fall through to dashboard JWT below.
  if (pathname === '/api/v1/cost-sources' && request.method === 'POST') {
    const authz = request.headers.get('authorization') ?? '';
    const hasMachineKey =
      request.headers.get('X-Pylva-Key') !== null || authz.startsWith('Bearer pv_');
    if (hasMachineKey) {
      return handleApiKeyAuth(request, 'data_import', RATE_LIMIT_PRESETS.controlPlane);
    }
  }

  // Dashboard JWT auth for all other /api/v1/* routes.
  if (pathname.startsWith('/api/v1/')) {
    const authResult = await withJwtAuth(request, JwtAudience.DASHBOARD);
    if (authResult instanceof NextResponse) return authResult;

    // Rate-limit before either narrowing claim can trigger a membership lookup.
    const rateLimitResult = await withRateLimit(
      `dashboard:${authResult.context.builderId}`,
      RATE_LIMIT_PRESETS.controlPlane,
    );
    if (rateLimitResult) return rateLimitResult;

    // Both claims only narrow authority. The page fingerprint prevents a stale
    // tab from acting as another user who happens to share the same org; the
    // membership lookup is the authoritative builder/role source.
    const pageContext = readDashboardPageContext(request, authResult.context.userId);
    if (pageContext instanceof NextResponse) return pageContext;
    const membership = authResult.context.userId
      ? await withMembership({ slug: pageContext.orgSlug, userId: authResult.context.userId })
      : null;
    if (membership === null || membership instanceof NextResponse) {
      return forbiddenError(
        ErrorCode.ORG_MISMATCH,
        'The active session does not have access to this organization',
      );
    }

    const response = nextWithContext(request, {
      'x-builder-id': membership.builderId,
      'x-user-id': authResult.context.userId ?? undefined,
      'x-user-role': membership.role,
      [ORG_HEADER]: pageContext.orgSlug,
      [PAGE_SESSION_HEADER]: pageContext.pageSession,
    });
    await synchronizeDashboardSession(response, request, authResult, {
      ...membership,
      slug: pageContext.orgSlug,
    });
    return response;
  }

  // B2a — dashboard pages. /o/{slug}/... requires an authenticated session
  // + membership in the slug-resolved builder.
  const slugMatch = /^\/o\/([^/]+)\/.*/.exec(pathname);
  if (slugMatch) {
    const slug = slugMatch[1]!;
    const authStart = performance.now();
    const authResult = await withJwtAuth(request, JwtAudience.DASHBOARD);
    const authMs = performance.now() - authStart;
    if (authResult instanceof NextResponse) {
      // Base the redirect on the configured public origin: request.url carries
      // the server bind host (e.g. 0.0.0.0:3000) behind the proxy.
      const loginUrl = new URL('/login', env.OAUTH_REDIRECT_BASE_URL);
      loginUrl.searchParams.set('next', pathname);
      return NextResponse.redirect(loginUrl);
    }
    const { context } = authResult;
    if (!context.userId) {
      return NextResponse.redirect(new URL('/login', env.OAUTH_REDIRECT_BASE_URL));
    }

    const membershipStart = performance.now();
    const membership = await withMembership({ slug, userId: context.userId });
    const membershipMs = performance.now() - membershipStart;
    if (membership instanceof NextResponse) {
      // I-T1-9: 404 on miss (don't leak org existence).
      return NextResponse.rewrite(new URL('/404', request.url), {
        status: 404,
      });
    }

    const response = nextWithContext(request, {
      'x-builder-id': membership.builderId,
      'x-user-id': context.userId,
      'x-user-role': membership.role,
    });
    // Launch perf: middleware cost per dashboard navigation, visible in
    // browser devtools (Server-Timing) and pino logs. membership;dur ≈ 0-2ms
    // on cache hits vs a Postgres round trip on misses.
    response.headers.set(
      'Server-Timing',
      `auth;dur=${authMs.toFixed(1)}, membership;dur=${membershipMs.toFixed(1)}`,
    );
    log.info(
      {
        pathname,
        auth_ms: Math.round(authMs),
        membership_ms: Math.round(membershipMs),
      },
      'dashboard nav',
    );
    await synchronizeDashboardSession(response, request, authResult, {
      ...membership,
      slug,
    });
    return response;
  }

  return nextWithContext(request);
}

export const config = {
  matcher: [
    '/api/v1/:path*',
    '/api/cron/:path*',
    '/o/:slug/:path*',
    '/portal/:path*',
    '/api/portal/:path*',
  ],
  runtime: 'nodejs',
};
