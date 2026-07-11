import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest, NextResponse } from 'next/server.js';
import { encodeOAuthStateValue } from '@/lib/auth/post-auth-redirect';
// Real module (node:crypto only) — the setActiveSessionCookie mock delegates
// to it so set-cookie assertions verify the actual on-the-wire format
// (`${sha256(userId).slice(0,16)}.${slug}`), never a made-up one.
import { encodeActiveSessionValue } from '@/lib/auth/session-fingerprint';

const mocks = vi.hoisted(() => {
  return {
    auditLog: vi.fn(),
    exchangeOAuthCode: vi.fn(),
    externalFetch: vi.fn(),
    findOrCreateBuilderForUser: vi.fn(),
    resolveSlugForUser: vi.fn(),
    setDashboardSessionCookies: vi.fn(),
    setActiveSessionCookie: vi.fn(),
    setRefreshCookie: vi.fn(),
    signJwt: vi.fn(),
    upsertUserFromOAuth: vi.fn(),
    verifyOAuthState: vi.fn(),
    warn: vi.fn(),
    withRLS: vi.fn(),
  };
});

const testEnv = vi.hoisted(() => ({
  NODE_ENV: 'production',
  LOG_LEVEL: 'silent',
  OAUTH_REDIRECT_BASE_URL: 'https://app.example.com',
  SESSION_COOKIE_NAME: 'pylva_session',
  SESSION_COOKIE_SECURE: true,
}));

vi.mock('@/lib/config', () => ({ env: testEnv }));
vi.mock('../../src/lib/config.js', () => ({ env: testEnv }));
vi.mock('../../src/lib/db/client.js', () => ({ db: {} }));

vi.mock('@/lib/auth/oauth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/oauth')>();
  return {
    ...actual,
    exchangeOAuthCode: mocks.exchangeOAuthCode,
    upsertUserFromOAuth: mocks.upsertUserFromOAuth,
    verifyOAuthState: mocks.verifyOAuthState,
  };
});

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

vi.mock('@/lib/logger', () => ({
  logger: {
    child: () => ({
      warn: mocks.warn,
    }),
  },
}));

vi.mock('@/lib/auth/audit-log', () => ({
  auditLog: mocks.auditLog,
}));

vi.mock('@/lib/db/rls', () => ({
  withRLS: mocks.withRLS,
}));

vi.mock('@/lib/external-egress', () => ({
  externalFetch: mocks.externalFetch,
}));

const { GET } = await import('../../src/app/api/v1/auth/oauth/[provider]/callback/route.js');
const { oauthCookieNames } = await import('../../src/lib/auth/oauth.js');

type CookieBag = Record<string, string | undefined>;

const flowNames = oauthCookieNames('state-123');

function flowCookies(state: string): CookieBag {
  const names = oauthCookieNames(state);
  return {
    [names.state]: state,
    [names.nonce]: 'state-hmac',
    [names.pkce]: 'pkce-verifier',
  };
}

