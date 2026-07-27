import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server.js';
import { JwtAudience } from '@pylva/shared';

const mocks = vi.hoisted(() => ({
  exists: vi.fn(),
  jwtPayload: {} as Record<string, unknown>,
  signedPayloads: [] as Array<Record<string, unknown>>,
}));

vi.mock('node:fs/promises', () => ({
  default: { readFile: vi.fn(async () => 'test-key') },
}));

vi.mock('jose', () => ({
  SignJWT: class MockSignJWT {
    private readonly payload: Record<string, unknown>;

    constructor(payload: Record<string, unknown>) {
      this.payload = { ...payload };
    }

    setProtectedHeader(): this {
      return this;
    }

    setJti(jti: string): this {
      this.payload['jti'] = jti;
      return this;
    }

    setAudience(audience: string): this {
      this.payload['aud'] = audience;
      return this;
    }

    setIssuedAt(): this {
      this.payload['iat'] = Math.floor(Date.now() / 1000);
      return this;
    }

    setExpirationTime(): this {
      this.payload['exp'] = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
      return this;
    }

    async sign(): Promise<string> {
      mocks.signedPayloads.push({ ...this.payload });
      return JSON.stringify(this.payload);
    }
  },
  importPKCS8: vi.fn(async () => ({})),
  importSPKI: vi.fn(async () => ({})),
  jwtVerify: vi.fn(async () => ({ payload: { ...mocks.jwtPayload } })),
}));

vi.mock('@/lib/config', () => ({
  env: {
    JWT_PRIVATE_KEY: '/tmp/test-private.pem',
    JWT_PUBLIC_KEY: '/tmp/test-public.pem',
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
    OAUTH_REDIRECT_BASE_URL: 'https://app.example.com',
    PUBLIC_SITE_URL: 'https://app.example.com',
    PYLVA_BACKEND_URL: 'https://app.example.com',
    SESSION_COOKIE_NAME: 'pylva_session',
    SESSION_COOKIE_SECURE: true,
  },
}));

vi.mock('@/lib/auth/membership-cache', () => ({
  resolveSlugForUserCached: vi.fn(),
}));

vi.mock('@/lib/redis/client', () => ({
  ensureRedisCommandClient: vi.fn(async () => undefined),
  redisClient: {
    exists: mocks.exists,
  },
}));

vi.mock('@/lib/redis/circuit-breaker', () => ({
  rateLimitBreaker: { fire: vi.fn() },
  revocationBreaker: {
    fire: vi.fn(async (operation: () => Promise<unknown>) => operation()),
  },
}));

const { refreshJwtIfNeeded, signJwt, verifyJwt } = await import('@/lib/auth/jwt');
const { clearSessionCookie, setDashboardSessionCookies, withJwtAuth } =
  await import('@/lib/auth/middleware');
const { encodeActiveSessionValue } = await import('@/lib/auth/session-fingerprint');

