import crypto from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest, NextResponse } from 'next/server.js';

process.env['GITHUB_OAUTH_CLIENT_ID'] = 'github-client-id';
process.env['GITHUB_OAUTH_CLIENT_SECRET'] = 'github-client-secret';
process.env['GOOGLE_OAUTH_CLIENT_ID'] = 'google-client-id';
process.env['GOOGLE_OAUTH_CLIENT_SECRET'] = 'google-client-secret';
process.env['OAUTH_REDIRECT_BASE_URL'] = 'https://app.example.com';
process.env['SESSION_COOKIE_NAME'] = 'pylva_session';
process.env['SESSION_COOKIE_SECURE'] = 'true';

const mocks = vi.hoisted(() => ({
  auditLog: vi.fn(),
  externalFetch: vi.fn(),
  setDashboardSessionCookies: vi.fn(),
  setActiveSessionCookie: vi.fn(),
  setRefreshCookie: vi.fn(),
  signJwt: vi.fn(),
  withRLS: vi.fn(),
}));

vi.mock('@/lib/external-egress', () => ({ externalFetch: mocks.externalFetch }));
vi.mock('@/lib/auth/jwt', () => ({ signJwt: mocks.signJwt }));
vi.mock('@/lib/auth/middleware', () => ({
  setDashboardSessionCookies: mocks.setDashboardSessionCookies,
  setActiveSessionCookie: mocks.setActiveSessionCookie,
  setRefreshCookie: mocks.setRefreshCookie,
}));
vi.mock('@/lib/auth/audit-log', () => ({ auditLog: mocks.auditLog }));
vi.mock('@/lib/db/rls', () => ({ withRLS: mocks.withRLS }));

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://pylva:pylva_dev@localhost:5432/pylva';
const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });

const authOAuth = await import('../../src/lib/auth/oauth.js');
const { GET } = await import('../../src/app/api/v1/auth/oauth/[provider]/callback/route.js');

type Provider = 'github' | 'google';

function cookieRequest(provider: Provider, state: string, hmac: string): NextRequest {
  const url = new URL(`https://app.example.com/api/v1/auth/oauth/${provider}/callback`);
  url.searchParams.set('code', 'provider-code');
  url.searchParams.set('state', state);
  const names = authOAuth.oauthCookieNames(state);
  const cookies: Record<string, string> = {
    [names.nonce]: hmac,
    [names.pkce]: 'pkce-verifier',
    [names.state]: state,
  };
  return {
    url: url.toString(),
    cookies: {
      get: (name: string) => {
        const value = cookies[name];
        return value === undefined ? undefined : { name, value };
      },
      getAll: () => Object.entries(cookies).map(([name, value]) => ({ name, value })),
    },
  } as unknown as NextRequest;
}

async function invoke(provider: Provider, state: string, hmac: string): Promise<NextResponse> {
  return GET(cookieRequest(provider, state, hmac), {
    params: Promise.resolve({ provider }),
  });
}

async function cleanupEmail(email: string): Promise<void> {
  await sql`DELETE FROM builders WHERE lower(email) = ${email.toLowerCase()}`;
  await sql`DELETE FROM users WHERE lower(email::text) = ${email.toLowerCase()}`;
}

function mockProvider(provider: Provider, email: string): void {
  mocks.externalFetch.mockImplementation(async (request: { url: string }) => {
    if (
      request.url === 'https://github.com/login/oauth/access_token' ||
      request.url === 'https://oauth2.googleapis.com/token'
    ) {
      return {
        body: JSON.stringify({ access_token: `${provider}-access-token`, token_type: 'bearer' }),
        headers: {},
        status: 200,
        statusText: 'OK',
      };
    }
    if (request.url === 'https://api.github.com/user') {
      return {
        body: JSON.stringify({
          avatar_url: 'https://avatars.githubusercontent.com/u/123',
          email: null,
          id: 123,
          login: 'oauth-route-user',
          name: 'OAuth Route Owner',
        }),
        headers: {},
        status: 200,
        statusText: 'OK',
      };
    }
    if (request.url === 'https://api.github.com/user/emails') {
      return {
        body: JSON.stringify([{ email, primary: true, verified: true }]),
        headers: {},
        status: 200,
        statusText: 'OK',
      };
    }
    if (request.url === 'https://openidconnect.googleapis.com/v1/userinfo') {
      return {
        body: JSON.stringify({
          sub: 'google-subject',
          email,
          email_verified: true,
          name: 'OAuth Route Owner',
          picture: 'https://lh3.googleusercontent.com/avatar',
        }),
        headers: {},
        status: 200,
        statusText: 'OK',
      };
    }
    throw new Error(`unexpected external request: ${request.url}`);
  });
}

describe('OAuth callback legacy builder adoption integration', () => {
  beforeEach(() => {
    mocks.auditLog.mockReset();
    mocks.externalFetch.mockReset();
    mocks.setDashboardSessionCookies.mockReset();
    mocks.setActiveSessionCookie.mockReset();
    mocks.setRefreshCookie.mockReset();
    mocks.signJwt.mockReset();
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

  afterAll(async () => {
    await sql.end();
  });

  it.each([{ provider: 'github' as const }, { provider: 'google' as const }])(
    'adopts the same legacy builder idempotently through $provider',
    async ({ provider }) => {
      const suffix = crypto.randomBytes(6).toString('hex');
      const loginEmail = `oauth-${provider}-${suffix}@example.com`;
      const builderEmail = provider === 'google' ? loginEmail.toUpperCase() : loginEmail;
      const slug = `oauth-${provider}-${suffix}`;
      await cleanupEmail(loginEmail);

      try {
        const [builder] = await sql<{ id: string }[]>`
          INSERT INTO builders (email, name, tier, slug)
          VALUES (${builderEmail}, 'OAuth Route Legacy', 'scale', ${slug})
          RETURNING id
        `;
        await sql`
          INSERT INTO api_keys (key_id, builder_id, key_hash, scope, label)
          VALUES (${crypto.randomBytes(6).toString('hex')}, ${builder!.id}, 'stable-hash', 'agent_sdk', 'legacy key')
        `;
        mockProvider(provider, loginEmail);

        const firstState = authOAuth.generateOAuthState();
        const first = await invoke(provider, firstState.raw, firstState.hmac);
        const secondState = authOAuth.generateOAuthState();
        const second = await invoke(provider, secondState.raw, secondState.hmac);

        for (const response of [first, second]) {
          expect(response.status).toBe(307);
          expect(response.headers.get('location')).toBe(
            `https://app.example.com/o/${slug}/dashboard`,
          );
          expect(response.headers.get('set-cookie')).toContain(
            'pylva_session=signed-dashboard-jwt',
          );
        }

        const memberships = await sql<{ role: string; user_email: string }[]>`
          SELECT m.role, u.email::text AS user_email
          FROM user_builder_memberships m
          JOIN users u ON u.id = m.user_id
          WHERE m.builder_id = ${builder!.id}
        `;
        expect(memberships).toEqual([{ role: 'owner', user_email: loginEmail }]);
        const keys = await sql<{ count: string }[]>`
          SELECT count(*)::text AS count FROM api_keys WHERE builder_id = ${builder!.id}
        `;
        expect(keys[0]!.count).toBe('1');
        expect(mocks.signJwt).toHaveBeenLastCalledWith(
          expect.objectContaining({ builder_id: builder!.id, role: 'owner', tier: 'scale' }),
        );
      } finally {
        await cleanupEmail(loginEmail);
      }
    },
  );
});
