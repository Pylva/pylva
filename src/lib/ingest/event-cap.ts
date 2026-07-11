import { eq } from 'drizzle-orm';
import {
  BuilderTier,
  isBuilderTier,
  EventCapWindowSource,
  TIER_LIMITS,
  type BuilderTier as BuilderTierValue,
  type EventCapWindowSource as EventCapWindowSourceValue,
} from '@pylva/shared';
import { env } from '../config.js';
import { db } from '../db/client.js';
import { builders } from '../db/schema.js';
import { logger } from '../logger.js';
import { periodEndFor, periodStartFor } from '../budget/period-utils.js';
import { cacheBreaker } from '../redis/circuit-breaker.js';
import { redisClient } from '../redis/client.js';
import { queryCostEvents } from '../clickhouse/client.js';
import { chTimestamp } from '../clickhouse/datetime.js';

export interface EventCapWindow {
  start: Date;
  end: Date;
  source: EventCapWindowSourceValue;
}

export interface EventCapDecision {
  enabled: boolean;
  blocked: boolean;
  tier: BuilderTierValue | null;
  cap: number;
  used: number | null;
  window: EventCapWindow | null;
}

export interface EventCapContext {
  tier: BuilderTierValue | null;
  period: { start: Date | null; end: Date | null } | null;
}

export interface EventCapUsage {
  monthly_events_used: number;
  monthly_events_limit: number;
  window_start: Date;
  window_end: Date;
  window_source: EventCapWindow['source'];
}

interface MemoEntry {
  context: EventCapContext;
  expiresAtMs: number;
}

interface EventCapThresholdPayload {
  builderId: string;
  tier: BuilderTierValue;
  kind: 'warning_80' | 'exceeded';
  used: number;
  cap: number;
  window: EventCapWindow;
}

interface FiniteCapState {
  tier: BuilderTierValue;
  cap: number;
  window: EventCapWindow;
  key: string;
  used: number;
}

type CapStateResult =
  | { type: 'finite'; state: FiniteCapState }
  | { type: 'unlimited'; tier: BuilderTierValue; cap: number }
  | {
      type: 'fail_open';
      reason: 'pg' | 'redis' | 'clickhouse';
      tier: BuilderTierValue | null;
      cap: number;
      window: EventCapWindow | null;
    };

const MEMO_TTL_MS = 30_000;
const MAX_MEMO_ENTRIES = 1_000;
const MAX_EXCEEDED_MEMO_ENTRIES = 5_000;
const MAX_BILLING_WINDOW_MS = 35 * 86_400_000;
const TTL_GRACE_MS = 7 * 86_400_000;
const EVENT_CAP_WARNING_RATIO = 0.8;
const memo = new Map<string, MemoEntry>();
const exceededMemo = new Set<string>();
const log = logger.child({ module: 'ingest.event-cap' });

function memoize(builderId: string, context: EventCapContext): EventCapContext {
  if (memo.has(builderId)) memo.delete(builderId);
  memo.set(builderId, { context, expiresAtMs: Date.now() + MEMO_TTL_MS });

  while (memo.size > MAX_MEMO_ENTRIES) {
    const oldest = memo.keys().next().value;
    if (oldest === undefined) break;
    memo.delete(oldest);
  }

  return context;
}

function calendarMonthWindow(now: Date): EventCapWindow {
  return {
    start: periodStartFor('month', now),
    end: periodEndFor('month', now),
    source: EventCapWindowSource.CALENDAR_MONTH,
  };
}

function eventCapKey(builderId: string, window: EventCapWindow): string {
  return `event_cap:${builderId}:${Math.floor(window.start.getTime() / 1000)}`;
}

function ttlForWindow(window: EventCapWindow, now: Date): number {
  return Math.max(1, window.end.getTime() - now.getTime() + TTL_GRACE_MS);
}

