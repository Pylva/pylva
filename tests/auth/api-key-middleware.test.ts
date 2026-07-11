import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server.js';
import { ApiKeyScope } from '@pylva/shared';

const mocks = vi.hoisted(() => ({
  validateApiKey: vi.fn(),
  env: {
    REDIS_URL: 'redis://localhost:6379',
    JWT_PRIVATE_KEY: '/dev/null',
    JWT_PUBLIC_KEY: '/dev/null',
    SESSION_COOKIE_NAME: 'pylva_session',
    SESSION_COOKIE_SECURE: false,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
  },
}));

vi.mock('../../src/lib/auth/api-key.js', () => ({
  validateApiKey: mocks.validateApiKey,
}));

vi.mock('../../src/lib/config.js', () => ({ env: mocks.env }));

const { withApiKeyAuth } = await import('../../src/lib/auth/middleware.js');

function request(headers: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost/api/v1/cost-sources', { headers });
}

interface ErrorBody {
  error: {
    message: string;
  };
}

async function errorMessage(result: unknown): Promise<string> {
  expect(result).toBeInstanceOf(NextResponse);
  if (!(result instanceof NextResponse)) throw new Error('expected auth error response');
  const body = (await result.json()) as ErrorBody;
  return body.error.message;
}

describe('withApiKeyAuth', () => {
  beforeEach(() => {
    mocks.validateApiKey.mockReset();
  });

  it('accepts the CLI bearer API key header used by cost-source approval', async () => {
    const key = `pv_cli_deadbeef_${'a'.repeat(32)}`;
    mocks.validateApiKey.mockResolvedValueOnce({
      builderId: 'builder-1',
      scope: ApiKeyScope.UNIVERSAL,
      keyId: 'deadbeef',
    });

    const result = await withApiKeyAuth(request({ authorization: `Bearer ${key}` }));

    expect(result).not.toBeInstanceOf(NextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith(key);
    expect(result).toEqual({
      builderId: 'builder-1',
      scope: ApiKeyScope.UNIVERSAL,
      keyId: 'deadbeef',
    });
  });

  it('keeps accepting the documented X-Pylva-Key header', async () => {
    const key = `pv_live_1234abcd_${'b'.repeat(32)}`;
    mocks.validateApiKey.mockResolvedValueOnce({
      builderId: 'builder-2',
      scope: ApiKeyScope.UNIVERSAL,
      keyId: '1234abcd',
    });

    const result = await withApiKeyAuth(request({ 'X-Pylva-Key': key }));

    expect(result).not.toBeInstanceOf(NextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith(key);
  });

  it('rejects a missing key with a useful message', async () => {
    const result = await withApiKeyAuth(request({}));

    expect(mocks.validateApiKey).not.toHaveBeenCalled();
    const message = await errorMessage(result);
    expect(message).toContain('Authorization: Bearer');
    expect(message).toContain('X-Pylva-Key');
  });

  it('rejects malformed bearer API keys with a useful message', async () => {
    const result = await withApiKeyAuth(
      request({ authorization: `Bearer pv_cli_deadbeef_${'a'.repeat(31)}` }),
    );

    expect(mocks.validateApiKey).not.toHaveBeenCalled();
    const message = await errorMessage(result);
    expect(message).toContain('Authorization: Bearer');
    expect(message).toContain('X-Pylva-Key');
  });

  it('does not pass uppercase bearer key material to validation', async () => {
    const result = await withApiKeyAuth(
      request({ authorization: `Bearer pv_cli_DEADBEEF_${'A'.repeat(32)}` }),
    );

    expect(mocks.validateApiKey).not.toHaveBeenCalled();
    await expect(errorMessage(result)).resolves.toContain('pv_(live|cli)_{keyId}_{randomPart}');
  });

  it('rejects an invalid key when validation fails', async () => {
    mocks.validateApiKey.mockResolvedValueOnce(null);

    const result = await withApiKeyAuth(
      request({ authorization: `Bearer pv_live_deadbeef_${'e'.repeat(32)}` }),
    );

    await expect(errorMessage(result)).resolves.toContain('Invalid API key');
  });

  // One universal key (migration 048): authorization never branches on the
  // persisted scope. Legacy rows — pre-041 aliases, pre-048 scopes, or any
  // straggler value — authenticate exactly like universal keys.
  it.each([
    ['telemetry'],
    ['pricing_admin'],
    ['cost_sources_write'],
    [ApiKeyScope.AGENT_SDK],
    [ApiKeyScope.ADMIN_API],
    [ApiKeyScope.DATA_IMPORT],
    [ApiKeyScope.UNIVERSAL],
    ['some_future_scope'],
  ])('authenticates a key whose persisted scope is %s', async (persistedScope) => {
    const key = `pv_live_deadbeef_${'c'.repeat(32)}`;
    mocks.validateApiKey.mockResolvedValueOnce({
      builderId: 'builder-legacy',
      scope: persistedScope,
      keyId: 'deadbeef',
    });

    const result = await withApiKeyAuth(request({ authorization: `Bearer ${key}` }));

    expect(result).not.toBeInstanceOf(NextResponse);
    expect(result).toEqual({
      builderId: 'builder-legacy',
      scope: persistedScope,
      keyId: 'deadbeef',
    });
  });
});
