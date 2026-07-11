import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server.js';

const testEnv = vi.hoisted(() => ({
  OAUTH_REDIRECT_BASE_URL: 'https://pylva.com',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
}));

const mocks = vi.hoisted(() => ({
  withJwtAuth: vi.fn(),
  requestHasActiveSession: vi.fn(),
  setDashboardSessionCookies: vi.fn(),
  signJwt: vi.fn(),
  select: vi.fn(),
  from: vi.fn(),
  innerJoin: vi.fn(),
  where: vi.fn(),
  limit: vi.fn(),
}));

vi.mock('@/lib/config', () => ({ env: testEnv }));
vi.mock('../../src/lib/config.js', () => ({ env: testEnv }));

vi.mock('@/lib/auth/middleware', () => ({
  withJwtAuth: mocks.withJwtAuth,
  requestHasActiveSession: mocks.requestHasActiveSession,
  setDashboardSessionCookies: mocks.setDashboardSessionCookies,
}));

vi.mock('@/lib/auth/jwt', () => ({ signJwt: mocks.signJwt }));

vi.mock('@/lib/db/client', () => {
  mocks.select.mockReturnValue({ from: mocks.from });
  mocks.from.mockReturnValue({ innerJoin: mocks.innerJoin });
  mocks.innerJoin.mockReturnValue({ where: mocks.where });
  mocks.where.mockReturnValue({ limit: mocks.limit });
  return { db: { select: mocks.select } };
});

const { GET } = await import('../../src/app/settings/keys/route.js');

// The request host is deliberately the server bind address: redirects must be
// built from OAUTH_REDIRECT_BASE_URL, never from the incoming request host.
function settingsKeysRequest(): NextRequest {
  return new NextRequest('http://0.0.0.0:3000/settings/keys');
}

describe('GET /settings/keys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.limit.mockResolvedValue([{ slug: 'acme' }]);
    mocks.requestHasActiveSession.mockReturnValue(false);
    mocks.signJwt.mockResolvedValue('legacy-remint');
  });

  it('redirects authenticated users to the slug-scoped API key settings page', async () => {
    mocks.withJwtAuth.mockResolvedValue({
      context: {
        builderId: 'builder-1',
        userId: 'user-1',
        orgSlug: null,
        role: 'owner',
        tier: 'free',
        jti: 'jti-1',
        revocationId: 'family-1',
      },
      refreshToken: 'fresh-token',
      sessionToken: 'old-token',
    });

    const response = await GET(settingsKeysRequest());

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://pylva.com/o/acme/dashboard/settings/api-keys',
    );
    expect(mocks.signJwt).toHaveBeenCalledWith(
      expect.objectContaining({ org_slug: 'acme', session_id: 'family-1' }),
    );
    expect(mocks.setDashboardSessionCookies).toHaveBeenCalledWith(response, {
      token: 'legacy-remint',
      userId: 'user-1',
      orgSlug: 'acme',
    });
  });

  it('sends unauthenticated users to login with the alias as next=', async () => {
    mocks.withJwtAuth.mockResolvedValue(NextResponse.json({}, { status: 401 }));

    const response = await GET(settingsKeysRequest());
    const location = new URL(response.headers.get('location')!);

    expect(response.status).toBe(307);
    expect(location.origin).toBe('https://pylva.com');
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('next')).toBe('/settings/keys');
    expect(mocks.limit).not.toHaveBeenCalled();
  });
});