function serializeWindow(
  window: EventCapWindow | null,
): { start: string; end: string; source: EventCapWindow['source'] } | null {
  if (!window) return null;
  return {
    start: window.start.toISOString(),
    end: window.end.toISOString(),
    source: window.source,
  };
}

function parseRedisCount(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

function failOpenDecision(
  result: Extract<CapStateResult, { type: 'fail_open' }>,
): EventCapDecision {
  return {
    enabled: true,
    blocked: false,
    tier: result.tier,
    cap: result.cap,
    used: null,
    window: result.window,
  };
}

function logFailOpen(
  builderId: string,
  result: Extract<CapStateResult, { type: 'fail_open' }>,
): void {
  log.warn(
    {
      event: 'fail_open',
      reason: result.reason,
      builder_id: builderId,
      tier: result.tier,
      cap: result.cap,
      window: serializeWindow(result.window),
    },
    'event cap enforcement failed open',
  );
}

function rememberExceeded(builderId: string, window: EventCapWindow): boolean {
  const key = `${builderId}:${Math.floor(window.start.getTime() / 1000)}`;
  if (exceededMemo.has(key)) return false;
  exceededMemo.add(key);
  while (exceededMemo.size > MAX_EXCEEDED_MEMO_ENTRIES) {
    const oldest = exceededMemo.values().next().value;
    if (oldest === undefined) break;
    exceededMemo.delete(oldest);
  }
  return true;
}

async function redisGetCount(key: string): Promise<{ ok: true; value: number | null } | null> {
  try {
    const result = (await cacheBreaker.fire(async (): Promise<{ value: string | null }> => {
      const value = await redisClient.get(key);
      return { value };
    })) as { value: string | null } | null;

    if (result === null) return null;
    const parsed = parseRedisCount(result.value);
    return result.value === null || parsed !== null ? { ok: true, value: parsed } : null;
  } catch (err) {
    log.warn(
      {
        event: 'fail_open',
        reason: 'redis',
        error: err instanceof Error ? err.message : String(err),
      },
      'event cap Redis GET failed',
    );
    return null;
  }
}

async function redisSeedCount(key: string, seed: number, ttlMs: number): Promise<boolean> {
  try {
    const result = (await cacheBreaker.fire(async (): Promise<{ ok: true }> => {
      const multi = redisClient.multi();
      multi.set(key, String(seed), { NX: true });
      multi.pExpire(key, ttlMs);
      await multi.exec();
      return { ok: true };
    })) as { ok: true } | null;

    return result !== null;
  } catch (err) {
    log.warn(
      {
        event: 'fail_open',
        reason: 'redis',
        error: err instanceof Error ? err.message : String(err),
      },
      'event cap Redis seed failed',
    );
    return false;
  }
}

async function seedFromClickHouse(
  builderId: string,
  window: EventCapWindow,
): Promise<number | null> {
  const from = chTimestamp(window.start);
  const to = chTimestamp(window.end);

  try {
    const rows = await queryCostEvents(
      builderId,
      `SELECT count() AS event_count
       FROM cost_events
       WHERE builder_id = {builder_id:String}
         AND timestamp >= parseDateTimeBestEffort({from:String})
         AND timestamp <  parseDateTimeBestEffort({to:String})`,
      { from, to },
      { queryLabel: 'event_cap_seed' },
    );
    const first = rows[0] as Record<string, unknown> | undefined;
    const count = Number(first?.['event_count'] ?? 0);
    return Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
  } catch (err) {
    log.warn(
      {
        event: 'fail_open',
        reason: 'clickhouse',
        builder_id: builderId,
        window: serializeWindow(window),
        error: err instanceof Error ? err.message : String(err),
      },
      'event cap ClickHouse seed failed',
    );
    return null;
  }
}

async function loadCapState(builderId: string, now: Date): Promise<CapStateResult> {
  const context = await getCapContext(builderId);
  const tier = context.tier;
  if (tier === null) {
    return { type: 'fail_open', reason: 'pg', tier: null, cap: Infinity, window: null };
  }

  const cap = TIER_LIMITS[tier].monthly_events;
  if (!Number.isFinite(cap)) {
    return { type: 'unlimited', tier, cap };
  }

  const window = resolveEventCapWindow(now, tier, context.period);
  const key = eventCapKey(builderId, window);
  const cached = await redisGetCount(key);
  if (cached === null) {
    return { type: 'fail_open', reason: 'redis', tier, cap, window };
  }

  if (cached.value !== null) {
    return { type: 'finite', state: { tier, cap, window, key, used: cached.value } };
  }

  const seed = await seedFromClickHouse(builderId, window);
  if (seed === null) {
    return { type: 'fail_open', reason: 'clickhouse', tier, cap, window };
  }

  const seeded = await redisSeedCount(key, seed, ttlForWindow(window, now));
  if (!seeded) {
    return { type: 'fail_open', reason: 'redis', tier, cap, window };
  }

  const readBack = await redisGetCount(key);
  if (readBack === null || readBack.value === null) {
    return { type: 'fail_open', reason: 'redis', tier, cap, window };
  }

  return { type: 'finite', state: { tier, cap, window, key, used: readBack.value } };
}

export async function getCapContext(builderId: string): Promise<EventCapContext> {
  const cached = memo.get(builderId);
  if (cached && cached.expiresAtMs > Date.now()) return cached.context;
  if (cached) memo.delete(builderId);

  try {
    const rows = await db
      .select({
        tier: builders.tier,
      })
      .from(builders)
      .where(eq(builders.id, builderId))
      .limit(1);
    const row = rows[0];
    const tier = row?.tier;
    const parsedTier = isBuilderTier(tier) ? tier : null;
    const context: EventCapContext = {
      tier: parsedTier,
      period: null,
    };

    if (tier !== undefined && !isBuilderTier(tier)) {
      log.warn({ builder_id: builderId, tier }, 'builder has unknown tier');
    }

    return memoize(builderId, context);
  } catch (err) {
    log.warn(
      { builder_id: builderId, error: err instanceof Error ? err.message : String(err) },
      'event cap context lookup failed',
    );
    return { tier: null, period: null };
  }
}

export function resolveEventCapWindow(
  now: Date,
  tier: BuilderTierValue,
  period: { start: Date | null; end: Date | null } | null,
): EventCapWindow {
  if (tier === BuilderTier.FREE) return calendarMonthWindow(now);

  if (
    (tier === BuilderTier.PRO || tier === BuilderTier.SCALE) &&
    period?.start &&
    period.end &&
    period.start.getTime() <= now.getTime() &&
    now.getTime() < period.end.getTime() &&
    period.end.getTime() - period.start.getTime() <= MAX_BILLING_WINDOW_MS
  ) {
    return { start: period.start, end: period.end, source: EventCapWindowSource.BILLING_PERIOD };
  }

  return calendarMonthWindow(now);
}

export async function checkEventCap(
  builderId: string,
  now: Date = new Date(),
): Promise<EventCapDecision> {
  if (!env.ENABLE_EVENT_LIMITS) {
    return {
      enabled: false,
      blocked: false,
      tier: null,
      cap: Infinity,
      used: null,
      window: null,
    };
  }

  const result = await loadCapState(builderId, now);
  if (result.type === 'fail_open') {
    logFailOpen(builderId, result);
    return failOpenDecision(result);
  }
  if (result.type === 'unlimited') {
    return {
      enabled: true,
      blocked: false,
      tier: result.tier,
      cap: result.cap,
      used: null,
      window: null,
    };
  }

  const { tier, cap, used, window } = result.state;
  const blocked = used >= cap;
  if (blocked) {
    log.warn(
      {
        event: 'blocked',
        builder_id: builderId,
        tier,
        used,
        cap,
        window: serializeWindow(window),
      },
      'event cap reached; blocking ingest',
    );
    if (rememberExceeded(builderId, window)) {
      emitLimitThreshold({
        builderId,
        kind: 'exceeded',
        tier,
        used,
        cap,
        window,
      });
    }
  }

  return {
    enabled: true,
    blocked,
    tier,
    cap,
    used,
    window,
  };
}

export async function recordAcceptedEvents(
  builderId: string,
  decision: EventCapDecision,
  count: number,
): Promise<number | null> {
  if (
    count <= 0 ||
    !decision.enabled ||
    decision.window === null ||
    decision.tier === null ||
    decision.used === null ||
    !Number.isFinite(decision.cap)
  ) {
    // The accepted batch has already been inserted into ClickHouse before this
    // runs. If the starting count was untrusted, skipping Redis loses nothing:
    // the next cold-start seed can retry and include this batch in the truth.
    return null;
  }

  const key = eventCapKey(builderId, decision.window);
  try {
    const result = (await cacheBreaker.fire(async (): Promise<{ value: number }> => {
      const multi = redisClient.multi();
      multi.incrBy(key, count);
      multi.pExpire(key, ttlForWindow(decision.window!, new Date()));
      const replies = await multi.exec();
      return { value: Number(replies[0] ?? 0) };
    })) as { value: number } | null;

    if (result === null || !Number.isFinite(result.value)) {
      log.warn(
        {
          event: 'fail_open',
          reason: 'redis',
          builder_id: builderId,
          tier: decision.tier,
          count,
          window: serializeWindow(decision.window),
        },
        'event cap increment failed open',
      );
      return null;
    }

    const newVal = Math.floor(result.value);
    const oldVal = newVal - count;
    const warn = Math.floor(decision.cap * EVENT_CAP_WARNING_RATIO);

    if (oldVal < decision.cap && newVal >= decision.cap) {
      rememberExceeded(builderId, decision.window);
      emitLimitThreshold({
        builderId,
        kind: 'exceeded',
        tier: decision.tier,
        used: newVal,
        cap: decision.cap,
        window: decision.window,
      });
      return newVal;
    }

    if (oldVal < warn && newVal >= warn) {
      emitLimitThreshold({
        builderId,
        kind: 'warning_80',
        tier: decision.tier,
        used: newVal,
        cap: decision.cap,
        window: decision.window,
      });
    }

    return newVal;
  } catch (err) {
    log.warn(
      {
        event: 'fail_open',
        reason: 'redis',
        builder_id: builderId,
        tier: decision.tier,
        count,
        window: serializeWindow(decision.window),
        error: err instanceof Error ? err.message : String(err),
      },
      'event cap increment failed open',
    );
    return null;
  }
}

export function emitLimitThreshold(payload: EventCapThresholdPayload): void {
  log.info(
    {
      event: 'threshold_crossed',
      kind: payload.kind,
      builder_id: payload.builderId,
      tier: payload.tier,
      used: payload.used,
      cap: payload.cap,
      window: serializeWindow(payload.window),
    },
    'event cap threshold crossed',
  );
}

// Read-only usage for dashboard surfaces. Never throws — usage display is
// best-effort, so lookup failures degrade to null instead of failing the page.
export async function getEventCapUsage(builderId: string): Promise<EventCapUsage | null> {
  if (!env.ENABLE_EVENT_LIMITS) return null;

  try {
    const result = await loadCapState(builderId, new Date());
    if (result.type !== 'finite') return null;

    return {
      monthly_events_used: result.state.used,
      monthly_events_limit: result.state.cap,
      window_start: result.state.window.start,
      window_end: result.state.window.end,
      window_source: result.state.window.source,
    };
  } catch (err) {
    log.warn(
      {
        event: 'usage_lookup_failed',
        builder_id: builderId,
        error: err instanceof Error ? err.message : String(err),
      },
      'event cap usage lookup failed',
    );
    return null;
  }
}

export function formatTierUsage(used: number, cap: number): string {
  return `${used}/${cap}`;
}

export function __resetEventCapMemoForTests(): void {
  memo.clear();
  exceededMemo.clear();
}
