// Revocation fail-closed unit test. Redis is mocked; the REAL revocationBreaker
// (opossum) wraps it, so the fallback path (breaker → null) is exercised through
// the production code. Dashboard/portal must fail CLOSED (treat as revoked) when
// Redis is unavailable; websocket stays fail-open.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JwtAudience } from '@pylva/shared';

const mocks = vi.hoisted(() => ({
  exists: vi.fn(),
  ensureRedis: vi.fn(async () => {}),
}));

vi.mock('@/lib/config', () => ({ env: {} }));
vi.mock('../../src/lib/config.js', () => ({ env: {} }));
vi.mock('@/lib/redis/client', () => ({
  redisClient: { exists: mocks.exists },
  ensureRedisCommandClient: mocks.ensureRedis,
}));
vi.mock('../../src/lib/redis/client.js', () => ({
  redisClient: { exists: mocks.exists },
  ensureRedisCommandClient: mocks.ensureRedis,
}));

import { checkRevocation } from '@/lib/auth/jwt';

beforeEach(() => {
  mocks.exists.mockReset();
  mocks.ensureRedis.mockReset();
  mocks.ensureRedis.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('checkRevocation', () => {
  it('reports revoked when Redis says the jti exists', async () => {
    mocks.exists.mockResolvedValue(1);
    expect(await checkRevocation('jti-1', JwtAudience.DASHBOARD)).toBe(true);
  });

  it('reports not-revoked when Redis says the jti is absent', async () => {
    mocks.exists.mockResolvedValue(0);
    expect(await checkRevocation('jti-2', JwtAudience.DASHBOARD)).toBe(false);
  });

  it('fails CLOSED for dashboard tokens when Redis is unavailable', async () => {
    mocks.exists.mockRejectedValue(new Error('redis down'));
    expect(await checkRevocation('jti-3', JwtAudience.DASHBOARD)).toBe(true);
  });

  it('fails CLOSED for portal tokens when Redis is unavailable', async () => {
    mocks.exists.mockRejectedValue(new Error('redis down'));
    expect(await checkRevocation('jti-4', JwtAudience.PORTAL)).toBe(true);
  });

  it('stays fail-open for short-lived websocket tokens', async () => {
    mocks.exists.mockRejectedValue(new Error('redis down'));
    expect(await checkRevocation('jti-5', JwtAudience.WEBSOCKET)).toBe(false);
  });
});
