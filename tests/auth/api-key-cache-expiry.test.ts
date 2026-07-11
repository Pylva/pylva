// Regression test: a cached API key must stop authenticating the moment its
// real DB expiry passes, even if the (short) cache TTL has not. Before the fix a
// cache hit ignored the row's expires_at and served the key until the cache TTL
// lapsed. DB, argon2, redis, and config are mocked; fake timers drive expiry.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let nextRows: unknown[] = [];

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  verify: vi.fn(async () => true),
}));

vi.mock('argon2', () => ({
  default: { verify: mocks.verify, hash: vi.fn(async () => 'hash') },
}));
vi.mock('@/lib/config', () => ({ env: { ARGON2_SECRET: 'test-secret' } }));
vi.mock('../../src/lib/config.js', () => ({ env: { ARGON2_SECRET: 'test-secret' } }));
vi.mock('@/lib/db/client', () => ({ db: { select: mocks.select } }));
vi.mock('../../src/lib/db/client.js', () => ({ db: { select: mocks.select } }));
vi.mock('@/lib/redis/client', () => ({ redisClient: {}, redisPubSubClient: {} }));
vi.mock('../../src/lib/redis/client.js', () => ({ redisClient: {}, redisPubSubClient: {} }));
vi.mock('@/lib/redis/circuit-breaker', () => ({ cacheBreaker: { fire: vi.fn() } }));
vi.mock('../../src/lib/redis/circuit-breaker.js', () => ({ cacheBreaker: { fire: vi.fn() } }));

import { validateApiKey } from '@/lib/auth/api-key';

const KEY = `pv_live_deadbeef_${'a'.repeat(32)}`;

beforeEach(() => {
  // Chainable Drizzle stub: select().from().where().limit() resolves to nextRows.
  mocks.select.mockImplementation(() => ({
    from: () => ({ where: () => ({ limit: async () => nextRows }) }),
  }));
  mocks.verify.mockResolvedValue(true);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-08T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('validateApiKey cache honors real DB expiry on hit', () => {
  it('re-reads (and rejects) once the key expires, even within the cache TTL', async () => {
    const expiresAt = new Date(Date.now() + 100); // key expires in 100ms
    nextRows = [
      {
        key_id: 'deadbeef',
        builder_id: 'b1',
        scope: 'admin_api',
        key_hash: 'hash',
        revoked_at: null,
        expires_at: expiresAt,
      },
    ];

    const first = await validateApiKey(KEY);
    expect(first).toEqual({ builderId: 'b1', scope: 'admin_api', keyId: 'deadbeef' });
    expect(mocks.select).toHaveBeenCalledTimes(1); // populated cache from DB

    // Advance past the key's real expiry but well within the 10s cache TTL.
    vi.advanceTimersByTime(500);
    nextRows = []; // DB now returns nothing (expired/gone)

    const second = await validateApiKey(KEY);
    expect(second).toBeNull(); // rejected, not served from stale cache
    expect(mocks.select).toHaveBeenCalledTimes(2); // forced a fresh DB read
  });
});
