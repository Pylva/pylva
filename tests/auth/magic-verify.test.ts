import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest, NextResponse } from 'next/server.js';
// Real module (node:crypto only) — the setActiveSessionCookie mock delegates
// to it so set-cookie assertions verify the actual on-the-wire format
// (`${sha256(userId).slice(0,16)}.${slug}`), never a made-up one.
import { encodeActiveSessionValue } from '@/lib/auth/session-fingerprint';

const mocks = vi.hoisted(() => {
  class MockAuthDegraded extends Error {
    constructor(reason: string) {
      super(`[auth.magic-link] auth service degraded: ${reason}`);
      this.name = 'AuthDegraded';
    }
  }

  return {
    AuthDegraded: MockAuthDegraded,
    auditLog: vi.fn(),
    consumeMagicToken: vi.fn(),
    findOrCreateBuilderForUser: vi.fn(),
    resolveSlugForUser: vi.fn(),
    setDashboardSessionCookies: vi.fn(),
    setActiveSessionCookie: vi.fn(),
    setRefreshCookie: vi.fn(),
    signJwt: vi.fn(),
    warn: vi.fn(),
    withRLS: vi.fn(),
  };
});

const testEnv = vi.hoisted(() => ({
  LOG_LEVEL: 'silent',
  OAUTH_REDIRECT_BASE_URL: 'https://app.example.com',
  MAGIC_LINK_TTL_SECONDS: 900,
  NODE_ENV: 'test',
  SESSION_COOKIE_NAME: 'pylva_session',
  SESSION_COOKIE_SECURE: true,
}));

vi.mock('@/lib/config', () => ({ env: testEnv }));
vi.mock('../../src/lib/config.js', () => ({ env: testEnv }));

vi.mock('@/lib/auth/magic-link', () => ({
  AuthDegraded: mocks.AuthDegraded,
  consumeMagicToken: mocks.consumeMagicToken,
}));

vi.mock('@/lib/auth/org', () => ({
  findOrCreateBuilderForUser: mocks.findOrCreateBuilderForUser,
  resolveSlugForUser: mocks.resolveSlugForUser,
}));

vi.mock('@/lib/auth/jwt', () => ({
  signJwt: mocks.signJwt,
}));

vi.mock('@/lib/auth/middleware', () => ({
  setDashboardSessionCookies: mocks.setDashboardSessionCookies,
  setActiveSessionCookie: mocks.setActiveSessionCookie,
  setRefreshCookie: mocks.setRefreshCookie,
}));

vi.mock('@/lib/db/rls', () => ({
  withRLS: mocks.withRLS,
}));

vi.mock('@/lib/auth/audit-log', () => ({
  auditLog: mocks.auditLog,
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    child: () => ({
      warn: mocks.warn,
    }),
  },
}));

const { GET } = await import('../../src/app/api/v1/auth/magic/verify/route.js');

function request(token?: string): NextRequest {
  const url = new URL('https://app.example.com/api/v1/auth/magic/verify');
  if (token !== undefined) url.searchParams.set('token', token);
  return { url: url.toString() } as unknown as NextRequest;
}

async function invoke(token?: string): Promise<NextResponse> {
  return GET(request(token));
}

