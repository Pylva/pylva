import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const execMock = vi.fn();
  const sAddMock = vi.fn();
  const sRemMock = vi.fn();
  const pExpireMock = vi.fn();
  const multiMock = vi.fn(() => ({
    sAdd: sAddMock,
    sRem: sRemMock,
    pExpire: pExpireMock,
    exec: execMock,
  }));
  const fireMock = vi.fn(async (fn: () => unknown) => fn());
  return { execMock, sAddMock, sRemMock, pExpireMock, multiMock, fireMock };
});

vi.mock('../../src/lib/redis/client.js', () => ({
  redisClient: { multi: mocks.multiMock },
}));

vi.mock('../../src/lib/redis/circuit-breaker.js', () => ({
  cacheBreaker: { fire: mocks.fireMock },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

describe('ingest Redis dedup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fireMock.mockImplementation(async (fn: () => unknown) => fn());
  });

  it('filters duplicates from Redis SADD replies', async () => {
    mocks.execMock.mockResolvedValueOnce([1, 1, 0, 1]);
    const { filterDuplicates } = await import('../../src/lib/ingest/dedup');

    const kept = await filterDuplicates('builder-a', [
      { span_id: 'new-span', timestamp: '2026-06-04T10:15:00.000Z' },
      { span_id: 'duplicate-span', timestamp: '2026-06-04T10:16:00.000Z' },
    ]);

    expect([...kept]).toEqual(['new-span']);
    expect(mocks.sAddMock).toHaveBeenCalledWith('dedup:builder-a:494602', 'new-span');
    expect(mocks.sAddMock).toHaveBeenCalledWith('dedup:builder-a:494602', 'duplicate-span');
  });

  it('undoes only newly kept span_ids after insert failure', async () => {
    mocks.execMock.mockResolvedValueOnce([1]);
    const { undoFilterDuplicates } = await import('../../src/lib/ingest/dedup');

    await undoFilterDuplicates('builder-a', [
      { span_id: 'new-span', timestamp: '2026-06-04T10:15:00.000Z' },
    ]);

    expect(mocks.sRemMock).toHaveBeenCalledTimes(1);
    expect(mocks.sRemMock).toHaveBeenCalledWith('dedup:builder-a:494602', 'new-span');
    expect(mocks.sRemMock).not.toHaveBeenCalledWith(expect.any(String), 'duplicate-span');
  });

  it('does not throw when Redis breaker fallback skips undo', async () => {
    mocks.fireMock.mockResolvedValueOnce(null);
    const { undoFilterDuplicates } = await import('../../src/lib/ingest/dedup');

    await expect(
      undoFilterDuplicates('builder-a', [
        { span_id: 'new-span', timestamp: '2026-06-04T10:15:00.000Z' },
      ]),
    ).resolves.toBeUndefined();
  });
});
