// Budget /sync reconciliation must round-trip period_start losslessly.
//
// Regression for the composite-key split bug: the accumulator key is
// `${rule_id}:${scope_token}:${period_start}` and period_start is an ISO-8601
// timestamp containing colons. A naive `split(':')` truncated period_start at
// the first inner colon, so (a) the snapshot POSTed to /budget/sync carried a
// corrupted period_start and (b) setFromSync wrote the server truth to a
// phantom key, leaving the real accumulator entry un-reconciled forever
// (I-T3-3 overwrite semantics broken). Python's SDK used split(':', 2) and was
// correct — this asserts TS parity.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { init, _resetConfigForTests } from '../src/core/config.js';
import { add, get, runSyncNow, _resetAccumulatorForTests } from '../src/core/budget_accumulator.js';

const VALID_KEY = 'pv_live_aabbccdd_' + 'a'.repeat(32);
// Day period_start — contains three inner colons that the old split() ate.
const PERIOD_START = '2026-06-09T00:00:00.000Z';

describe('budget /sync — composite key round-trip', () => {
  beforeEach(() => {
    _resetConfigForTests();
    _resetAccumulatorForTests();
  });

  afterEach(() => {
    _resetAccumulatorForTests();
    _resetConfigForTests();
    vi.restoreAllMocks();
  });

  it('POSTs the full ISO period_start and reconciles the real accumulator entry', async () => {
    // Seed a per-customer/day accumulator entry locally (e.g. after the host
    // made some calls). Local total is 8; server truth is 2 → sync must pull
    // the real entry DOWN to 2.
    add(
      {
        rule_id: 'rule-1',
        scope: 'per_customer',
        customer_id: 'cust_1',
        period_start: PERIOD_START,
      },
      8,
    );

    let sentPeriodStart: unknown;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, opts) => {
      const body = JSON.parse((opts as RequestInit).body as string) as {
        entries: Array<{ period_start: string }>;
      };
      sentPeriodStart = body.entries[0]?.period_start;
      return new Response(
        JSON.stringify({
          entries: [
            {
              rule_id: 'rule-1',
              scope: 'per_customer',
              customer_id: 'cust_1',
              period_start: PERIOD_START,
              server_total_usd: 2,
            },
          ],
        }),
        { status: 200 },
      ) as Response;
    });

    init({
      apiKey: VALID_KEY,
      endpoint: 'http://mock',
      batchSize: 100,
      flushInterval: 60_000,
    });

    await runSyncNow();

    // (a) The snapshot must carry the FULL period_start, not a truncated one.
    expect(sentPeriodStart).toBe(PERIOD_START);

    // (b) The real accumulator entry must now reflect server truth (2), proving
    // setFromSync wrote to the real key and not a phantom truncated-key entry.
    const entry = get({
      rule_id: 'rule-1',
      scope: 'per_customer',
      customer_id: 'cust_1',
      period_start: PERIOD_START,
    });
    expect(entry.total_usd).toBe(2);

    fetchSpy.mockRestore();
  });
});
