// Regression: a client that disconnects WHILE the initial snapshot query is
// still in flight must still release its connection-slot lease and tear down
// the Redis subscription consumer. Previously the route registered its abort
// listener only AFTER awaiting the snapshot — and `addEventListener('abort')`
// on an already-aborted signal never fires — so the heartbeat timer, the lease
// slot (toward the 50-connection cap), and the pub/sub consumer leaked forever.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server.js';

vi.mock('../../src/lib/config.js', () => ({
  env: { ENABLE_SSE_FEED: true, NODE_ENV: 'test' },
}));

vi.mock('../../src/lib/auth/builder-context.js', () => ({
  readBuilderContextFromDashboard: () => ({ builderId: 'b1' }),
}));

// Real feed-subscriber + real sse-manager; only the Redis socket is stubbed so
// we can assert SUBSCRIBE/UNSUBSCRIBE were balanced.
const subscribeMock = vi.fn(async () => {});
const unsubscribeMock = vi.fn(async () => {});
vi.mock('../../src/lib/redis/client.js', () => ({
  redisClient: { publish: vi.fn() },
  redisPubSubClient: { subscribe: subscribeMock, unsubscribe: unsubscribeMock },
}));
vi.mock('../../src/lib/redis/circuit-breaker.js', () => ({
  cacheBreaker: { fire: vi.fn() },
}));

// Controllable snapshot: getOverview hangs until we release the gate, modelling
// a slow ClickHouse query during which the client disconnects.
let releaseOverview: ((value: unknown) => void) | null = null;
const getOverviewMock = vi.fn<() => Promise<unknown>>();
const getTopEndUsersMock = vi.fn<() => Promise<unknown[]>>(async () => []);
vi.mock('../../src/lib/clickhouse/dashboard-queries.js', () => ({
  getOverview: () => getOverviewMock(),
  getTopEndUsers: () => getTopEndUsersMock(),
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
const { getSseConnectionCount, _resetSseManagerForTests } =
  await import('../../src/lib/realtime/sse-manager.js');
const { _resetFeedSubscriberForTests } = await import('../../src/lib/realtime/feed-subscriber.js');

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

// Arm getOverview to hang until releaseOverview() is called — models a slow
// ClickHouse snapshot that's still in flight when the client disconnects.
function hangSnapshot(): void {
  getOverviewMock.mockReturnValueOnce(
    new Promise((resolve) => {
      releaseOverview = resolve;
    }),
  );
}

// Open the stream with the given signal and let `start` run up to its first
// await (lease taken, SUBSCRIBE issued). Returns the Response so callers can
// drive `cancel`.
async function openStream(signal: AbortSignal): Promise<Response> {
  const request = new Request('http://localhost/api/v1/feed/stream', {
    method: 'GET',
    signal,
  }) as unknown as NextRequest;
  const response = await GET(request);
  await flush();
  return response;
}

describe('GET /api/v1/feed/stream — disconnect during snapshot window', () => {
  beforeEach(() => {
    _resetSseManagerForTests();
    _resetFeedSubscriberForTests();
    subscribeMock.mockClear();
    unsubscribeMock.mockClear();
    getOverviewMock.mockReset();
    getTopEndUsersMock.mockClear();
    releaseOverview = null;
  });

  it('releases the lease and unsubscribes when the client aborts mid-snapshot', async () => {
    hangSnapshot();
    const ac = new AbortController();

    // Constructing the Response runs the stream's `start` up to the snapshot
    // await: lease taken + SUBSCRIBE issued, snapshot still pending.
    await openStream(ac.signal);
    expect(getSseConnectionCount('b1')).toBe(1);
    expect(subscribeMock).toHaveBeenCalledTimes(1);

    // Client disconnects WHILE the snapshot is still in flight.
    ac.abort();
    await flush();

    // Now the slow snapshot finally resolves.
    releaseOverview?.({ totalCostUsd: 0 });
    await flush();

    // The lease must be freed and the pub/sub consumer torn down — no leak.
    expect(getSseConnectionCount('b1')).toBe(0);
    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });

  it('does not leak across repeated mid-snapshot disconnects', async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      hangSnapshot();
      const ac = new AbortController();
      await openStream(ac.signal);
      ac.abort();
      await flush();
      releaseOverview?.({ totalCostUsd: 0 });
      await flush();
    }

    // After three disconnect cycles the slot count must be back to zero,
    // nowhere near the 50-connection cap.
    expect(getSseConnectionCount('b1')).toBe(0);
    expect(unsubscribeMock).toHaveBeenCalledTimes(3);
  });

  it('releases the lease when the signal is already aborted at start', async () => {
    // Snapshot would resolve immediately, but the client is already gone.
    getOverviewMock.mockResolvedValue({ totalCostUsd: 0 });
    const ac = new AbortController();
    ac.abort();

    await openStream(ac.signal);

    // No slot retained, and we bail before issuing a SUBSCRIBE at all.
    expect(getSseConnectionCount('b1')).toBe(0);
    expect(subscribeMock).not.toHaveBeenCalled();
  });

  it('cancel() runs full teardown, not just a lease release', async () => {
    // Snapshot resolves so the stream reaches steady state (timers armed,
    // subscription live), then the consumer cancels the stream.
    getOverviewMock.mockResolvedValue({ totalCostUsd: 0 });
    const ac = new AbortController();

    const response = await openStream(ac.signal);
    expect(getSseConnectionCount('b1')).toBe(1);
    expect(subscribeMock).toHaveBeenCalledTimes(1);

    // Consumer cancels (e.g. proxy reset that never surfaces as a request
    // abort). Teardown must free the slot AND drop the Redis consumer.
    await response.body?.cancel();
    await flush();

    expect(getSseConnectionCount('b1')).toBe(0);
    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });
});
