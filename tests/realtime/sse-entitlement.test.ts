import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server.js';

const mocks = vi.hoisted(() => ({
  authorizeBuilderCapability: vi.fn(),
  acquireSseConnection: vi.fn(),
  getOverview: vi.fn(),
  getTopEndUsers: vi.fn(),
  subscribeFeed: vi.fn(),
}));

vi.mock('../../src/lib/config.js', () => ({
  env: { ENABLE_SSE_FEED: true, NODE_ENV: 'test' },
}));

vi.mock('../../src/lib/auth/builder-context.js', () => ({
  readBuilderContextFromDashboard: () => ({ builderId: 'builder-a' }),
}));

vi.mock('../../src/lib/auth/builder-entitlement.js', () => ({
  authorizeBuilderCapability: mocks.authorizeBuilderCapability,
  accessDeniedMessage: () => 'Workspace access is unavailable',
}));

vi.mock('../../src/lib/realtime/sse-manager.js', () => ({
  acquireSseConnection: mocks.acquireSseConnection,
}));

vi.mock('../../src/lib/realtime/feed-subscriber.js', () => ({
  subscribeFeed: mocks.subscribeFeed,
}));

vi.mock('../../src/lib/clickhouse/dashboard-queries.js', () => ({
  getOverview: mocks.getOverview,
  getTopEndUsers: mocks.getTopEndUsers,
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

describe('SSE workspace lifecycle gate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not allocate or query a feed without product access', async () => {
    mocks.authorizeBuilderCapability.mockResolvedValue({ allowed: false });
    const request = new Request('http://localhost/api/v1/feed/stream') as unknown as NextRequest;

    const response = await GET(request);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'FEATURE_NOT_AVAILABLE',
        message: 'Workspace access is unavailable',
      },
    });
    expect(mocks.acquireSseConnection).not.toHaveBeenCalled();
    expect(mocks.subscribeFeed).not.toHaveBeenCalled();
    expect(mocks.getOverview).not.toHaveBeenCalled();
    expect(mocks.getTopEndUsers).not.toHaveBeenCalled();
  });
});
