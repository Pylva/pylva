// Regression: /api/v1/budget/sync reconciliation (I-T3-3 overwrite semantics).
//
// The accumulator key is `${rule_id}:${scope_token}:${period_start}` and
// period_start is an ISO-8601 timestamp (`…T00:00:00.000Z`) that CONTAINS
// colons. doSync() previously reconstructed the key with `split(':')` + a
// 3-way destructure, which truncated period_start to the hour segment. That
// caused two failures:
//   1. the snapshot POSTed to the backend carried a malformed period_start;
//   2. the server-truth write-back computed a DIFFERENT key than the live
//      entry, so the real accumulator was never overwritten (silent drift).
// The Python SDK already does the right thing via `composite.split(":", 2)`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { init, _resetConfigForTests } from '../src/core/config.js';
import { add, get, runSyncNow, _resetAccumulatorForTests } from '../src/core/budget_accumulator.js';

const VALID_KEY = 'pv_live_aabbccdd_' + 'a'.repeat(32);

// A period_start with colons — exactly what periodStartUtc() emits.
const PERIOD_START = '2026-06-07T00:00:00.000Z';
const KEY = {
  rule_id: 'rule_123',
  scope: 'pooled' as const,
  customer_id: null,
  period_start: PERIOD_START,
};

describe('budget accumulator — /budget/sync key round-trip', () => {
  beforeEach(() => {
    _resetConfigForTests();
    _resetAccumulatorForTests();
    init({ apiKey: VALID_KEY, endpoint: 'http://mock', batchSize: 1, flushInterval: 60_000 });
  });

  afterEach(() => {
    _resetAccumulatorForTests();
    _resetConfigForTests();
    vi.restoreAllMocks();
  });

  it('POSTs the full ISO period_start and overwrites the live entry with server truth', async () => {
    // Local container under-counts (e.g. it only saw its own slice of spend).
    add(KEY, 5);
    expect(get(KEY).total_usd).toBe(5);

    let postedPeriodStart: unknown;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_url: unknown, opts?: unknown) => {
        const body = JSON.parse((opts as { body: string }).body) as {
          entries: Array<{
            rule_id: string;
            scope: string;
            customer_id: string | null;
            period_start: string;
          }>;
        };
        postedPeriodStart = body.entries[0]?.period_start;
        // Server reconciles against ClickHouse truth: aggregate across all
        // containers is 42 for this (rule, scope, customer, period).
        return new Response(
          JSON.stringify({
            entries: [
              {
                rule_id: 'rule_123',
                scope: 'pooled',
                customer_id: null,
                period_start: PERIOD_START,
                server_total_usd: 42,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ) as Response;
      });

    await runSyncNow();

    // 1. The snapshot must carry the *full* ISO timestamp, not a truncated one.
    expect(postedPeriodStart).toBe(PERIOD_START);

    // 2. The live entry (keyed by the full period_start) must be overwritten
    //    with the server truth — proving setFromSync hit the same key.
    expect(get(KEY).total_usd).toBe(42);

    fetchSpy.mockRestore();
  });

  it('matches sync responses by period_start so adjacent periods cannot swap totals', async () => {
    const priorPeriod = '2026-06-06T00:00:00.000Z';
    const priorKey = { ...KEY, period_start: priorPeriod };

    add(priorKey, 1);
    add(KEY, 2);

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          entries: [
            {
              rule_id: 'rule_123',
              scope: 'pooled',
              customer_id: null,
              period_start: PERIOD_START,
              server_total_usd: 200,
            },
            {
              rule_id: 'rule_123',
              scope: 'pooled',
              customer_id: null,
              period_start: priorPeriod,
              server_total_usd: 100,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ) as Response;
    });

    await runSyncNow();

    expect(get(priorKey).total_usd).toBe(100);
    expect(get(KEY).total_usd).toBe(200);
  });

  it('falls back for old servers that omit period_start when the tuple match is unambiguous', async () => {
    add(KEY, 5);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          entries: [
            {
              rule_id: 'rule_123',
              scope: 'pooled',
              customer_id: null,
              server_total_usd: 42,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ) as Response;
    });

    await runSyncNow();

    expect(get(KEY).total_usd).toBe(42);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('missing period_start'));
  });

  it('skips old-server responses without period_start when multiple periods match', async () => {
    const priorPeriod = '2026-06-06T00:00:00.000Z';
    const priorKey = { ...KEY, period_start: priorPeriod };
    add(priorKey, 1);
    add(KEY, 2);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          entries: [
            {
              rule_id: 'rule_123',
              scope: 'pooled',
              customer_id: null,
              server_total_usd: 200,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ) as Response;
    });

    await runSyncNow();

    expect(get(priorKey).total_usd).toBe(1);
    expect(get(KEY).total_usd).toBe(2);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('multiple local periods'));
  });

  it('batches snapshots above the server 500-entry request cap', async () => {
    const keys = Array.from({ length: 501 }, (_, index) => ({
      rule_id: 'rule-large-audience',
      scope: 'per_customer' as const,
      customer_id: `customer-${index}`,
      period_start: PERIOD_START,
    }));
    for (const key of keys) add(key, 1);

    const postedBatchSizes: number[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: unknown, opts?: unknown) => {
      const body = JSON.parse((opts as { body: string }).body) as {
        entries: Array<{
          rule_id: string;
          scope: 'per_customer';
          customer_id: string;
          period_start: string;
        }>;
      };
      postedBatchSizes.push(body.entries.length);
      if (body.entries.length > 500) return new Response('', { status: 400 });
      return new Response(
        JSON.stringify({
          entries: body.entries.map((entry) => ({
            ...entry,
            server_total_usd: entry.customer_id === 'customer-500' ? 99 : 2,
          })),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    await runSyncNow();

    expect(postedBatchSizes).toEqual([500, 1]);
    expect(get(keys[0]!).total_usd).toBe(2);
    expect(get(keys[500]!).total_usd).toBe(99);
  });

  it('stops the batch cycle after a transport failure', async () => {
    const keys = Array.from({ length: 501 }, (_, index) => ({
      rule_id: 'rule-large-audience',
      scope: 'per_customer' as const,
      customer_id: `customer-${index}`,
      period_start: PERIOD_START,
    }));
    for (const key of keys) add(key, 1);

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('backend unavailable'));

    await runSyncNow();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