function callbackRequest(
  provider: string,
  query: Record<string, string>,
  cookies: CookieBag = {},
): NextRequest {
  const url = new URL(`https://app.example.com/api/v1/auth/oauth/${provider}/callback`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return {
    url: url.toString(),
    cookies: {
      get: (name: string) => {
        const value = cookies[name];
        return value === undefined ? undefined : { name, value };
      },
      getAll: () =>
        Object.entries(cookies)
          .filter((entry): entry is [string, string] => entry[1] !== undefined)
          .map(([name, value]) => ({ name, value })),
    },
  } as unknown as NextRequest;
}

async function invoke(
  provider: string,
  query: Record<string, string>,
  cookies: CookieBag = flowCookies('state-123'),
): Promise<NextResponse> {
  return GET(callbackRequest(provider, query, cookies), {
    params: Promise.resolve({ provider }),
  });
}

function mockSuccessfulDbFlow(provider: 'github' | 'google'): void {
  mocks.exchangeOAuthCode.mockResolvedValue({
    accessToken: () => `${provider}-access-token`,
  });
  mocks.upsertUserFromOAuth.mockResolvedValue({
    userId: 'user-1',
    isNew: true,
    email: `${provider}@example.com`,
    displayName: 'OAuth User',
    avatarUrl: 'https://cdn.example.com/avatar.png',
    previousAuthProvider: null,
  });
  mocks.findOrCreateBuilderForUser.mockResolvedValue({
    builderId: 'builder-1',
    slug: 'oauth-user',
    role: 'owner',
    tier: 'free',
    isNew: true,
  });
  mocks.signJwt.mockResolvedValue('signed-dashboard-jwt');
  mocks.withRLS.mockImplementation(
    async (_builderId: string, fn: (tx: unknown) => Promise<unknown>) => fn({}),
  );
}

function mockProviderProfiles(): void {
  mocks.externalFetch.mockImplementation(async (request: { target: string; url: string }) => {
    if (request.url === 'https://api.github.com/user') {
      return {
        status: 200,
        statusText: 'OK',
        headers: {},
        body: JSON.stringify({
          id: 123,
          login: 'oauth-user',
          name: 'OAuth User',
          email: null,
          avatar_url: 'https://avatars.githubusercontent.com/u/123',
        }),
      };
    }
    if (request.url === 'https://api.github.com/user/emails') {
      return {
        status: 200,
        statusText: 'OK',
        headers: {},
        body: JSON.stringify([{ email: 'github@example.com', primary: true, verified: true }]),
      };
    }
    if (request.url === 'https://openidconnect.googleapis.com/v1/userinfo') {
      return {
        status: 200,
        statusText: 'OK',
        headers: {},
        body: JSON.stringify({
          sub: 'google-subject',
          email: 'google@example.com',
          email_verified: true,
          name: 'OAuth User',
          picture: 'https://lh3.googleusercontent.com/avatar',
        }),
      };
    }
    throw new Error(`unexpected profile request: ${request.url}`);
  });
}

describe('GET /api/v1/auth/oauth/[provider]/callback', () => {
  beforeEach(() => {
    mocks.auditLog.mockReset();
    mocks.exchangeOAuthCode.mockReset();
    mocks.externalFetch.mockReset();
    mocks.findOrCreateBuilderForUser.mockReset();
    mocks.resolveSlugForUser.mockReset();
    mocks.setDashboardSessionCookies.mockReset();
    mocks.setActiveSessionCookie.mockReset();
    mocks.setRefreshCookie.mockReset();
    mocks.signJwt.mockReset();
    mocks.upsertUserFromOAuth.mockReset();
    mocks.verifyOAuthState.mockReset();
    mocks.warn.mockReset();
    mocks.withRLS.mockReset();

    mocks.verifyOAuthState.mockReturnValue(true);
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
    mockProviderProfiles();
  });

  it('redirects provider denial before code validation', async () => {
    const response = await invoke('github', { error: 'access_denied' }, {});

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://app.example.com/login?error=oauth_denied',
    );
    expect(mocks.exchangeOAuthCode).not.toHaveBeenCalled();
  });

  it('redirects missing or mismatched state to oauth_state_mismatch', async () => {
    const response = await invoke('github', { code: 'provider-code', state: 'returned-state' });

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://app.example.com/login?error=oauth_state_mismatch',
    );
    expect(mocks.verifyOAuthState).not.toHaveBeenCalled();
    expect(mocks.exchangeOAuthCode).not.toHaveBeenCalled();
  });

  it('logs the nested transport code safely when token exchange fails', async () => {
    const cause = Object.assign(new Error('Invalid IP address: undefined for provider-code'), {
      code: 'ERR_INVALID_IP_ADDRESS',
    });
    mocks.exchangeOAuthCode.mockRejectedValue(
      new TypeError('fetch failed for leaked@example.com', { cause }),
    );

    const response = await invoke('github', { code: 'provider-code', state: 'state-123' });

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://app.example.com/login?error=oauth_failed',
    );
    expect(response.headers.get('set-cookie')).toContain(`${flowNames.state}=`);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        cause_code: 'ERR_INVALID_IP_ADDRESS',
        cause_name: 'Error',
        error_name: 'TypeError',
        provider: 'github',
        stage: 'token_exchange',
      }),
      'oauth callback failed',
    );
    const serializedLogs = JSON.stringify(mocks.warn.mock.calls);
    expect(serializedLogs).not.toContain('provider-code');
    expect(serializedLogs).not.toContain('leaked@example.com');
    expect(serializedLogs).not.toContain('Invalid IP address');
  });

  it.each([
    { provider: 'github', expectedEmail: 'github@example.com' },
    { provider: 'google', expectedEmail: 'google@example.com' },
  ])(
    'creates a session and redirects $provider sign-in to the dashboard',
    async ({ provider, expectedEmail }) => {
      mockSuccessfulDbFlow(provider as 'github' | 'google');

      const response = await invoke(provider, { code: 'provider-code', state: 'state-123' });

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe(
        'https://app.example.com/o/oauth-user/dashboard',
      );
      expect(response.headers.get('set-cookie')).toContain('pylva_session=signed-dashboard-jwt');
      expect(response.headers.get('set-cookie')).toContain(
        `pylva_active_session=${encodeActiveSessionValue('user-1', 'oauth-user')}`,
      );
      // The fingerprint half must be a truncated hash, never the raw user id.
      expect(encodeActiveSessionValue('user-1', 'oauth-user')).toMatch(
        /^[0-9a-f]{16}\.oauth-user$/,
      );
      expect(response.headers.get('set-cookie')).not.toContain('user-1.oauth-user');
      expect(response.headers.get('set-cookie')).toContain(`${flowNames.pkce}=`);
      expect(mocks.setActiveSessionCookie).toHaveBeenCalledWith(
        expect.anything(),
        'user-1',
        'oauth-user',
      );
      expect(mocks.exchangeOAuthCode).toHaveBeenCalledWith(
        provider,
        'provider-code',
        'pkce-verifier',
      );
      expect(mocks.upsertUserFromOAuth).toHaveBeenCalledWith(
        expect.objectContaining({
          email: expectedEmail,
          provider,
        }),
      );
      expect(mocks.signJwt).toHaveBeenCalledWith(
        expect.objectContaining({
          audience: 'pylva:dashboard',
          builder_id: 'builder-1',
          user_id: 'user-1',
          role: 'owner',
          tier: 'free',
        }),
      );
      expect(mocks.auditLog).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'auth.login',
          builder_id: 'builder-1',
          resource_id: 'user-1',
          details: expect.objectContaining({ provider }),
        }),
      );
    },
  );

  it('accepts a flow that stored cookies under the legacy fixed names', async () => {
    mockSuccessfulDbFlow('github');

    const response = await invoke(
      'github',
      { code: 'provider-code', state: 'state-123' },
      {
        pylva_oauth_state: 'state-123',
        pylva_oauth_nonce: 'state-hmac',
        pylva_oauth_pkce: 'pkce-verifier',
      },
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://app.example.com/o/oauth-user/dashboard');
    expect(response.headers.get('set-cookie')).toContain('pylva_session=signed-dashboard-jwt');
    expect(mocks.exchangeOAuthCode).toHaveBeenCalledWith(
      'github',
      'provider-code',
      'pkce-verifier',
    );
  });

  it('gives pending invite continuation precedence without exposing its bearer token', async () => {
    mockSuccessfulDbFlow('github');
    const pendingInviteToken = 'b'.repeat(64);
    const response = await invoke(
      'github',
      { code: 'provider-code', state: 'state-123' },
      {
        ...flowCookies('state-123'),
        pylva_pending_invite: pendingInviteToken,
      },
    );

    expect(response.headers.get('location')).toBe('https://app.example.com/api/v1/invites/accept');
    expect(response.headers.get('location')).not.toContain(pendingInviteToken);
  });

  it('clears only its own flow triplet plus legacy names — concurrent flows survive', async () => {
    mockSuccessfulDbFlow('github');
    // Another login flow still parked on the provider's authorize page: its
    // cookies must survive this callback, or the concurrent login breaks
    // with oauth_state_mismatch (the isolation per-flow cookies exist for).
    const pendingNames = oauthCookieNames('pending-state');
    const staleName = 'pylva_oauth_state.deadbeef1234abcd';

    const response = await invoke(
      'github',
      { code: 'provider-code', state: 'state-123' },
      {
        ...flowCookies('state-123'),
        ...flowCookies('pending-state'),
        [staleName]: 'stale-state',
      },
    );

    expect(response.status).toBe(307);
    const setCookie = response.headers.get('set-cookie') ?? '';
    for (const name of [
      flowNames.state,
      flowNames.nonce,
      flowNames.pkce,
      'pylva_oauth_state',
      'pylva_oauth_nonce',
      'pylva_oauth_pkce',
    ]) {
      expect(setCookie).toContain(`${name}=;`);
    }
    for (const name of [pendingNames.state, pendingNames.nonce, pendingNames.pkce, staleName]) {
      expect(setCookie).not.toContain(name);
    }
  });

  it('mints the session for the next path org when the user holds membership there', async () => {
    mockSuccessfulDbFlow('github');
    mocks.resolveSlugForUser.mockResolvedValue({
      builderId: 'builder-other',
      role: 'member',
      tier: 'scale',
    });

    const state = encodeOAuthStateValue('nonce-1', '/o/other-org/dashboard/rules');
    const response = await invoke('github', { code: 'provider-code', state }, flowCookies(state));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://app.example.com/o/other-org/dashboard/rules',
    );
    expect(mocks.resolveSlugForUser).toHaveBeenCalledWith({ slug: 'other-org', userId: 'user-1' });
    expect(mocks.signJwt).toHaveBeenCalledWith(
      expect.objectContaining({
        builder_id: 'builder-other',
        role: 'member',
        tier: 'scale',
      }),
    );
    expect(mocks.setActiveSessionCookie).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'other-org',
    );
  });

  it('drops the next path when the user has no membership in its org', async () => {
    mockSuccessfulDbFlow('github');
    mocks.resolveSlugForUser.mockResolvedValue(null);

    const state = encodeOAuthStateValue('nonce-1', '/o/other-org/dashboard');
    const response = await invoke('github', { code: 'provider-code', state }, flowCookies(state));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://app.example.com/o/oauth-user/dashboard');
    expect(mocks.signJwt).toHaveBeenCalledWith(
      expect.objectContaining({ builder_id: 'builder-1', role: 'owner', tier: 'free' }),
    );
    expect(mocks.setActiveSessionCookie).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'oauth-user',
    );
  });

  it('uses GitHub REST headers for profile calls', async () => {
    mockSuccessfulDbFlow('github');

    await invoke('github', { code: 'provider-code', state: 'state-123' });

    expect(mocks.externalFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'github',
        url: 'https://api.github.com/user',
        headers: expect.objectContaining({
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Pylva',
          'X-GitHub-Api-Version': '2022-11-28',
          Authorization: 'Bearer github-access-token',
        }),
      }),
    );
  });

  it('ignores an unverified public GitHub email and uses the verified email list', async () => {
    mockSuccessfulDbFlow('github');
    mocks.externalFetch.mockImplementation(async (request: { url: string }) => {
      if (request.url === 'https://api.github.com/user') {
        return {
          status: 200,
          statusText: 'OK',
          headers: {},
          body: JSON.stringify({
            id: 123,
            login: 'oauth-user',
            name: 'OAuth User',
            // /user exposes a public profile email but provides no verified bit.
            email: 'unverified-claim@example.com',
            avatar_url: null,
          }),
        };
      }
      if (request.url === 'https://api.github.com/user/emails') {
        return {
          status: 200,
          statusText: 'OK',
          headers: {},
          body: JSON.stringify([
            { email: 'unverified-claim@example.com', primary: false, verified: false },
            { email: 'verified-owner@example.com', primary: true, verified: true },
          ]),
        };
      }
      throw new Error(`unexpected profile request: ${request.url}`);
    });

    await invoke('github', { code: 'provider-code', state: 'state-123' });

    expect(mocks.externalFetch).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://api.github.com/user/emails' }),
    );
    expect(mocks.upsertUserFromOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'verified-owner@example.com' }),
    );
    expect(mocks.upsertUserFromOAuth).not.toHaveBeenCalledWith(
      expect.objectContaining({ email: 'unverified-claim@example.com' }),
    );
  });

  it('redirects to an adopted legacy builder when org resolution returns isNew false', async () => {
    mockSuccessfulDbFlow('github');
    mocks.findOrCreateBuilderForUser.mockResolvedValue({
      builderId: 'builder-legacy',
      slug: 'legacy-workspace',
      role: 'owner',
      tier: 'scale',
      isNew: false,
    });

    const response = await invoke('github', { code: 'provider-code', state: 'state-123' });

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://app.example.com/o/legacy-workspace/dashboard',
    );
    expect(mocks.signJwt).toHaveBeenCalledWith(
      expect.objectContaining({
        builder_id: 'builder-legacy',
        role: 'owner',
        tier: 'scale',
      }),
    );
  });

  it('keeps the completed session when the final audit log write fails', async () => {
    mockSuccessfulDbFlow('github');
    mocks.withRLS.mockRejectedValue(new Error('audit connection reset for leaked@example.com'));

    const response = await invoke('github', { code: 'provider-code', state: 'state-123' });

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://app.example.com/o/oauth-user/dashboard');
    const setCookie = response.headers.get('set-cookie');
    expect(setCookie).toContain('pylva_session=signed-dashboard-jwt');
    expect(setCookie).toContain(`${flowNames.state}=`);
    expect(setCookie).toContain(`${flowNames.nonce}=`);
    expect(setCookie).toContain(`${flowNames.pkce}=`);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'github',
        stage: 'audit_log',
        error_name: 'Error',
      }),
      'oauth audit log failed after session creation',
    );
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain('leaked@example.com');
  });

  it('redirects user upsert failures and logs only safe stage/provider metadata', async () => {
    mocks.exchangeOAuthCode.mockResolvedValue({
      accessToken: () => 'github-access-token',
    });
    mocks.upsertUserFromOAuth.mockRejectedValue(
      new Error('duplicate key for leaked@example.com with code provider-code'),
    );

    const response = await invoke('github', { code: 'provider-code', state: 'state-123' });

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://app.example.com/login?error=oauth_failed',
    );
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'github',
        stage: 'user_upsert',
        error_name: 'Error',
      }),
      'oauth callback failed',
    );
    const serializedLogs = JSON.stringify(mocks.warn.mock.calls);
    expect(serializedLogs).not.toContain('leaked@example.com');
    expect(serializedLogs).not.toContain('provider-code');
  });

  it('redirects org resolution failures and logs only safe stage/provider metadata', async () => {
    mocks.exchangeOAuthCode.mockResolvedValue({
      accessToken: () => 'github-access-token',
    });
    mocks.upsertUserFromOAuth.mockResolvedValue({
      userId: 'user-1',
      isNew: false,
      email: 'github@example.com',
      displayName: 'OAuth User',
      avatarUrl: null,
      previousAuthProvider: null,
    });
    mocks.findOrCreateBuilderForUser.mockRejectedValue(
      new Error('duplicate key for leaked@example.com with code provider-code'),
    );

    const response = await invoke('github', { code: 'provider-code', state: 'state-123' });

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://app.example.com/login?error=oauth_failed',
    );
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'github',
        stage: 'org_create',
        error_name: 'Error',
      }),
      'oauth callback failed',
    );
    const serializedLogs = JSON.stringify(mocks.warn.mock.calls);
    expect(serializedLogs).not.toContain('leaked@example.com');
    expect(serializedLogs).not.toContain('provider-code');
  });
});
