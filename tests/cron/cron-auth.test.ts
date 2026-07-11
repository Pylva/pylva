// verifyCronSecret — shared constant-time CRON_SECRET bearer guard.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: {
    CRON_SECRET: 'test-secret-min-32-chars-aaaaaaaaaaa' as string | undefined,
    NODE_ENV: 'test',
  },
}));

vi.mock('@/lib/config', () => ({ env: mocks.env }));

const { verifyCronSecret } = await import('../../src/lib/cron/auth.js');

function makeRequest(authorization?: string): import('next/server.js').NextRequest {
  const headers: Record<string, string> = {};
  if (authorization) headers.authorization = authorization;
  return new Request('http://localhost/api/cron/anything', {
    method: 'POST',
    headers,
  }) as unknown as import('next/server.js').NextRequest;
}

describe('verifyCronSecret', () => {
  beforeEach(() => {
    mocks.env.CRON_SECRET = 'test-secret-min-32-chars-aaaaaaaaaaa';
  });

  it('accepts the exact bearer token', () => {
    expect(verifyCronSecret(makeRequest('Bearer test-secret-min-32-chars-aaaaaaaaaaa'))).toBe(true);
  });

  it('rejects a wrong token', () => {
    expect(verifyCronSecret(makeRequest('Bearer nope'))).toBe(false);
  });

  it('rejects a correct secret missing the Bearer prefix', () => {
    expect(verifyCronSecret(makeRequest('test-secret-min-32-chars-aaaaaaaaaaa'))).toBe(false);
  });

  it('rejects a token that is a prefix of the secret', () => {
    expect(verifyCronSecret(makeRequest('Bearer test-secret-min-32-chars'))).toBe(false);
  });

  it('rejects a missing authorization header', () => {
    expect(verifyCronSecret(makeRequest())).toBe(false);
  });

  it('fails closed when CRON_SECRET is unset', () => {
    mocks.env.CRON_SECRET = undefined;
    expect(verifyCronSecret(makeRequest('Bearer anything'))).toBe(false);
  });
});
