import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  externalFetch: vi.fn(),
}));

const testEnv = vi.hoisted(() => ({
  ARGON2_SECRET: 'oauth-test-secret',
  DATABASE_URL: 'postgresql://pylva:pylva_dev@localhost:5432/pylva',
  CLICKHOUSE_URL: 'http://localhost:8123',
  REDIS_URL: 'redis://localhost:6379',
  JWT_PRIVATE_KEY: '/tmp/pylva-test-private.pem',
  JWT_PUBLIC_KEY: '/tmp/pylva-test-public.pem',
  NODE_ENV: 'test',
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
vi.mock('@/lib/external-egress', () => ({ externalFetch: mocks.externalFetch }));
vi.mock('../../src/lib/external-egress.js', () => ({ externalFetch: mocks.externalFetch }));

const { OAuthProviderError, exchangeOAuthCode } = await import('../../src/lib/auth/oauth.js');

describe('exchangeOAuthCode', () => {
  beforeEach(() => {
    mocks.externalFetch.mockReset();
  });

  it.each([
    {
      provider: 'github',
      target: 'github',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      clientId: 'github-client-id',
      clientSecret: 'github-client-secret',
    },
    {
      provider: 'google',
      target: 'google_oauth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      clientId: 'google-client-id',
      clientSecret: 'google-client-secret',
    },
  ] as const)('exchanges $provider codes through externalFetch', async (entry) => {
    mocks.externalFetch.mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: {},
      body: JSON.stringify({
        access_token: `${entry.provider}-access-token`,
        token_type: 'bearer',
      }),
    });

    const tokens = await exchangeOAuthCode(entry.provider, 'provider-code', 'pkce-verifier');

    expect(tokens.accessToken()).toBe(`${entry.provider}-access-token`);
    expect(mocks.externalFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        target: entry.target,
        url: entry.tokenUrl,
        method: 'POST',
        timeoutMs: 10_000,
        headers: expect.objectContaining({
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Pylva',
        }),
      }),
    );

    const request = mocks.externalFetch.mock.calls[0]?.[0] as { body: string };
    const body = new URLSearchParams(request.body);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('client_id')).toBe(entry.clientId);
    expect(body.get('client_secret')).toBe(entry.clientSecret);
    expect(body.get('code')).toBe('provider-code');
    expect(body.get('code_verifier')).toBe('pkce-verifier');
    expect(body.get('redirect_uri')).toBe(
      `https://app.example.com/api/v1/auth/oauth/${entry.provider}/callback`,
    );
  });

  it('throws a safe provider error for token endpoint rejection', async () => {
    mocks.externalFetch.mockResolvedValueOnce({
      status: 400,
      statusText: 'Bad Request',
      headers: {},
      body: JSON.stringify({
        error: 'bad_verification_code',
        error_description: 'contains sensitive provider detail',
      }),
    });

    const rejected = exchangeOAuthCode('github', 'provider-code', 'pkce-verifier');
    await expect(rejected).rejects.toMatchObject({
      name: 'OAuthProviderError',
      status: 400,
      code: 'bad_verification_code',
    });
    await expect(rejected).rejects.toBeInstanceOf(OAuthProviderError);
  });
});
