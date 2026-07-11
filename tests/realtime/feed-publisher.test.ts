// Per-builder channel + fire-and-forget contract for the SSE feed publisher.
// Verifies cacheBreaker fail-open semantics so ingest latency is unaffected
// when Redis is degraded.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const publishCalls: Array<{ channel: string; payload: string }> = [];

vi.mock('../../src/lib/redis/client.js', () => ({
  redisClient: {
    publish: vi.fn(async (channel: string, payload: string) => {
      publishCalls.push({ channel, payload });
      return 1;
    }),
  },
}));

const breakerFireMock = vi.fn(async (fn: () => Promise<unknown>) => fn());
vi.mock('../../src/lib/redis/circuit-breaker.js', () => ({
  cacheBreaker: { fire: breakerFireMock },
}));

const loggerWarn = vi.fn();
vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    warn: loggerWarn,
    info: vi.fn(),
    error: vi.fn(),
    child: () => ({ warn: loggerWarn, info: vi.fn(), error: vi.fn() }),
  },
}));

const { publishFeedMessage, feedChannel } =
  await import('../../src/lib/realtime/feed-publisher.js');

describe('feed-publisher', () => {
  beforeEach(() => {
    publishCalls.length = 0;
    breakerFireMock.mockClear();
    loggerWarn.mockClear();
    breakerFireMock.mockImplementation(async (fn: () => Promise<unknown>) => fn());
  });

  afterEach(() => {
    breakerFireMock.mockReset();
    breakerFireMock.mockImplementation(async (fn: () => Promise<unknown>) => fn());
  });

  it('feedChannel uses per-builder namespace', () => {
    expect(feedChannel('b1')).toBe('feed:b1');
  });

  it('publishes cost_update on the builder channel with the wire-shape payload', async () => {
    await publishFeedMessage('builder-X', {
      type: 'cost_update',
      data: {
        customer_id: 'cust_1',
        cost_usd: 0.12,
        model: 'gpt-4o',
        provider: 'openai',
        step_name: 'summarize',
        timestamp: '2026-04-25T10:00:00.000Z',
      },
    });
    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0]?.channel).toBe('feed:builder-X');
    const decoded = JSON.parse(publishCalls[0]!.payload);
    expect(decoded).toMatchObject({
      type: 'cost_update',
      data: { customer_id: 'cust_1', cost_usd: 0.12, model: 'gpt-4o', provider: 'openai' },
    });
  });

  it('publishes budget_alert and rule_triggered with the same routing', async () => {
    await publishFeedMessage('builder-X', {
      type: 'budget_alert',
      data: {
        customer_id: 'cust_1',
        budget_usd: 100,
        current_usd: 95,
        percent_used: 95,
        rule_id: 'rule-1',
      },
    });
    await publishFeedMessage('builder-X', {
      type: 'rule_triggered',
      data: {
        rule_id: 'rule-1',
        rule_type: 'budget_limit',
        customer_id: 'cust_1',
        action_taken: 'blocked',
        details: {},
      },
    });
    expect(publishCalls).toHaveLength(2);
    expect(JSON.parse(publishCalls[0]!.payload).type).toBe('budget_alert');
    expect(JSON.parse(publishCalls[1]!.payload).type).toBe('rule_triggered');
  });

  it('swallows publish errors so ingest stays fire-and-forget safe (I-SSE-4)', async () => {
    breakerFireMock.mockImplementationOnce(async () => {
      throw new Error('redis down');
    });
    await expect(
      publishFeedMessage('builder-X', {
        type: 'cost_update',
        data: {
          customer_id: 'cust_1',
          cost_usd: 0.5,
          model: null,
          provider: null,
          step_name: null,
          timestamp: '2026-04-25T10:00:00.000Z',
        },
      }),
    ).resolves.toBeUndefined();
    expect(loggerWarn).toHaveBeenCalledTimes(1);
  });

  it('routes through cacheBreaker.fire for fail-open semantics (I-SSE-3)', async () => {
    await publishFeedMessage('builder-X', {
      type: 'cost_update',
      data: {
        customer_id: 'cust_1',
        cost_usd: 0,
        model: null,
        provider: null,
        step_name: null,
        timestamp: '2026-04-25T10:00:00.000Z',
      },
    });
    expect(breakerFireMock).toHaveBeenCalledTimes(1);
  });
});
