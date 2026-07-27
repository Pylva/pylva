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
  signJwt: vi.fn(),
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

vi.mock('../../src/lib/auth/jwt.js', () => ({
  signJwt: authMocks.signJwt,
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
      plan: 'pro',
      accessState: 'active',
      tier: 'pro',
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
    authMocks.signJwt.mockReset();
    authMocks.withJwtAuth.mockResolvedValue(dashboardSession());
    authMocks.requestHasActiveSession.mockReturnValue(true);
    authMocks.signJwt.mockResolvedValue('normalized-legacy-token');
  });

  it("scopes x-builder-id to the page org's membership on an x-pylva-org hit", async () => {
    authMocks.withMembership.mockResolvedValue({
      builderId: 'org-a-builder',
      role: 'member',
      plan: 'pro',
      accessState: 'active',
      entitlementSource: 'admin',
    });

    const response = await middleware(
      apiRequest('http://localhost/api/v1/costs', {
        'x-pylva-org': 'org-a',
        'x-pylva-page-session': sessionFingerprint('user-1'),
      }),
    );

    expect(authMocks.withMembership).toHaveBeenCalledWith({
      slug: 'org-a',
      userId: 'user-1',
      capability: 'product',
    });
    expect(response.headers.get('x-middleware-request-x-builder-id')).toBe('org-a-builder');
    expect(response.headers.get('x-middleware-request-x-user-role')).toBe('member');
  });

  it('remints a legacy dashboard token with normalized checkout-required claims', async () => {
    authMocks.withJwtAuth.mockResolvedValue({
      ...dashboardSession(),
      context: {
        ...dashboardSession().context,
        orgSlug: null,
      },
    });
    authMocks.withMembership.mockResolvedValue({
      builderId: 'legacy-builder',
      role: 'owner',
      plan: null,
      accessState: 'checkout_required',
      entitlementSource: null,
    });

    const response = await middleware(
      new NextRequest('http://localhost/api/v1/billing/subscription', {
        method: 'POST',
        headers: {
          'x-pylva-org': 'legacy-org',
          'x-pylva-page-session': sessionFingerprint('user-1'),
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(authMocks.signJwt).toHaveBeenCalledWith(
      expect.objectContaining({
        builder_id: 'legacy-builder',
        org_slug: 'legacy-org',
        plan: null,
        access_state: 'checkout_required',
        session_id: 'family-1',
      }),
    );
    expect(authMocks.signJwt.mock.calls[0]?.[0]).not.toHaveProperty('tier');
    expect(authMocks.setDashboardSessionCookies).toHaveBeenCalledWith(response, {
      token: 'normalized-legacy-token',
      userId: 'user-1',
      orgSlug: 'legacy-org',
    });
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
      plan: 'pro',
      accessState: 'active',
      entitlementSource: 'admin',
    });

    const response = await middleware(
      apiRequest(
        `http://localhost/api/v1/costs/stream?pylva_org=org-a&pylva_page_session=${sessionFingerprint('user-1')}`,
      ),
    );

    expect(authMocks.withMembership).toHaveBeenCalledWith({
      slug: 'org-a',
      userId: 'user-1',
      capability: 'product',
    });
    expect(response.headers.get('x-middleware-request-x-builder-id')).toBe('org-a-builder');
  });

  it.each([
    ['/api/v1/export/csv', 'GET', 'export'],
    ['/api/v1/billing/subscription', 'POST', 'platform_billing'],
    ['/api/v1/billing/invoices', 'GET', 'invoices'],
    ['/api/v1/billing/invoices/in_123', 'GET', 'invoices'],
    ['/api/v1/billing/invoices', 'POST', 'product'],
    ['/api/v1/billing/invoices/in_123/finalize', 'POST', 'product'],
    ['/api/v1/billing/invoices/in_123/void', 'POST', 'product'],
  ])('requests the %s lifecycle capability for %s', async (pathname, method, capability) => {
    authMocks.withMembership.mockResolvedValue({
      builderId: 'org-a-builder',
      role: 'owner',
      plan: null,
      accessState: 'suspended',
      entitlementSource: 'stripe',
    });

    const response = await middleware(
      new NextRequest(`http://localhost${pathname}`, {
        method,
        headers: {
          'x-pylva-org': 'org-a',
          'x-pylva-page-session': sessionFingerprint('user-1'),
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(authMocks.withMembership).toHaveBeenCalledWith({
      slug: 'org-a',
      userId: 'user-1',
      capability,
    });
  });

  it.each([
    ['/o/org-a/subscription', 'platform_billing'],
    ['/o/org-a/dashboard/billing', 'invoices'],
    ['/o/org-a/dashboard/billing/invoices/76000000-0000-4000-8000-000000000001', 'invoices'],
    ['/o/org-a/dashboard/billing/cycles/76000000-0000-4000-8000-000000000002', 'invoices'],
    ['/o/org-a/dashboard', 'product'],
    ['/o/org-a/dashboard/rules', 'product'],
  ])('requests the %s dashboard-page lifecycle capability', async (pathname, capability) => {
    authMocks.withMembership.mockResolvedValue({
      builderId: 'org-a-builder',
      role: 'owner',
      plan: null,
      accessState: 'suspended',
      entitlementSource: 'stripe',
    });

    const response = await middleware(new NextRequest(`http://localhost${pathname}`));

    expect(response.status).toBe(200);
    expect(authMocks.withMembership).toHaveBeenCalledWith({
      slug: 'org-a',
      userId: 'user-1',
      capability,
      deniedRedirect: 'https://pylva.com/o/org-a/subscription',
    });
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
