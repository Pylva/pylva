// Launch perf — membership cache unit tests: hit, miss→Postgres→set,
// fail-open when Redis is down, never-cache-negatives, malformed-entry
// fallback, and invalidation. Redis + org resolver are mocked; the REAL
// cacheBreaker (opossum) wraps the mocked client so the fail-open path is
// exercised through the production code path (breaker fallback → null).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { redisMock, resolveSlugForUserMock } = vi.hoisted(() => ({
  redisMock: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  },
  resolveSlugForUserMock: vi.fn(),
}));

vi.mock('@/lib/redis/client', () => ({
  redisClient: redisMock,
  ensureRedisCommandClient: vi.fn(async () => {}),
}));
vi.mock('../../src/lib/redis/client.js', () => ({
  redisClient: redisMock,
  ensureRedisCommandClient: vi.fn(async () => {}),
}));
vi.mock('@/lib/auth/org', () => ({ resolveSlugForUser: resolveSlugForUserMock }));
vi.mock('../../src/lib/auth/org.js', () => ({
  resolveSlugForUser: resolveSlugForUserMock,
}));
vi.mock('@/lib/logger', () => ({
  logger: { child: () => ({ warn: vi.fn(), info: vi.fn() }) },
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { child: () => ({ warn: vi.fn(), info: vi.fn() }) },
}));

import { invalidateMembershipCache, resolveSlugForUserCached } from '@/lib/auth/membership-cache';

const INPUT = { slug: 'acme', userId: 'user-1' };
const KEY = 'membership:user-1:acme';
const CTX = { builderId: 'b-1', role: 'owner', tier: 'pro' };

beforeEach(() => {
  redisMock.get.mockReset();
  redisMock.set.mockReset();
  redisMock.del.mockReset();
  resolveSlugForUserMock.mockReset();
});

describe('resolveSlugForUserCached', () => {
  it('returns the cached membership without hitting Postgres', async () => {
    redisMock.get.mockResolvedValue(JSON.stringify(CTX));
    const result = await resolveSlugForUserCached(INPUT);
    expect(result).toEqual(CTX);
    expect(redisMock.get).toHaveBeenCalledWith(KEY);
    expect(resolveSlugForUserMock).not.toHaveBeenCalled();
  });

  it('falls back to Postgres on miss and caches the positive result', async () => {
    redisMock.get.mockResolvedValue(null);
    redisMock.set.mockResolvedValue('OK');
    resolveSlugForUserMock.mockResolvedValue(CTX);
    const result = await resolveSlugForUserCached(INPUT);
    expect(result).toEqual(CTX);
    expect(resolveSlugForUserMock).toHaveBeenCalledWith(INPUT);
    expect(redisMock.set).toHaveBeenCalledWith(KEY, JSON.stringify(CTX), {
      EX: 30,
    });
  });

  it('never caches a negative result', async () => {
    redisMock.get.mockResolvedValue(null);
    resolveSlugForUserMock.mockResolvedValue(null);
    const result = await resolveSlugForUserCached(INPUT);
    expect(result).toBeNull();
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it('fails open to Postgres when Redis is down', async () => {
    redisMock.get.mockRejectedValue(new Error('ECONNREFUSED'));
    redisMock.set.mockRejectedValue(new Error('ECONNREFUSED'));
    resolveSlugForUserMock.mockResolvedValue(CTX);
    const result = await resolveSlugForUserCached(INPUT);
    expect(result).toEqual(CTX);
    expect(resolveSlugForUserMock).toHaveBeenCalledWith(INPUT);
  });

  it('treats a malformed cache entry as a miss', async () => {
    redisMock.get.mockResolvedValue('{not json');
    redisMock.set.mockResolvedValue('OK');
    resolveSlugForUserMock.mockResolvedValue(CTX);
    const result = await resolveSlugForUserCached(INPUT);
    expect(result).toEqual(CTX);
    expect(resolveSlugForUserMock).toHaveBeenCalledOnce();
  });

  it('treats a cache entry with an unknown role as a miss', async () => {
    // Defense-in-depth: a garbage role (e.g. a future serialization bug) must
    // re-check Postgres rather than reach the x-user-role header.
    redisMock.get.mockResolvedValue(JSON.stringify({ ...CTX, role: 'superuser' }));
    redisMock.set.mockResolvedValue('OK');
    resolveSlugForUserMock.mockResolvedValue(CTX);
    const result = await resolveSlugForUserCached(INPUT);
    expect(result).toEqual(CTX);
    expect(resolveSlugForUserMock).toHaveBeenCalledOnce();
  });
});

describe('invalidateMembershipCache', () => {
  it('deletes the cache key', async () => {
    redisMock.del.mockResolvedValue(1);
    await invalidateMembershipCache('user-1', 'acme');
    expect(redisMock.del).toHaveBeenCalledWith(KEY);
  });

  it('swallows Redis failures (TTL bounds staleness)', async () => {
    redisMock.del.mockRejectedValue(new Error('down'));
    await expect(invalidateMembershipCache('user-1', 'acme')).resolves.toBeUndefined();
  });
});
