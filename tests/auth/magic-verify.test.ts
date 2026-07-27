import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest, NextResponse } from 'next/server.js';
// Real module (node:crypto only) — the setActiveSessionCookie mock delegates
// to it so set-cookie assertions verify the actual on-the-wire format
// (`${sha256(userId).slice(0,16)}.${slug}`), never a made-up one.
import { encodeActiveSessionValue } from '@/lib/auth/session-fingerprint';
import { validateAuthNext } from '@/lib/auth/post-auth-redirect';

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
    lastMagicResult: null as null | {
      userId: string;
      email: string;
      isNewUser: boolean;
      next: string | null;
      pendingInviteToken?: string | null;
    },
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
  consumeMagicTokenIdentity: async (token: string) => {
    const result = await mocks.consumeMagicToken(token);
    mocks.lastMagicResult = result;
    return result;
  },
}));

vi.mock('@/lib/auth/org', () => ({
  findOrCreateBuilderForUser: mocks.findOrCreateBuilderForUser,
  provisionMagicLinkUserAndBuilder: async (input: {
    email: string;
    displayName: string | null;
    avatarUrl: string | null;
    pendingInviteToken?: string | null;
  }) => {
    const identity = mocks.lastMagicResult;
    if (!identity) throw new Error('missing mocked magic identity');
    const org = await mocks.findOrCreateBuilderForUser({
      ...input,
      userId: identity.userId,
    });
    return {
      user: {
        userId: identity.userId,
        email: identity.email,
        isNewUser: identity.isNewUser,
      },
      org,
    };
  },
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
    mocks.lastMagicResult = null;
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
      plan: 'scale',
      accessState: 'active',
      entitlementSource: 'stripe',
      isNew: false,
      acceptedInviteId: null,
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
      pendingInviteToken: undefined,
      userId: 'user-1',
    });
    expect(mocks.signJwt).toHaveBeenCalledWith(
      expect.objectContaining({
        audience: 'pylva:dashboard',
        builder_id: 'builder-legacy',
        role: 'owner',
        plan: 'scale',
        access_state: 'active',
        tier: 'scale',
        user_id: 'user-1',
      }),
    );
    expect(mocks.resolveSlugForUser).not.toHaveBeenCalled();
  });

  it('sends a generic hosted signup to required plan selection without paid claims', async () => {
    mocks.consumeMagicToken.mockResolvedValue({
      userId: 'user-new',
      email: 'new@example.com',
      isNewUser: true,
      next: null,
      pendingInviteToken: null,
    });
    mocks.findOrCreateBuilderForUser.mockResolvedValue({
      builderId: 'builder-new',
      slug: 'new-workspace',
      role: 'owner',
      plan: null,
      accessState: 'checkout_required',
      entitlementSource: null,
      isNew: true,
      acceptedInviteId: null,
    });

    const response = await invoke('magic-token');

    expect(response.headers.get('location')).toBe(
      'https://app.example.com/o/new-workspace/subscription',
    );
    expect(mocks.signJwt).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: null,
        access_state: 'checkout_required',
      }),
    );
    expect(mocks.signJwt.mock.calls[0]?.[0]).not.toHaveProperty('tier');
  });

  it('mints a checkout-required session for an existing legacy Free row normalized by org lookup', async () => {
    mocks.consumeMagicToken.mockResolvedValue({
      userId: 'user-expand-race',
      email: 'expand-race@example.com',
      isNewUser: false,
      next: null,
      pendingInviteToken: null,
    });
    mocks.findOrCreateBuilderForUser.mockResolvedValue({
      builderId: 'builder-expand-race',
      slug: 'expand-race',
      role: 'owner',
      plan: null,
      accessState: 'checkout_required',
      entitlementSource: null,
      isNew: false,
      acceptedInviteId: null,
    });

    const response = await invoke('magic-token');

    expect(response.headers.get('location')).toBe(
      'https://app.example.com/o/expand-race/subscription',
    );
    expect(mocks.signJwt).toHaveBeenCalledWith(
      expect.objectContaining({
        builder_id: 'builder-expand-race',
        plan: null,
        access_state: 'checkout_required',
      }),
    );
    expect(mocks.signJwt.mock.calls[0]?.[0]).not.toHaveProperty('tier');
  });

  it.each(['checkout_required', 'suspended'] as const)(
    'does not restore nested product navigation for a %s workspace',
    async (accessState) => {
      mocks.consumeMagicToken.mockResolvedValue({
        userId: 'user-restricted',
        email: 'restricted@example.com',
        isNewUser: false,
        next: '/o/restricted-workspace/dashboard/rules',
        pendingInviteToken: null,
      });
      mocks.findOrCreateBuilderForUser.mockResolvedValue({
        builderId: 'builder-restricted',
        slug: 'restricted-workspace',
        role: 'owner',
        plan: null,
        accessState,
        entitlementSource: accessState === 'suspended' ? 'stripe' : null,
        isNew: false,
        acceptedInviteId: null,
      });

      const response = await invoke('magic-token');

      expect(response.headers.get('location')).toBe(
        'https://app.example.com/o/restricted-workspace/subscription',
      );
    },
  );

  it.each(['checkout_required', 'suspended'] as const)(
    'does not resume WorkOS completion after login for a %s workspace',
    async (accessState) => {
      const next =
        '/api/v1/auth/workos/complete?external_auth_id=ext_auth_01KXDW5PVKQ5MR2R0VN9D00J5C';
      // Hosted assembly overlays the bounded WorkOS next-path validator. The
      // public core deliberately does not expose that hosted-only endpoint.
      if (!validateAuthNext(next)) return;

      mocks.consumeMagicToken.mockResolvedValue({
        userId: 'user-workos-restricted',
        email: 'workos-restricted@example.com',
        isNewUser: false,
        next,
        pendingInviteToken: null,
      });
      mocks.findOrCreateBuilderForUser.mockResolvedValue({
        builderId: 'builder-workos-restricted',
        slug: 'workos-restricted',
        role: 'owner',
        plan: null,
        accessState,
        entitlementSource: accessState === 'suspended' ? 'stripe' : null,
        isNew: false,
        acceptedInviteId: null,
      });

      const response = await invoke('magic-token');

      expect(response.headers.get('location')).toBe(
        'https://app.example.com/o/workos-restricted/subscription',
      );
    },
  );

  it.each(['pro', 'scale'] as const)(
    'preserves a validated hosted %s checkout intent for a provisional workspace',
    async (plan) => {
      const next = `/subscribe/${plan}`;
      // The public core intentionally rejects hosted-only checkout paths. This
      // assertion becomes active in the assembled app, where the hosted
      // post-auth helper is overlaid onto these shared auth routes.
      if (!validateAuthNext(next)) return;

      mocks.consumeMagicToken.mockResolvedValue({
        userId: 'user-checkout',
        email: 'checkout@example.com',
        isNewUser: true,
        next,
        pendingInviteToken: null,
      });
      mocks.findOrCreateBuilderForUser.mockResolvedValue({
        builderId: 'builder-checkout',
        slug: 'checkout-workspace',
        role: 'owner',
        plan: null,
        accessState: 'checkout_required',
        entitlementSource: null,
        isNew: true,
        acceptedInviteId: null,
      });

      const response = await invoke('magic-token');

      expect(response.headers.get('location')).toBe(`https://app.example.com${next}`);
    },
  );

  it('lands an invite-first user in the invited workspace without a second accept round trip', async () => {
    const pendingInviteToken = 'd'.repeat(64);
    mocks.consumeMagicToken.mockResolvedValue({
      userId: 'user-invited',
      email: 'invited@example.com',
      isNewUser: true,
      next: null,
      pendingInviteToken,
    });
    mocks.findOrCreateBuilderForUser.mockResolvedValue({
      builderId: 'builder-invited',
      slug: 'invited-workspace',
      role: 'member',
      plan: 'pro',
      accessState: 'active',
      entitlementSource: 'stripe',
      isNew: false,
      acceptedInviteId: 'invite-1',
    });

    const response = await invoke('magic-token');

    expect(response.headers.get('location')).toBe(
      'https://app.example.com/o/invited-workspace/dashboard',
    );
    expect(mocks.findOrCreateBuilderForUser).toHaveBeenCalledWith(
      expect.objectContaining({ pendingInviteToken }),
    );
    expect(response.cookies.get('pylva_pending_invite')?.value).toBe('');
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
      plan: 'scale',
      accessState: 'active',
      entitlementSource: 'stripe',
      isNew: false,
      acceptedInviteId: null,
    });
    mocks.resolveSlugForUser.mockResolvedValue({
      builderId: 'builder-other',
      role: 'member',
      plan: 'pro',
      accessState: 'active',
      entitlementSource: 'stripe',
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
      plan: 'scale',
      accessState: 'active',
      entitlementSource: 'stripe',
      isNew: false,
      acceptedInviteId: null,
    });
    mocks.resolveSlugForUser.mockResolvedValue({
      builderId: 'builder-other',
      role: 'member',
      plan: 'pro',
      accessState: 'active',
      entitlementSource: 'stripe',
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
        plan: 'pro',
        access_state: 'active',
        tier: 'pro',
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
      plan: 'scale',
      accessState: 'active',
      entitlementSource: 'stripe',
      isNew: false,
      acceptedInviteId: null,
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
      plan: 'scale',
      accessState: 'active',
      entitlementSource: 'stripe',
      isNew: false,
      acceptedInviteId: null,
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
