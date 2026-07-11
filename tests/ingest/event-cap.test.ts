import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BuilderTier, TIER_LIMITS } from '@pylva/shared';

type MutableTierLimits = Record<string, (typeof TIER_LIMITS)[keyof typeof TIER_LIMITS] | undefined>;

type DbRow = {
  tier: string;
};

type RedisOp =
  | { type: 'set'; key: string; value: string; nx: boolean }
  | { type: 'pexpire'; key: string; ttlMs: number }
  | { type: 'incrby'; key: string; count: number };

interface RedisMulti {
  set(key: string, value: string, options?: { NX?: boolean }): RedisMulti;
  pExpire(key: string, ttlMs: number): RedisMulti;
  incrBy(key: string, count: number): RedisMulti;
  exec(): Promise<unknown[]>;
}

const h = vi.hoisted(() => ({
  env: { ENABLE_EVENT_LIMITS: true, PUBLIC_SITE_URL: 'https://pylva.test' },
  rows: [] as DbRow[],
  dbError: null as Error | null,
  selectCalls: 0,
  limitCalls: [] as number[],
  redis: new Map<string, string>(),
  redisGetCalls: [] as string[],
  redisSetCalls: [] as Array<{ key: string; value: string; nx: boolean }>,
  redisExpireCalls: [] as Array<{ key: string; ttlMs: number }>,
  redisIncrCalls: [] as Array<{ key: string; count: number }>,
  breakerNull: false,
  breakerError: null as Error | null,
  breakerCalls: 0,
  queryRows: [] as Array<Record<string, unknown>>,
  queryError: null as Error | null,
  queryCalls: [] as Array<{ builderId: string; query: string; params: Record<string, unknown> }>,
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})),
}));

vi.mock('../../src/lib/config.js', () => ({
  env: h.env,
}));

vi.mock('../../src/lib/db/schema.js', () => ({
  builders: { id: 'builders.id', tier: 'builders.tier' },
}));

vi.mock('../../src/lib/db/client.js', () => ({
  db: {
    select: () => {
      h.selectCalls += 1;
      return {
        from: () => ({
          where: () => ({
            limit: (limit: number) => {
              h.limitCalls.push(limit);
              if (h.dbError) return Promise.reject(h.dbError);
              return Promise.resolve(h.rows.map((row) => ({ tier: row.tier })));
            },
          }),
        }),
      };
    },
  },
}));

function createRedisMulti(): RedisMulti {
  const ops: RedisOp[] = [];
  const multi: RedisMulti = {
    set(key, value, options) {
      ops.push({ type: 'set', key, value, nx: options?.NX === true });
      return multi;
    },
    pExpire(key, ttlMs) {
      ops.push({ type: 'pexpire', key, ttlMs });
      return multi;
    },
    incrBy(key, count) {
      ops.push({ type: 'incrby', key, count });
      return multi;
    },
    async exec() {
      const replies: unknown[] = [];
      for (const op of ops) {
        if (op.type === 'set') {
          h.redisSetCalls.push({ key: op.key, value: op.value, nx: op.nx });
          if (!op.nx || !h.redis.has(op.key)) {
            h.redis.set(op.key, op.value);
            replies.push('OK');
          } else {
            replies.push(null);
          }
        } else if (op.type === 'pexpire') {
          h.redisExpireCalls.push({ key: op.key, ttlMs: op.ttlMs });
          replies.push(true);
        } else {
          h.redisIncrCalls.push({ key: op.key, count: op.count });
          const next = Number(h.redis.get(op.key) ?? '0') + op.count;
          h.redis.set(op.key, String(next));
          replies.push(next);
        }
      }
      return replies;
    },
  };
  return multi;
}

vi.mock('../../src/lib/redis/client.js', () => ({
  redisClient: {
    get: vi.fn(async (key: string) => {
      h.redisGetCalls.push(key);
      return h.redis.get(key) ?? null;
    }),
    multi: vi.fn(() => createRedisMulti()),
  },
}));

vi.mock('../../src/lib/redis/circuit-breaker.js', () => ({
  cacheBreaker: {
    fire: vi.fn(async (fn: () => Promise<unknown>) => {
      h.breakerCalls += 1;
      if (h.breakerError) throw h.breakerError;
      if (h.breakerNull) return null;
      return fn();
    }),
  },
}));

vi.mock('../../src/lib/clickhouse/client.js', () => ({
  queryCostEvents: vi.fn(
    async (builderId: string, query: string, params: Record<string, unknown>) => {
      h.queryCalls.push({ builderId, query, params });
      if (h.queryError) throw h.queryError;
      return h.queryRows;
    },
  ),
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({
      info: h.info,
      warn: h.warn,
    }),
  },
}));