describe('JWT sliding-refresh revocation family', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.jwtPayload = {};
    mocks.signedPayloads.length = 0;
    mocks.exists.mockResolvedValue(0);
  });

  it('keeps independently refreshed tokens in one revocation family', async () => {
    const now = Math.floor(Date.now() / 1000);
    const original = {
      aud: JwtAudience.DASHBOARD,
      builder_id: 'builder-1',
      exp: now + 60,
      iat: now - 23 * 60 * 60,
      jti: 'session-root',
      org_slug: 'org-a',
      revocation_id: 'session-root',
      role: 'owner' as const,
      user_id: 'user-1',
    };

    await expect(refreshJwtIfNeeded(original)).resolves.toBeTruthy();
    await expect(refreshJwtIfNeeded(original)).resolves.toBeTruthy();

    expect(mocks.signedPayloads).toHaveLength(2);
    expect(mocks.signedPayloads[0]!['jti']).not.toBe(mocks.signedPayloads[1]!['jti']);
    expect(mocks.signedPayloads[0]!['sid']).toBe('session-root');
    expect(mocks.signedPayloads[1]!['sid']).toBe('session-root');
    expect(mocks.signedPayloads[0]!['org_slug']).toBe('org-a');
    expect(mocks.signedPayloads[1]!['org_slug']).toBe('org-a');
  });

  it('mints normalized checkout-required claims without the deprecated paid alias', async () => {
    await signJwt({
      builder_id: 'builder-expand-race',
      audience: JwtAudience.DASHBOARD,
      user_id: 'user-expand-race',
      plan: null,
      access_state: 'checkout_required',
    });

    expect(mocks.signedPayloads[0]).toMatchObject({
      builder_id: 'builder-expand-race',
      user_id: 'user-expand-race',
      plan: null,
      access_state: 'checkout_required',
    });
    expect(mocks.signedPayloads[0]).not.toHaveProperty('tier');
  });

  it('rejects a raw legacy Free tuple if an auth boundary ever bypasses normalization', async () => {
    await expect(
      signJwt({
        builder_id: 'builder-invalid',
        audience: JwtAudience.DASHBOARD,
        plan: 'free' as never,
        access_state: null as never,
      }),
    ).rejects.toThrow('Dashboard token plan claim is invalid');
    expect(mocks.signedPayloads).toHaveLength(0);
  });

  it.each([
    [
      'plan without access state',
      { plan: 'pro' as const },
      'Dashboard entitlement claims require both plan and access_state',
    ],
    [
      'access state without plan',
      { access_state: 'active' as const },
      'Dashboard entitlement claims require both plan and access_state',
    ],
    [
      'unknown access state',
      { plan: null, access_state: 'unknown' as never },
      'Dashboard token access_state claim is invalid',
    ],
    [
      'paid plan on suspended token',
      { plan: 'pro' as const, access_state: 'suspended' as const },
      'A non-active dashboard token cannot carry a paid plan',
    ],
    [
      'tier on checkout-required token',
      { plan: null, access_state: 'checkout_required' as const, tier: 'pro' as const },
      'Deprecated tier claim must match an active paid plan',
    ],
    [
      'tier that differs from plan',
      { plan: 'pro' as const, access_state: 'active' as const, tier: 'scale' as const },
      'Deprecated tier claim must match an active paid plan',
    ],
  ])('rejects invalid entitlement claim branch: %s', async (_name, claims, message) => {
    await expect(
      signJwt({
        builder_id: 'builder-invalid-claims',
        audience: JwtAudience.DASHBOARD,
        ...claims,
      }),
    ).rejects.toThrow(message);
    expect(mocks.signedPayloads).toEqual([]);
  });

  it('emits a deprecated tier alias only when it matches an active paid plan', async () => {
    await signJwt({
      builder_id: 'builder-active',
      audience: JwtAudience.DASHBOARD,
      plan: 'pro',
      access_state: 'active',
      tier: 'pro',
    });

    expect(mocks.signedPayloads[0]).toMatchObject({
      plan: 'pro',
      access_state: 'active',
      tier: 'pro',
    });
  });

  it('does not refresh before half the validated token lifetime has elapsed', async () => {
    const now = Math.floor(Date.now() / 1000);

    await expect(
      refreshJwtIfNeeded({
        aud: JwtAudience.DASHBOARD,
        builder_id: 'builder-fresh',
        exp: now + 18 * 60 * 60,
        iat: now - 6 * 60 * 60,
        jti: 'fresh-token',
        revocation_id: 'fresh-session',
      }),
    ).resolves.toBeNull();
    expect(mocks.signedPayloads).toEqual([]);
  });

  it('preserves validated canonical paid claims and their matching compatibility alias', async () => {
    const now = Math.floor(Date.now() / 1000);

    await expect(
      refreshJwtIfNeeded({
        aud: JwtAudience.DASHBOARD,
        access_state: 'active',
        builder_id: 'builder-paid',
        exp: now + 60,
        iat: now - 23 * 60 * 60,
        jti: 'paid-token',
        plan: 'scale',
        revocation_id: 'paid-session',
        tier: 'scale',
      }),
    ).resolves.toBeTruthy();

    expect(mocks.signedPayloads[0]).toMatchObject({
      access_state: 'active',
      plan: 'scale',
      sid: 'paid-session',
      tier: 'scale',
    });
  });

  it('drops a legacy tier-only claim during refresh', async () => {
    const now = Math.floor(Date.now() / 1000);

    await expect(
      refreshJwtIfNeeded({
        aud: JwtAudience.DASHBOARD,
        builder_id: 'builder-legacy',
        exp: now + 60,
        iat: now - 23 * 60 * 60,
        jti: 'legacy-token',
        revocation_id: 'legacy-token',
        tier: 'pro',
      }),
    ).resolves.toBeTruthy();

    expect(mocks.signedPayloads[0]).not.toHaveProperty('plan');
    expect(mocks.signedPayloads[0]).not.toHaveProperty('access_state');
    expect(mocks.signedPayloads[0]).not.toHaveProperty('tier');
    expect(mocks.signedPayloads[0]).toMatchObject({ sid: 'legacy-token' });
  });

  it('fails refresh closed when informational claims are internally inconsistent', async () => {
    const now = Math.floor(Date.now() / 1000);

    await expect(
      refreshJwtIfNeeded({
        aud: JwtAudience.DASHBOARD,
        access_state: 'active',
        builder_id: 'builder-inconsistent',
        exp: now + 60,
        iat: now - 23 * 60 * 60,
        jti: 'inconsistent-token',
        plan: 'pro',
        revocation_id: 'inconsistent-session',
        tier: 'scale',
      }),
    ).rejects.toThrow('Deprecated tier claim must match an active paid plan');
    expect(mocks.signedPayloads).toEqual([]);
  });

  it.each([
    'access_state',
    'aud',
    'builder_id',
    'exp',
    'iat',
    'jti',
    'plan',
    'sid',
    'tier',
    'user_id',
  ])('rejects reserved additional claim override %s before signing', async (claim) => {
    await expect(
      signJwt({
        builder_id: 'builder-1',
        audience: JwtAudience.DASHBOARD,
        additionalClaims: { [claim]: 'free' },
      }),
    ).rejects.toThrow(`additionalClaims cannot override reserved JWT claim: ${claim}`);
    expect(mocks.signedPayloads).toEqual([]);
  });

  it('preserves non-reserved additional claims without overriding identity', async () => {
    await signJwt({
      builder_id: 'builder-1',
      audience: JwtAudience.DASHBOARD,
      additionalClaims: { feature_hint: 'read_only' },
    });

    expect(mocks.signedPayloads).toHaveLength(1);
    expect(mocks.signedPayloads[0]).toMatchObject({
      builder_id: 'builder-1',
      feature_hint: 'read_only',
    });
  });

  it('checks a refreshed token against the root session revocation id', async () => {
    const now = Math.floor(Date.now() / 1000);
    mocks.jwtPayload = {
      aud: JwtAudience.DASHBOARD,
      builder_id: 'builder-1',
      exp: now + 12 * 60 * 60,
      iat: now,
      jti: 'rotated-token-id',
      org_slug: 'org-a',
      sid: 'session-root',
      user_id: 'user-1',
    };
    mocks.exists.mockResolvedValue(1);

    await expect(verifyJwt('rotated-token', JwtAudience.DASHBOARD)).rejects.toThrow(
      'Token has been revoked',
    );
    expect(mocks.exists).toHaveBeenCalledWith(
      `REVOKED_TOKEN:${JwtAudience.DASHBOARD}:session-root`,
    );
  });

  it('rejects verified tokens without a jti before checking revocation', async () => {
    mocks.jwtPayload = {
      aud: JwtAudience.DASHBOARD,
      builder_id: 'builder-no-jti',
      exp: 2,
      iat: 1,
    };

    await expect(verifyJwt('missing-jti', JwtAudience.DASHBOARD)).rejects.toThrow(
      'Missing jti claim',
    );
    expect(mocks.exists).not.toHaveBeenCalled();
  });

  it.each([
    ['missing sid', undefined],
    ['blank sid', ''],
  ])('uses the legacy jti revocation identity for %s', async (_name, sid) => {
    const now = Math.floor(Date.now() / 1000);
    mocks.jwtPayload = {
      aud: JwtAudience.DASHBOARD,
      builder_id: 'builder-legacy-revocation',
      exp: now + 60,
      iat: now,
      jti: 'legacy-jti',
      ...(sid === undefined ? {} : { sid }),
    };

    await expect(verifyJwt('legacy-token', JwtAudience.DASHBOARD)).resolves.toMatchObject({
      revocation_id: 'legacy-jti',
    });
    expect(mocks.exists).toHaveBeenCalledWith(
      `REVOKED_TOKEN:${JwtAudience.DASHBOARD}:legacy-jti`,
    );
  });

  it('exposes the root revocation id to logout and org-switch callers', async () => {
    const now = Math.floor(Date.now() / 1000);
    mocks.jwtPayload = {
      aud: JwtAudience.DASHBOARD,
      builder_id: 'builder-1',
      exp: now + 12 * 60 * 60,
      iat: now,
      jti: 'rotated-token-id',
      org_slug: 'org-a',
      sid: 'session-root',
      user_id: 'user-1',
    };

    const request = new NextRequest('https://app.example.com/api/v1/whoami', {
      headers: { cookie: 'pylva_session=rotated-token' },
    });
    const result = await withJwtAuth(request, JwtAudience.DASHBOARD);

    expect(result).not.toBeInstanceOf(NextResponse);
    if (result instanceof NextResponse) throw new Error('expected an authenticated context');
    expect(result.context.jti).toBe('rotated-token-id');
    expect(result.context.revocationId).toBe('session-root');
    expect(result.context.orgSlug).toBe('org-a');
  });

  it('clears the accepted legacy cookie so logout cannot fall back to it', () => {
    const response = NextResponse.json({ ok: true });

    clearSessionCookie(response);

    const cookies = response.cookies.getAll();
    expect(cookies.map((cookie) => cookie.name)).toEqual(
      expect.arrayContaining(['pylva_session', 'pylva_token', 'pylva_active_session']),
    );
    expect(cookies.find((cookie) => cookie.name === 'pylva_session')?.httpOnly).toBe(true);
    expect(cookies.find((cookie) => cookie.name === 'pylva_token')?.httpOnly).toBe(true);
    expect(cookies.find((cookie) => cookie.name === 'pylva_active_session')?.httpOnly).toBe(false);
  });

  it('keeps JWT and marker coherent when an older response arrives last', () => {
    const responseA = NextResponse.json({ request: 'A' });
    const responseB = NextResponse.json({ request: 'B' });
    setDashboardSessionCookies(responseA, { token: 'jwt-a', userId: 'user-a', orgSlug: 'org-a' });
    setDashboardSessionCookies(responseB, { token: 'jwt-b', userId: 'user-b', orgSlug: 'org-b' });

    const jar = new Map<string, string>();
    for (const response of [responseB, responseA]) {
      for (const cookie of response.cookies.getAll()) jar.set(cookie.name, cookie.value);
    }

    expect(jar.get('pylva_session')).toBe('jwt-a');
    expect(jar.get('pylva_active_session')).toBe(encodeActiveSessionValue('user-a', 'org-a'));
  });
});
