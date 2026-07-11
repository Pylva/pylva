import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server.js';
import { decodeOAuthStateNext } from '@/lib/auth/post-auth-redirect';

const testEnv = vi.hoisted(() => ({
  ARGON2_SECRET: 'oauth-test-secret',
  DATABASE_URL: 'postgresql://pylva:pylva_dev@localhost:5432/pylva',
  CLICKHOUSE_URL: 'http://localhost:8123',
  REDIS_URL: 'redis://localhost:6379',
  JWT_PRIVATE_KEY: '/tmp/pylva-test-private.pem',
  JWT_PUBLIC_KEY: '/tmp/pylva-test-public.pem',
  NODE_ENV: 'production',
  LOG_LEVEL: 'silent',
  OAUTH_REDIRECT_BASE_URL: 'https://app.example.com',
  GITHUB_OAUTH_CLIENT_ID: 'github-client-id',
  GITHUB_OAUTH_CLIENT_SECRET: 'github-client-secret',
  GOOGLE_OAUTH_CLIENT_ID: 'google-client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'google-client-secret',
  SESSION_COOKIE_SECURE: true,
}));

vi.mock('@/lib/config', () => ({ env: testEnv }));
vi.mock('../../src/lib/config.js', () => ({ env: testEnv }));
vi.mock('../../src/lib/db/client.js', () => ({ db: {} }));

process.env['ARGON2_SECRET'] = testEnv.ARGON2_SECRET;

const { GET } = await import('../../src/app/api/v1/auth/oauth/[provider]/route.js');
const { oauthCookieNames } = await import('../../src/lib/auth/oauth.js');

function cookieValue(setCookie: string, name: string): string | null {
  const match = setCookie.match(new RegExp(`${name.replaceAll('.', '\\.')}=([^;,]+)`));
  return match?.[1] ?? null;
}

function pkceChallenge(codeVerifier: string): string {
  return crypto.createHash('sha256').update(codeVerifier).digest('base64url');
}