const {
  __resetEventCapMemoForTests,
  checkEventCap,
  formatTierUsage,
  getCapContext,
  getEventCapUsage,
  recordAcceptedEvents,
  resolveEventCapWindow,
} = await import('../../src/lib/ingest/event-cap.js');

function resetHarness(): void {
  __resetEventCapMemoForTests();
  h.env.ENABLE_EVENT_LIMITS = true;
  h.rows = [];
  h.dbError = null;
  h.selectCalls = 0;
  h.limitCalls = [];
  h.redis.clear();
  h.redisGetCalls = [];
  h.redisSetCalls = [];
  h.redisExpireCalls = [];
  h.redisIncrCalls = [];
  h.breakerNull = false;
  h.breakerError = null;
  h.breakerCalls = 0;
  h.queryRows = [];
  h.queryError = null;
  h.queryCalls = [];
  h.info.mockReset();
  h.warn.mockReset();
}

function windowKey(builderId: string, start: Date): string {
  return `event_cap:${builderId}:${Math.floor(start.getTime() / 1000)}`;
}

function julyWindow(): { start: Date; end: Date; key: string } {
  const start = new Date('2026-07-01T00:00:00.000Z');
  const end = new Date('2026-08-01T00:00:00.000Z');
  return { start, end, key: windowKey('builder-a', start) };
}

function thresholdInfoKinds(): string[] {
  return h.info.mock.calls
    .map((call) => (call[0] as { kind?: unknown } | undefined)?.kind)
    .filter((kind): kind is string => typeof kind === 'string');
}

describe('resolveEventCapWindow', () => {
  it('uses calendar month UTC for free', () => {
    const window = resolveEventCapWindow(
      new Date('2026-07-15T12:34:56.000Z'),
      BuilderTier.FREE,
      null,
    );

    expect(window).toEqual({
      start: new Date('2026-07-01T00:00:00.000Z'),
      end: new Date('2026-08-01T00:00:00.000Z'),
      source: 'calendar_month',
    });
  });

  it.each([
    ['valid period', '2026-07-01T00:00:00.000Z', '2026-07-29T00:00:00.000Z', 'billing_period'],
    ['now equals start', '2026-07-15T12:00:00.000Z', '2026-08-12T12:00:00.000Z', 'billing_period'],
    ['null start', null, '2026-08-12T12:00:00.000Z', 'calendar_month'],
    ['null end', '2026-07-01T00:00:00.000Z', null, 'calendar_month'],
    ['now equals end', '2026-07-01T00:00:00.000Z', '2026-07-15T12:00:00.000Z', 'calendar_month'],
    ['36 day period', '2026-07-01T00:00:00.000Z', '2026-08-06T00:00:00.000Z', 'calendar_month'],
    ['28 day period', '2026-07-01T00:00:00.000Z', '2026-07-29T00:00:00.000Z', 'billing_period'],
  ] as const)('resolves %s', (_name, start, end, source) => {
    const now = new Date('2026-07-15T12:00:00.000Z');
    const window = resolveEventCapWindow(now, BuilderTier.PRO, {
      start: start ? new Date(start) : null,
      end: end ? new Date(end) : null,
    });

    expect(window.source).toBe(source);
  });
});

