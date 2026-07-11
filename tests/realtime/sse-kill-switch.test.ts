// B3-T2 — ENABLE_SSE_FEED kill switch returns 503 (I-SSE-10).

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/lib/config.js', () => ({
  env: {
    ENABLE_SSE_FEED: false,
    NODE_ENV: 'test',
  },
}));

// The route short-circuits on the kill switch before touching Redis or
// ClickHouse, but module-level imports still resolve those clients eagerly —
// stub them so the test harness doesn't open real sockets.
vi.mock('../../src/lib/redis/client.js', () => ({
  redisClient: { publish: vi.fn() },
  redisPubSubClient: { subscribe: vi.fn(), unsubscribe: vi.fn() },
}));
vi.mock('../../src/lib/redis/circuit-breaker.js', () => ({
  cacheBreaker: { fire: vi.fn() },
}));
vi.mock('../../src/lib/clickhouse/dashboard-queries.js', () => ({
  getOverview: vi.fn(),
  getTopEndUsers: vi.fn(),
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
  },
}));

const { GET } = await import('../../src/app/api/v1/feed/stream/route.js');

describe('GET /api/v1/feed/stream (I-SSE-10 kill switch)', () => {
  it('returns 503 + FEATURE_NOT_AVAILABLE when ENABLE_SSE_FEED=false', async () => {
    const request = new Request('http://localhost/api/v1/feed/stream', {
      method: 'GET',
      headers: { 'x-builder-id': 'b1' },
    });
    // Cast to NextRequest — handler doesn't access NextRequest-specific APIs
    // before the kill-switch check.
    const response = await GET(request as unknown as import('next/server.js').NextRequest);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.code).toBe('FEATURE_NOT_AVAILABLE');
  });
});
