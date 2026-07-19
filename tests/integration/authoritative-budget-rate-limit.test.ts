import crypto from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({
  validateApiKey: vi.fn(),
}));

vi.mock('../../src/lib/auth/api-key.js', () => ({
  validateApiKey: authMocks.validateApiKey,
}));

const { NextRequest } = await import('next/server.js');
const { middleware } = await import('../../src/middleware.js');
const { ensureRedisCommandClient, redisClient } = await import('../../src/lib/redis/client.js');
const { _resetConfigForTests, init } = await import('../../packages/sdk-ts/src/core/config.js');
const { _resetControlClientForTests, reserveUsage } =
  await import('../../packages/sdk-ts/src/core/control_client.js');

const CONTROL_LIMIT = 600;
const WINDOW_MS = 60_000;
const ENDPOINT = 'http://control.integration.test';
const BUILDER_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const TRACE_ID = '33333333-3333-4333-8333-333333333333';
const SPAN_ID = '44444444-4444-4444-8444-444444444444';

let bucketKey: string | undefined;

function authoritativeRequest(pathname: string, apiKey: string): InstanceType<typeof NextRequest> {
  return new NextRequest(`${ENDPOINT}${pathname}`, {
    method: pathname.endsWith('/capabilities') ? 'GET' : 'POST',
    headers: {
      'X-Pylva-Key': apiKey,
      'Content-Type': 'application/json',
    },
    ...(pathname.endsWith('/capabilities') ? {} : { body: '{}' }),
  });
}

describe('authoritative budget-control Redis rate limiting', () => {
  beforeEach(async () => {
    _resetControlClientForTests();
    _resetConfigForTests();
    authMocks.validateApiKey.mockReset();
    await ensureRedisCommandClient();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    _resetControlClientForTests();
    _resetConfigForTests();
    if (bucketKey !== undefined) {
      await redisClient.del(bucketKey);
      bucketKey = undefined;
    }
  });

  afterAll(async () => {
    if (redisClient.isOpen) await redisClient.quit();
  });

  it('returns the exact no-store 429 and maps it to rate_limited without replaying 601 auth calls', async () => {
    const keyId = crypto.randomBytes(4).toString('hex');
    const apiKey = `pv_live_${keyId}_${'a'.repeat(32)}`;
    const stableNow = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS + WINDOW_MS / 2;
    vi.spyOn(Date, 'now').mockReturnValue(stableNow);
    bucketKey = `rate_limit:budget_control:${keyId}:${Math.floor(stableNow / WINDOW_MS)}`;
    await redisClient.set(bucketKey, String(CONTROL_LIMIT), { PX: WINDOW_MS });
    authMocks.validateApiKey.mockResolvedValue({
      builderId: BUILDER_ID,
      scope: 'universal',
      keyId,
    });

    const response = await middleware(authoritativeRequest('/api/v1/budget/reservations', apiKey));
    expect(response.status).toBe(429);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Retry-After')).toBe('60');
    await expect(response.json()).resolves.toEqual({
      error: {
        type: 'rate_limit_error',
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Rate limit exceeded. Retry after 60 seconds.',
      },
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      const headers = new Headers(init?.headers);
      return middleware(
        new NextRequest(url, {
          method: init?.method ?? 'GET',
          headers,
          ...(init?.body === undefined || init.body === null ? {} : { body: String(init.body) }),
        }),
      );
    });
    init({
      apiKey,
      endpoint: ENDPOINT,
      control: { mode: 'enforce', onUnavailable: 'allow' },
    });

    await expect(
      reserveUsage({
        kind: 'llm',
        operationId: OPERATION_ID,
        customerId: 'rate_limited_customer',
        traceId: TRACE_ID,
        spanId: SPAN_ID,
        parentSpanId: null,
        stepName: 'rate_limit.integration',
        framework: 'langgraph',
        reservationTtlSeconds: 300,
        provider: 'openai',
        model: 'gpt-4.1',
        estimatedInputTokens: 10,
        maxOutputTokens: 10,
      }),
    ).resolves.toMatchObject({
      decision: 'unavailable',
      allowed: false,
      reason: 'control_unavailable',
      controlReason: 'rate_limited',
      retryable: true,
      local: true,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetchSpy.mock.calls[0]?.[0])).pathname).toBe(
      '/api/v1/budget/capabilities',
    );
    expect(authMocks.validateApiKey).toHaveBeenCalledTimes(2);
    await expect(redisClient.get(bucketKey)).resolves.toBe(String(CONTROL_LIMIT + 2));
  });
});
