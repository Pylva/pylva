import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server.js';
import { JwtAudience } from '@pylva/shared';

// Regression: the dashboard "Sign out" control is an HTML <form method="post">,
// so the browser FOLLOWS the logout route's redirect. A default 307 redirect
// preserves the POST method and re-issues POST /login — a page route with no
// POST handler → 405. The logout route must reply 303 (See Other) so the
// browser navigates to /login as a GET.

const mocks = vi.hoisted(() => ({
  withJwtAuth: vi.fn(),
  clearSessionCookie: vi.fn(),
  revokeJwt: vi.fn(),
  withRLS: vi.fn(),
  auditLog: vi.fn(),
  warn: vi.fn(),
}));

const testEnv = vi.hoisted(() => ({
  NODE_ENV: 'production',
  LOG_LEVEL: 'silent',
  OAUTH_REDIRECT_BASE_URL: 'https://app.example.com',
}));

vi.mock('@/lib/config', () => ({ env: testEnv }));
vi.mock('../../src/lib/config.js', () => ({ env: testEnv }));

vi.mock('@/lib/auth/middleware', () => ({
  withJwtAuth: mocks.withJwtAuth,
  clearSessionCookie: mocks.clearSessionCookie,
}));

vi.mock('@/lib/auth/jwt', () => ({
  revokeJwt: mocks.revokeJwt,
}));

vi.mock('@/lib/db/rls', () => ({
  withRLS: mocks.withRLS,
}));

vi.mock('@/lib/auth/audit-log', () => ({
  auditLog: mocks.auditLog,
}));

vi.mock('@/lib/logger', () => ({
  logger: { child: () => ({ warn: mocks.warn }) },
}));

const { POST } = await import('../../src/app/api/v1/auth/logout/route.js');

function logoutRequest(): NextRequest {
  return {
    url: 'https://app.example.com/api/v1/auth/logout',
    method: 'POST',
  } as unknown as NextRequest;
}

describe('POST /api/v1/auth/logout redirect status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses 303 (not 307) when the session is already unauthenticated', async () => {
    // withJwtAuth returns a NextResponse to signal the request is unauthed.
    mocks.withJwtAuth.mockResolvedValue(
      NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
    );

    const res = await POST(logoutRequest());

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://app.example.com/login');
    expect(mocks.clearSessionCookie).toHaveBeenCalledTimes(1);
  });

  it('uses 303 (not 307) on the normal authenticated logout path', async () => {
    mocks.withJwtAuth.mockResolvedValue({
      context: {
        jti: 'rotated-jti',
        revocationId: 'session-root',
        userId: 'user-1',
        builderId: 'builder-1',
      },
    });
    mocks.revokeJwt.mockResolvedValue(undefined);
    mocks.withRLS.mockImplementation(
      async (_builderId: string, fn: (tx: unknown) => Promise<unknown>) => fn({}),
    );
    mocks.auditLog.mockResolvedValue(undefined);

    const res = await POST(logoutRequest());

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://app.example.com/login');
    expect(mocks.revokeJwt).toHaveBeenCalledTimes(1);
    expect(mocks.revokeJwt).toHaveBeenCalledWith(
      'session-root',
      JwtAudience.DASHBOARD,
      24 * 60 * 60,
    );
    expect(mocks.clearSessionCookie).toHaveBeenCalledTimes(1);
  });
});
