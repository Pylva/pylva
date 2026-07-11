// Org binding for dashboard /api/v1 requests: the page's org claim
// (x-pylva-org header, or ?pylva_org= where headers are unavailable) is
// verified against the session user's memberships. A hit scopes x-builder-id
// to the page's org; a miss 403s with ORG_MISMATCH so a tab whose browser
// session was replaced by a login to another account cannot silently read or
// write the other account's data.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '@pylva/shared';
import { sessionFingerprint } from '../../src/lib/auth/session-fingerprint.js';

const testEnv = vi.hoisted(() => ({
  OAUTH_REDIRECT_BASE_URL: 'https://pylva.com',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
}));

const authMocks = vi.hoisted(() => ({
  withJwtAuth: vi.fn(),
  withMembership: vi.fn(),
  requestHasActiveSession: vi.fn(),
  setDashboardSessionCookies: vi.fn(),
}));

vi.mock('@/lib/config', () => ({ env: testEnv }));
vi.mock('../../src/lib/config.js', () => ({ env: testEnv }));

vi.mock('../../src/lib/auth/middleware.js', () => ({
  withApiKeyAuth: vi.fn(),
  withJwtAuth: authMocks.withJwtAuth,
  withRateLimit: vi.fn(async () => null),
  withMembership: authMocks.withMembership,
  requestHasActiveSession: authMocks.requestHasActiveSession,
  setDashboardSessionCookies: authMocks.setDashboardSessionCookies,
  RATE_LIMIT_PRESETS: {
    telemetry: { maxRequests: 1000, windowMs: 60_000 },
    controlPlane: { maxRequests: 100, windowMs: 60_000 },
    dashboardRead: { maxRequests: 120, windowMs: 60_000 },
    dashboardWrite: { maxRequests: 30, windowMs: 60_000 },
  },
}));

const { NextRequest, NextResponse } = await import('next/server.js');
const { middleware } = await import('../../src/middleware.js');

function dashboardSession() {
  return {
    context: {
      builderId: 'jwt-builder',
      userId: 'user-1',
      orgSlug: 'org-a',
      role: 'owner',
      tier: 'free',
      jti: 'j-1',
      revocationId: 'family-1',
    },
    refreshToken: null,
    sessionToken: 'session-token',
  };
}

function apiRequest(
  url: string,
  headers: Record<string, string> = {},
): InstanceType<typeof NextRequest> {
  return new NextRequest(url, { headers });
}

interface ErrorBody {
  error: { code: string };
}

describe('middleware org binding for dashboard /api/v1 requests', () => {
  beforeEach(() => {
    authMocks.withJwtAuth.mockReset();
    authMocks.withMembership.mockReset();
    authMocks.requestHasActiveSession.mockReset();
    authMocks.setDashboardSessionCookies.mockReset();
    authMocks.withJwtAuth.mockResolvedValue(dashboardSession());
    authMocks.requestHasActiveSession.mockReturnValue(true);
  });

  it("scopes x-builder-id to the page org's membership on an x-pylva-org hit", async () => {
    authMocks.withMembership.mockResolvedValue({
      builderId: 'org-a-builder',
      role: 'member',
      tier: 'pro',
    });

    const response = await middleware(
      apiRequest('http://localhost/api/v1/costs', {
        'x-pylva-org': 'org-a',
        'x-pylva-page-session': sessionFingerprint('user-1'),
      }),
    );

    expect(authMocks.withMembership).toHaveBeenCalledWith({ slug: 'org-a', userId: 'user-1' });
    expect(response.headers.get('x-middleware-request-x-builder-id')).toBe('org-a-builder');
    expect(response.headers.get('x-middleware-request-x-user-role')).toBe('member');
  });

  it('403s with ORG_MISMATCH when the session user has no membership in the page org', async () => {
    authMocks.withMembership.mockResolvedValue(NextResponse.json({}, { status: 404 }));

    const response = await middleware(
      apiRequest('http://localhost/api/v1/costs', {
        'x-pylva-org': 'org-b',
        'x-pylva-page-session': sessionFingerprint('user-1'),
      }),
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as ErrorBody;
    expect(body.error.code).toBe(ErrorCode.ORG_MISMATCH);
    expect(response.headers.get('x-middleware-request-x-builder-id')).toBeNull();
  });

  it('fails closed when either page selector is missing', async () => {
    const response = await middleware(apiRequest('http://localhost/api/v1/costs'));

    expect(authMocks.withMembership).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    const body = (await response.json()) as ErrorBody;
    expect(body.error.code).toBe(ErrorCode.DASHBOARD_CONTEXT_REQUIRED);
  });

  it('accepts the ?pylva_org= query param where headers are unavailable', async () => {
    authMocks.withMembership.mockResolvedValue({
      builderId: 'org-a-builder',
      role: 'owner',
      tier: 'pro',
    });

    const response = await middleware(
      apiRequest(
        `http://localhost/api/v1/costs/stream?pylva_org=org-a&pylva_page_session=${sessionFingerprint('user-1')}`,
      ),
    );

    expect(authMocks.withMembership).toHaveBeenCalledWith({ slug: 'org-a', userId: 'user-1' });
    expect(response.headers.get('x-middleware-request-x-builder-id')).toBe('org-a-builder');
  });

  it('rejects a valid shared-org request from a page owned by another user', async () => {
    const response = await middleware(
      apiRequest('http://localhost/api/v1/costs', {
        'x-pylva-org': 'org-a',
        'x-pylva-page-session': sessionFingerprint('user-2'),
      }),
    );

    expect(response.status).toBe(403);
    expect(((await response.json()) as ErrorBody).error.code).toBe(ErrorCode.SESSION_MISMATCH);
    expect(authMocks.withMembership).not.toHaveBeenCalled();
  });

  it('rejects contradictory header and query selectors', async () => {
    const fingerprint = sessionFingerprint('user-1');
    const response = await middleware(
      apiRequest(
        `http://localhost/api/v1/costs?pylva_org=org-b&pylva_page_session=${fingerprint}`,
        { 'x-pylva-org': 'org-a', 'x-pylva-page-session': fingerprint },
      ),
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as ErrorBody).error.code).toBe(
      ErrorCode.DASHBOARD_CONTEXT_REQUIRED,
    );
    expect(authMocks.withMembership).not.toHaveBeenCalled();
  });
});