describe('GET /api/v1/auth/magic/verify', () => {
  beforeEach(() => {
    mocks.auditLog.mockReset();
    mocks.consumeMagicToken.mockReset();
    mocks.findOrCreateBuilderForUser.mockReset();
    mocks.resolveSlugForUser.mockReset();
    mocks.setDashboardSessionCookies.mockReset();
    mocks.setActiveSessionCookie.mockReset();
    mocks.setRefreshCookie.mockReset();
    mocks.signJwt.mockReset();
    mocks.warn.mockReset();
    mocks.withRLS.mockReset();

    mocks.signJwt.mockResolvedValue('signed-dashboard-jwt');
    mocks.setRefreshCookie.mockImplementation((response: NextResponse, token: string) => {
      response.cookies.set('pylva_session', token, {
        httpOnly: true,
        path: '/',
        sameSite: 'lax',
        secure: true,
      });
    });
    mocks.setActiveSessionCookie.mockImplementation(
      (response: NextResponse, userId: string, orgSlug: string) => {
        response.cookies.set('pylva_active_session', encodeActiveSessionValue(userId, orgSlug), {
          path: '/',
          sameSite: 'lax',
          secure: true,
        });
      },
    );
    mocks.setDashboardSessionCookies.mockImplementation(
      (response: NextResponse, params: { token: string; userId: string; orgSlug: string }) => {
        mocks.setRefreshCookie(response, params.token);
        mocks.setActiveSessionCookie(response, params.userId, params.orgSlug);
      },
    );
    mocks.withRLS.mockImplementation(
      async (_builderId: string, fn: (tx: unknown) => Promise<unknown>) => fn({}),
    );
  });

  it('creates a session and redirects to an adopted legacy builder', async () => {
    mocks.consumeMagicToken.mockResolvedValue({
      userId: 'user-1',
      email: 'legacy@example.com',
      isNewUser: false,
      next: null,
    });
    mocks.findOrCreateBuilderForUser.mockResolvedValue({
      builderId: 'builder-legacy',
      slug: 'legacy-workspace',
      role: 'owner',
      tier: 'scale',
      isNew: false,
    });

    const response = await invoke('magic-token');

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://app.example.com/o/legacy-workspace/dashboard',
    );
    expect(response.headers.get('set-cookie')).toContain('pylva_session=signed-dashboard-jwt');
    expect(response.headers.get('set-cookie')).toContain(
      `pylva_active_session=${encodeActiveSessionValue('user-1', 'legacy-workspace')}`,
    );
    // Fingerprint half is a truncated hash — the raw user id never leaks.
    expect(encodeActiveSessionValue('user-1', 'legacy-workspace')).toMatch(
      /^[0-9a-f]{16}\.legacy-workspace$/,
    );
    expect(response.headers.get('set-cookie')).not.toContain('user-1.legacy-workspace');
    expect(mocks.findOrCreateBuilderForUser).toHaveBeenCalledWith({
      avatarUrl: null,
      displayName: null,
      email: 'legacy@example.com',
      userId: 'user-1',
    });
    expect(mocks.signJwt).toHaveBeenCalledWith(
      expect.objectContaining({
        audience: 'pylva:dashboard',
        builder_id: 'builder-legacy',
        role: 'owner',
        tier: 'scale',
        user_id: 'user-1',
      }),
    );
    expect(mocks.resolveSlugForUser).not.toHaveBeenCalled();
  });

  it('gives a pending invite precedence and restores its HttpOnly cookie', async () => {
    const pendingInviteToken = 'a'.repeat(64);
    mocks.consumeMagicToken.mockResolvedValue({
      userId: 'user-1',
      email: 'legacy@example.com',
      isNewUser: false,
      next: '/o/other-org/dashboard/rules',
      pendingInviteToken,
    });
    mocks.findOrCreateBuilderForUser.mockResolvedValue({
      builderId: 'builder-legacy',
      slug: 'legacy-workspace',
      role: 'owner',
      tier: 'scale',
      isNew: false,
    });
    mocks.resolveSlugForUser.mockResolvedValue({
      builderId: 'builder-other',
      role: 'member',
      tier: 'free',
    });

    const response = await invoke('magic-token');

    expect(response.headers.get('location')).toBe('https://app.example.com/api/v1/invites/accept');
    expect(response.headers.get('location')).not.toContain(pendingInviteToken);
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`pylva_pending_invite=${pendingInviteToken}`);
    expect(setCookie.toLowerCase()).toContain('httponly');
  });

  it('honors a validated next for another org when the user holds membership there', async () => {
    mocks.consumeMagicToken.mockResolvedValue({
      userId: 'user-1',
      email: 'legacy@example.com',
      isNewUser: false,
      next: '/o/other-org/dashboard/rules',
    });
    mocks.findOrCreateBuilderForUser.mockResolvedValue({
      builderId: 'builder-legacy',
      slug: 'legacy-workspace',
      role: 'owner',
      tier: 'scale',
      isNew: false,
    });
    mocks.resolveSlugForUser.mockResolvedValue({
      builderId: 'builder-other',
      role: 'member',
      tier: 'free',
    });

    const response = await invoke('magic-token');

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://app.example.com/o/other-org/dashboard/rules',
    );
    expect(mocks.resolveSlugForUser).toHaveBeenCalledWith({ slug: 'other-org', userId: 'user-1' });
    expect(mocks.signJwt).toHaveBeenCalledWith(
      expect.objectContaining({
        audience: 'pylva:dashboard',
        builder_id: 'builder-other',
        role: 'member',
        tier: 'free',
        user_id: 'user-1',
      }),
    );
    expect(mocks.setActiveSessionCookie).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'other-org',
    );
  });

  it('drops the next path when the user has no membership in its org', async () => {
    mocks.consumeMagicToken.mockResolvedValue({
      userId: 'user-1',
      email: 'legacy@example.com',
      isNewUser: false,
      next: '/o/other-org/dashboard',
    });
    mocks.findOrCreateBuilderForUser.mockResolvedValue({
      builderId: 'builder-legacy',
      slug: 'legacy-workspace',
      role: 'owner',
      tier: 'scale',
      isNew: false,
    });
    mocks.resolveSlugForUser.mockResolvedValue(null);

    const response = await invoke('magic-token');

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://app.example.com/o/legacy-workspace/dashboard',
    );
    expect(mocks.signJwt).toHaveBeenCalledWith(
      expect.objectContaining({ builder_id: 'builder-legacy', role: 'owner', tier: 'scale' }),
    );
    expect(mocks.setActiveSessionCookie).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'legacy-workspace',
    );
  });

  it('still logs the user in when the next-org lookup fails (falls back to default org)', async () => {
    mocks.consumeMagicToken.mockResolvedValue({
      userId: 'user-1',
      email: 'legacy@example.com',
      isNewUser: false,
      next: '/o/other-org/dashboard',
    });
    mocks.findOrCreateBuilderForUser.mockResolvedValue({
      builderId: 'builder-legacy',
      slug: 'legacy-workspace',
      role: 'owner',
      tier: 'scale',
      isNew: false,
    });
    // The one-time token is already consumed at this point: a transient
    // membership-lookup failure must NOT fail the login.
    mocks.resolveSlugForUser.mockRejectedValue(new Error('membership lookup timed out'));

    const response = await invoke('magic-token');

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://app.example.com/o/legacy-workspace/dashboard',
    );
    expect(response.headers.get('set-cookie')).toContain('pylva_session=signed-dashboard-jwt');
    expect(response.headers.get('set-cookie')).toContain(
      `pylva_active_session=${encodeActiveSessionValue('user-1', 'legacy-workspace')}`,
    );
    expect(mocks.signJwt).toHaveBeenCalledWith(
      expect.objectContaining({ builder_id: 'builder-legacy', role: 'owner', tier: 'scale' }),
    );
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error_name: 'Error' }),
      'magic verify next-org lookup failed — using default',
    );
  });

  it('redirects org failures to magic_failed without logging raw emails or tokens', async () => {
    mocks.consumeMagicToken.mockResolvedValue({
      userId: 'user-1',
      email: 'legacy@example.com',
      isNewUser: false,
      next: null,
    });
    mocks.findOrCreateBuilderForUser.mockRejectedValue(
      new Error('duplicate key for leaked@example.com with token magic-token'),
    );

    const response = await invoke('magic-token');

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://app.example.com/login?error=magic_failed',
    );
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error_name: 'Error' }),
      'magic verify failed',
    );
    const serializedLogs = JSON.stringify(mocks.warn.mock.calls);
    expect(serializedLogs).not.toContain('leaked@example.com');
    expect(serializedLogs).not.toContain('magic-token');
  });

  it('keeps expired-token behavior unchanged', async () => {
    mocks.consumeMagicToken.mockResolvedValue(null);

    const response = await invoke('expired-token');

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://app.example.com/login?error=magic_expired',
    );
    expect(mocks.findOrCreateBuilderForUser).not.toHaveBeenCalled();
  });
});
