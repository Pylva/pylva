// B3-T2 — subscriber ref-counting + parse safety + Redis-failure fallback.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

interface SubscribedListener {
  channel: string;
  handler: (raw: string) => void;
}

const subscribed: SubscribedListener[] = [];
const unsubscribed: SubscribedListener[] = [];
let nextSubscribeFails = false;

const subscribeMock = vi.fn(async (channel: string, handler: (raw: string) => void) => {
  if (nextSubscribeFails) {
    nextSubscribeFails = false;
    throw new Error('redis subscribe failed');
  }
  subscribed.push({ channel, handler });
});

const unsubscribeMock = vi.fn(async (channel: string, handler: (raw: string) => void) => {
  unsubscribed.push({ channel, handler });
});

vi.mock('../../src/lib/redis/client.js', () => ({
  redisPubSubClient: {
    subscribe: subscribeMock,
    unsubscribe: unsubscribeMock,
  },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
  },
}));

const { subscribeFeed, _resetFeedSubscriberForTests } =
  await import('../../src/lib/realtime/feed-subscriber.js');

describe('feed-subscriber (D3 ref-counted SUBSCRIBE)', () => {
  beforeEach(() => {
    subscribed.length = 0;
    unsubscribed.length = 0;
    subscribeMock.mockClear();
    unsubscribeMock.mockClear();
    nextSubscribeFails = false;
    _resetFeedSubscriberForTests();
  });

  afterEach(() => {
    _resetFeedSubscriberForTests();
  });

  it('first subscriber issues redis SUBSCRIBE on builder channel', async () => {
    const sub = await subscribeFeed('b1', () => {});
    expect(subscribed).toHaveLength(1);
    expect(subscribed[0]?.channel).toBe('feed:b1');
    await sub.unsubscribe();
  });

  it('second subscriber for same builder reuses single SUBSCRIBE', async () => {
    const sub1 = await subscribeFeed('b1', () => {});
    const sub2 = await subscribeFeed('b1', () => {});
    expect(subscribed).toHaveLength(1);
    await sub1.unsubscribe();
    expect(unsubscribed).toHaveLength(0);
    await sub2.unsubscribe();
    expect(unsubscribed).toHaveLength(1);
  });

  it('coalesces concurrent first-subscribers onto one SUBSCRIBE (no listener leak)', async () => {
    // Two SSE connections for the same builder open in the same tick: both
    // reach subscribeFeed before either's redis SUBSCRIBE resolves. They must
    // share ONE raw listener — otherwise the registry only tracks the second
    // entry and the first connection's listener (which pins its SSE controller)
    // is never UNSUBSCRIBEd on disconnect → permanent leak.
    const [sub1, sub2] = await Promise.all([
      subscribeFeed('b1', () => {}),
      subscribeFeed('b1', () => {}),
    ]);

    expect(subscribed).toHaveLength(1);

    await sub1.unsubscribe();
    await sub2.unsubscribe();

    // Every SUBSCRIBE must have a matching UNSUBSCRIBE — no orphaned listeners.
    expect(unsubscribed).toHaveLength(subscribed.length);
  });

  it('different builders get independent subscriptions', async () => {
    await subscribeFeed('b1', () => {});
    await subscribeFeed('b2', () => {});
    expect(subscribed).toHaveLength(2);
    expect(subscribed.map((s) => s.channel).sort()).toEqual(['feed:b1', 'feed:b2']);
  });

  it('fans messages out to all consumers of a channel', async () => {
    const received1: unknown[] = [];
    const received2: unknown[] = [];
    await subscribeFeed('b1', (m) => received1.push(m));
    await subscribeFeed('b1', (m) => received2.push(m));

    const rawListener = subscribed[0]!.handler;
    rawListener(JSON.stringify({ type: 'cost_update', data: { customer_id: 'c1', cost_usd: 1 } }));

    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
    expect(received1[0]).toMatchObject({ type: 'cost_update' });
  });

  it('drops malformed Redis payloads silently', async () => {
    const received: unknown[] = [];
    await subscribeFeed('b1', (m) => received.push(m));
    const rawListener = subscribed[0]!.handler;
    rawListener('not-json');
    rawListener(JSON.stringify({ no_type_field: true }));
    expect(received).toHaveLength(0);
  });

  it('I-SSE-3: redis subscribe failure returns a no-op handle, never throws', async () => {
    nextSubscribeFails = true;
    const sub = await subscribeFeed('b1', () => {});
    expect(subscribed).toHaveLength(0);
    // Unsubscribe must not throw either.
    await expect(sub.unsubscribe()).resolves.toBeUndefined();
  });

  it('I-SSE-3: synchronous throw from subscribe also degrades, never throws', async () => {
    // node-redis returns a rejected promise on failure, but the no-throw
    // contract must also hold if subscribe() ever throws synchronously.
    subscribeMock.mockImplementationOnce(() => {
      throw new Error('sync subscribe failure');
    });
    const sub = await subscribeFeed('b1', () => {});
    expect(subscribed).toHaveLength(0);
    await expect(sub.unsubscribe()).resolves.toBeUndefined();
  });
});