describe('GET /api/v1/auth/oauth/[provider]', () => {
  it.each([
    {
      provider: 'github',
      host: 'github.com',
      clientId: 'github-client-id',
      scopes: ['read:user', 'user:email'],
    },
    {
      provider: 'google',
      host: 'accounts.google.com',
      clientId: 'google-client-id',
      scopes: ['openid', 'email', 'profile'],
    },
  ])(
    'redirects $provider with secure state, nonce, PKCE, and staging callback URL',
    async (entry) => {
      const response = await GET(
        new NextRequest(`https://app.example.com/api/v1/auth/oauth/${entry.provider}`),
        { params: Promise.resolve({ provider: entry.provider }) },
      );

      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toBeTruthy();
      const redirect = new URL(location!);

      expect(redirect.hostname).toBe(entry.host);
      expect(redirect.searchParams.get('client_id')).toBe(entry.clientId);
      expect(redirect.searchParams.get('redirect_uri')).toBe(
        `https://app.example.com/api/v1/auth/oauth/${entry.provider}/callback`,
      );
      expect(redirect.searchParams.get('response_type')).toBe('code');
      expect(redirect.searchParams.get('code_challenge_method')).toBe('S256');
      for (const scope of entry.scopes) {
        expect(redirect.searchParams.get('scope')?.split(' ')).toContain(scope);
      }

      const state = redirect.searchParams.get('state');
      expect(state).toBeTruthy();
      const names = oauthCookieNames(state!);

      const setCookie = response.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain(`${names.state}=`);
      expect(setCookie).toContain(`${names.nonce}=`);
      expect(setCookie).toContain(`${names.pkce}=`);
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Secure');
      expect(setCookie).toContain('SameSite=lax');

      const stateCookie = cookieValue(setCookie, names.state);
      const pkceCookie = cookieValue(setCookie, names.pkce);
      expect(stateCookie).toBe(state);
      expect(pkceCookie).toBeTruthy();
      expect(redirect.searchParams.get('code_challenge')).toBe(pkceChallenge(pkceCookie!));
    },
  );

  it('embeds a validated next in the state and sets cookies under the derived names', async () => {
    const response = await GET(
      new NextRequest(
        'https://app.example.com/api/v1/auth/oauth/github?next=%2Fo%2Facme%2Fdashboard%2Frules',
      ),
      { params: Promise.resolve({ provider: 'github' }) },
    );

    const redirect = new URL(response.headers.get('location')!);
    const state = redirect.searchParams.get('state')!;
    expect(state.startsWith('v1.')).toBe(true);
    expect(decodeOAuthStateNext(state)).toBe('/o/acme/dashboard/rules');

    const names = oauthCookieNames(state);
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${names.state}=`);
    expect(setCookie).toContain(`${names.nonce}=`);
    expect(setCookie).toContain(`${names.pkce}=`);
    expect(cookieValue(setCookie, names.state)).toBe(state);
  });

  it('falls back to a bare nonce state when next is not an allowed dashboard path', async () => {
    const response = await GET(
      new NextRequest(
        'https://app.example.com/api/v1/auth/oauth/github?next=https%3A%2F%2Fevil.com',
      ),
      { params: Promise.resolve({ provider: 'github' }) },
    );

    const redirect = new URL(response.headers.get('location')!);
    const state = redirect.searchParams.get('state')!;
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    expect(decodeOAuthStateNext(state)).toBeNull();
  });

  // Header-bloat backstop: the sweep fires only at >= 15 accumulated
  // pylva_oauth* cookies (5 pending flows × 3), clearing ALL of them; below
  // that, concurrent pending flows must be left alone.
  function staleFlowCookieNames(count: number): string[] {
    const names: string[] = [];
    for (let i = 0; names.length < count; i += 1) {
      const flow = oauthCookieNames(`stale-flow-${i}`);
      names.push(flow.state, flow.nonce, flow.pkce);
    }
    return names.slice(0, count);
  }

  async function initiateWithExistingCookies(names: string[]): Promise<{
    setCookie: string;
    newFlowNames: { state: string; nonce: string; pkce: string };
    state: string;
  }> {
    const response = await GET(
      new NextRequest('https://app.example.com/api/v1/auth/oauth/github', {
        headers: { cookie: names.map((name) => `${name}=cookie-value`).join('; ') },
      }),
      { params: Promise.resolve({ provider: 'github' }) },
    );
    expect(response.status).toBe(307);
    const state = new URL(response.headers.get('location')!).searchParams.get('state')!;
    return {
      setCookie: response.headers.get('set-cookie') ?? '',
      newFlowNames: oauthCookieNames(state),
      state,
    };
  }

  it('leaves 14 existing flow cookies untouched (below the sweep threshold)', async () => {
    const existing = staleFlowCookieNames(14);

    const { setCookie, newFlowNames, state } = await initiateWithExistingCookies(existing);

    for (const name of existing) {
      expect(setCookie).not.toContain(name);
    }
    expect(cookieValue(setCookie, newFlowNames.state)).toBe(state);
    expect(cookieValue(setCookie, newFlowNames.nonce)).toBeTruthy();
    expect(cookieValue(setCookie, newFlowNames.pkce)).toBeTruthy();
  });

  it('sweeps all 15 accumulated flow cookies and still sets the new flow triplet', async () => {
    const existing = staleFlowCookieNames(15);

    const { setCookie, newFlowNames, state } = await initiateWithExistingCookies(existing);

    for (const name of existing) {
      expect(setCookie).toContain(`${name}=;`);
    }
    expect(cookieValue(setCookie, newFlowNames.state)).toBe(state);
    expect(cookieValue(setCookie, newFlowNames.nonce)).toBeTruthy();
    expect(cookieValue(setCookie, newFlowNames.pkce)).toBeTruthy();
  });
});