describe('event cap enforcement', () => {
  beforeEach(() => {
    resetHarness();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads builders.tier and caches within 30 seconds', async () => {
    h.rows = [{ tier: 'pro' }];

    await expect(getCapContext('builder-a')).resolves.toEqual({
      tier: 'pro',
      period: null,
    });
    await expect(getCapContext('builder-a')).resolves.toEqual({
      tier: 'pro',
      period: null,
    });

    expect(h.selectCalls).toBe(1);
    expect(h.limitCalls).toEqual([1]);
  });

  it('uses the expected key shape', async () => {
    const { key } = julyWindow();
    h.rows = [{ tier: 'free' }];
    h.redis.set(key, '42');

    const decision = await checkEventCap('builder-a', new Date('2026-07-02T00:00:00.000Z'));

    expect(decision.used).toBe(42);
    expect(h.redisGetCalls[0]).toBe(key);
  });

  it('blocks at exact cap and allows cap minus one', async () => {
    const { key } = julyWindow();
    h.rows = [{ tier: 'free' }];
    h.redis.set(key, '100000');
    await expect(
      checkEventCap('builder-a', new Date('2026-07-02T00:00:00.000Z')),
    ).resolves.toMatchObject({
      blocked: true,
      used: 100000,
      cap: 100000,
    });

    resetHarness();
    h.rows = [{ tier: 'free' }];
    h.redis.set(key, '99999');
    await expect(
      checkEventCap('builder-a', new Date('2026-07-02T00:00:00.000Z')),
    ).resolves.toMatchObject({
      blocked: false,
      used: 99999,
      cap: 100000,
    });
  });

  it('does no Redis traffic for enterprise and no I/O when the flag is disabled', async () => {
    h.rows = [{ tier: 'enterprise' }];
    await expect(checkEventCap('builder-a')).resolves.toMatchObject({
      blocked: false,
      tier: 'enterprise',
      used: null,
    });
    expect(h.redisGetCalls).toHaveLength(0);
    expect(h.queryCalls).toHaveLength(0);

    resetHarness();
    h.env.ENABLE_EVENT_LIMITS = false;
    await expect(checkEventCap('builder-a')).resolves.toMatchObject({
      enabled: false,
      blocked: false,
    });
    expect(h.selectCalls).toBe(0);
    expect(h.breakerCalls).toBe(0);
    expect(h.queryCalls).toHaveLength(0);
  });

  it('fails open on PG, Redis breaker-null, and ClickHouse seed errors', async () => {
    h.dbError = new Error('pg unavailable');
    await expect(checkEventCap('builder-a')).resolves.toMatchObject({ blocked: false, used: null });
    expect(h.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'fail_open', reason: 'pg' }),
      'event cap enforcement failed open',
    );

    resetHarness();
    h.rows = [{ tier: 'free' }];
    h.breakerNull = true;
    await expect(checkEventCap('builder-a')).resolves.toMatchObject({ blocked: false, used: null });
    expect(h.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'fail_open', reason: 'redis' }),
      'event cap enforcement failed open',
    );

    resetHarness();
    h.rows = [{ tier: 'free' }];
    h.queryError = new Error('clickhouse unavailable');
    await expect(checkEventCap('builder-a')).resolves.toMatchObject({ blocked: false, used: null });
    expect(h.redisSetCalls).toHaveLength(0);
    expect(h.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'fail_open', reason: 'clickhouse' }),
      'event cap enforcement failed open',
    );
  });

  it('seeds a Redis miss from ClickHouse with SET NX, expiry, and read-back', async () => {
    const { key } = julyWindow();
    h.rows = [{ tier: 'free' }];
    h.queryRows = [{ event_count: '12' }];

    const decision = await checkEventCap('builder-a', new Date('2026-07-02T00:00:00.000Z'));

    expect(decision).toMatchObject({ blocked: false, used: 12 });
    expect(h.queryCalls[0]?.params).toEqual({
      from: '2026-07-01 00:00:00',
      to: '2026-08-01 00:00:00',
    });
    expect(h.redisSetCalls).toEqual([{ key, value: '12', nx: true }]);
    expect(h.redisExpireCalls[0]).toMatchObject({ key });
    expect(h.redisGetCalls).toEqual([key, key]);
  });

  it.each([
    [79, 2, ['warning_80']],
    [99, 2, ['exceeded']],
    [50, 100, ['exceeded']],
  ] as const)(
    'logs threshold crossings from %i by %i',
    async (initial, count, expected) => {
      const { start, end, key } = julyWindow();
      h.redis.set(key, String(initial));

      await expect(
        recordAcceptedEvents(
          'builder-a',
          {
            enabled: true,
            blocked: false,
            tier: BuilderTier.FREE,
            cap: 100,
            used: initial,
            window: { start, end, source: 'calendar_month' },
          },
          count,
        ),
      ).resolves.toBe(initial + count);

      expect(thresholdInfoKinds()).toEqual(expected);
      expect(h.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'threshold_crossed',
          kind: expected[0],
          builder_id: 'builder-a',
          tier: BuilderTier.FREE,
          used: initial + count,
          cap: 100,
          window: expect.objectContaining({
            start: start.toISOString(),
            end: end.toISOString(),
            source: 'calendar_month',
          }),
        }),
        'event cap threshold crossed',
      );
    },
  );

  it('returns null when the Redis increment fails open', async () => {
    const { start, end, key } = julyWindow();
    h.redis.set(key, '10');
    h.breakerNull = true;

    await expect(
      recordAcceptedEvents(
        'builder-a',
        {
          enabled: true,
          blocked: false,
          tier: BuilderTier.FREE,
          cap: 100,
          used: 10,
          window: { start, end, source: 'calendar_month' },
        },
        2,
      ),
    ).resolves.toBeNull();

    expect(h.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'fail_open', reason: 'redis', count: 2 }),
      'event cap increment failed open',
    );
  });

  it('does not create a Redis counter when the starting count is untrusted', async () => {
    const { start, end } = julyWindow();

    await expect(
      recordAcceptedEvents(
        'builder-a',
        {
          enabled: true,
          blocked: false,
          tier: BuilderTier.FREE,
          cap: 100,
          used: null,
          window: { start, end, source: 'calendar_month' },
        },
        2,
      ),
    ).resolves.toBeNull();

    expect(h.breakerCalls).toBe(0);
    expect(h.redisIncrCalls).toHaveLength(0);
    expect(h.redisExpireCalls).toHaveLength(0);
  });

  it('retries a ClickHouse seed after an untrusted-count batch is accepted', async () => {
    const { key, start, end } = julyWindow();
    const now = new Date('2026-07-02T00:00:00.000Z');
    h.rows = [{ tier: 'free' }];
    h.queryError = new Error('clickhouse unavailable');

    const failOpen = await checkEventCap('builder-a', now);
    expect(failOpen).toMatchObject({ blocked: false, used: null, cap: 100000 });

    await expect(recordAcceptedEvents('builder-a', failOpen, 2)).resolves.toBeNull();
    expect(h.redis.has(key)).toBe(false);
    expect(h.redisIncrCalls).toHaveLength(0);

    h.queryError = null;
    h.queryRows = [{ event_count: 14 }];

    await expect(checkEventCap('builder-a', now)).resolves.toMatchObject({
      blocked: false,
      used: 14,
      cap: 100000,
    });
    expect(h.redisSetCalls).toContainEqual({ key, value: '14', nx: true });
    expect(h.redis.get(key)).toBe('14');
    expect(start).toEqual(new Date('2026-07-01T00:00:00.000Z'));
    expect(end).toEqual(new Date('2026-08-01T00:00:00.000Z'));
  });

  it('emits blocked-path exceeded only once per builder window in-process', async () => {
    const { key } = julyWindow();
    h.rows = [{ tier: 'free' }];
    h.redis.set(key, '100000');

    await checkEventCap('builder-a', new Date('2026-07-02T00:00:00.000Z'));
    await checkEventCap('builder-a', new Date('2026-07-02T00:00:00.000Z'));

    expect(thresholdInfoKinds()).toEqual(['exceeded']);
  });

  it('makes tier changes visible after memo expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-02T00:00:00.000Z'));
    h.rows = [{ tier: 'free' }];
    await expect(getCapContext('builder-a')).resolves.toMatchObject({ tier: 'free' });

    h.rows = [{ tier: 'pro' }];
    await expect(getCapContext('builder-a')).resolves.toMatchObject({ tier: 'free' });

    vi.advanceTimersByTime(30_001);
    await expect(getCapContext('builder-a')).resolves.toMatchObject({ tier: 'pro' });
  });

  it('getEventCapUsage seeds and reads without incrementing', async () => {
    h.rows = [{ tier: 'free' }];
    h.queryRows = [{ event_count: 5 }];

    const usage = await getEventCapUsage('builder-a');

    expect(usage).toMatchObject({
      monthly_events_used: 5,
      monthly_events_limit: 100000,
      window_source: 'calendar_month',
    });
    expect(h.redisIncrCalls).toHaveLength(0);
  });

  it('getEventCapUsage returns null and warns when state loading throws', async () => {
    h.rows = [{ tier: 'free' }];
    const mutableLimits = TIER_LIMITS as unknown as MutableTierLimits;
    const originalFreeLimits = mutableLimits[BuilderTier.FREE];
    mutableLimits[BuilderTier.FREE] = undefined;

    try {
      await expect(getEventCapUsage('builder-a')).resolves.toBeNull();
    } finally {
      mutableLimits[BuilderTier.FREE] = originalFreeLimits;
    }

    expect(h.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'usage_lookup_failed',
        builder_id: 'builder-a',
        error: expect.stringContaining('monthly_events'),
      }),
      'event cap usage lookup failed',
    );
  });

  it('allows two batches racing near cap, then blocks the next request with one exceeded emit', async () => {
    const { start, end, key } = julyWindow();
    h.rows = [{ tier: 'free' }];
    h.redis.set(key, '99999');
    const decision = {
      enabled: true,
      blocked: false,
      tier: BuilderTier.FREE,
      cap: 100000,
      used: 99999,
      window: { start, end, source: 'calendar_month' as const },
    };

    await Promise.all([
      recordAcceptedEvents('builder-a', decision, 100),
      recordAcceptedEvents('builder-a', decision, 100),
    ]);
    const blocked = await checkEventCap('builder-a', new Date('2026-07-02T00:00:00.000Z'));

    expect(Number(h.redis.get(key))).toBe(100199);
    expect(blocked.blocked).toBe(true);
    expect(thresholdInfoKinds()).toEqual(['exceeded']);
  });

  it('formats tier usage as used over cap', () => {
    expect(formatTierUsage(12, 100)).toBe('12/100');
  });
});
