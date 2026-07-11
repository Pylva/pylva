// Regression — middleware login redirects must be built from the configured
// public origin (OAUTH_REDIRECT_BASE_URL), never from the incoming request
// host. Behind the proxy, request.url carries the server bind address
// (e.g. 0.0.0.0:3000); pre-fix, logged-out visits to dashboard deep links
// produced Location: https://0.0.0.0:3000/login?... in production.

import { describe, expect, it, vi } from 'vitest';

const testEnv = vi.hoisted(() => ({
  OAUTH_REDIRECT_BASE_URL: 'https://pylva.com',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
}));

const authMocks = vi.hoisted(() => ({
  withJwtAuth: vi.fn(),
}));

vi.mock('@/lib/config', () => ({ env: testEnv }));
vi.mock('../../src/lib/config.js', () => ({ env: testEnv }));

vi.mock('../../src/lib/auth/middleware.js', () => ({
  withApiKeyAuth: vi.fn(),
  withJwtAuth: authMocks.withJwtAuth,
  withRateLimit: vi.fn(async () => null),
  withMembership: vi.fn(),
  setRefreshCookie: vi.fn(),
  RATE_LIMIT_PRESETS: {
    telemetry: { maxRequests: 1000, windowMs: 60_000 },
    controlPlane: { maxRequests: 100, windowMs: 60_000 },
    dashboardRead: { maxRequests: 120, windowMs: 60_000 },
    dashboardWrite: { maxRequests: 30, windowMs: 60_000 },
  },
}));

const { NextRequest, NextResponse } = await import('next/server.js');
const { middleware } = await import('../../src/middleware.js');

// The bind-address host is the point of the test: it must never leak into
// the Location header.
function dashboardRequest(): InstanceType<typeof NextRequest> {
  return new NextRequest('http://0.0.0.0:3000/o/acme/dashboard');
}

describe('middleware login redirects for /o/{slug} pages', () => {
  it('redirects unauthenticated visits to the configured origin with next=', async () => {
    authMocks.withJwtAuth.mockResolvedValue(NextResponse.json({}, { status: 401 }));

    const response = await middleware(dashboardRequest());
    const location = new URL(response.headers.get('location')!);

    expect(response.status).toBe(307);
    expect(location.origin).toBe('https://pylva.com');
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('next')).toBe('/o/acme/dashboard');
  });

  it('redirects sessions without a userId to the configured origin', async () => {
    authMocks.withJwtAuth.mockResolvedValue({
      context: { builderId: 'b-1', userId: null, role: 'owner', tier: 'free', jti: 'j-1' },
      refreshToken: null,
    });

    const response = await middleware(dashboardRequest());
    const location = new URL(response.headers.get('location')!);

    expect(response.status).toBe(307);
    expect(location.origin).toBe('https://pylva.com');
    expect(location.pathname).toBe('/login');
  });
});
