// /budget/sync must aggregate the period the SDK asked about, not the
// server-clock current period.
//
// The response echoes entry.period_start as the SDK's accumulator key
// (setFromSync REPLACES local, I-T3-3), so reconciling against the server's
// own current period returned one period's total keyed as another whenever a
// sync crossed a period boundary in flight (request latency or SDK↔server
// clock skew):
//   - server ahead of the SDK → old-period key answered with the new
//     period's ~$0 total → SDK wiped its accumulated spend → hard_stop
//     budget under-enforced for the rest of the SDK's period;
//   - SDK ahead of the server → new-period key answered with the finished
//     period's full total → hard_stop falsely blocked the customer's
//     traffic until the next sync (up to SYNC_INTERVAL_MS).
// The unbounded `timestamp >= from` also let an old-period reconcile absorb
// new-period spend. These tests pin the [from, to) window to the period
// containing entry.period_start.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RuleEnforcement,
  RulePeriod,
  RuleScope,
  RuleStatus,
  RuleType,
  type Rule,
} from '@pylva/shared';

const mocks = vi.hoisted(() => ({
  queryCostEvents: vi.fn(),
  getRule: vi.fn(),
}));

vi.mock('../../src/lib/clickhouse/client.js', () => ({
  queryCostEvents: mocks.queryCostEvents,
}));

vi.mock('../../src/lib/rules/repository.js', () => ({
  getRule: mocks.getRule,
}));

const { reconcileBudgetSync } = await import('../../src/lib/budget/sync-handler.js');

function budgetRule(period: RulePeriod): Rule {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    builder_id: 'builder-a',
    type: RuleType.BUDGET_LIMIT,
    enforcement: RuleEnforcement.POST_CALL,
    name: 'Budget',
    enabled: true,
    config: { limit_usd: 10, period, scope: RuleScope.PER_CUSTOMER },
    customer_id: 'alice',
    status: RuleStatus.ACTIVE,
    activated_at: null,
    last_triggered_at: null,
    last_error: null,
    created_at: new Date('2026-06-01T00:00:00.000Z'),
    updated_at: new Date('2026-06-01T00:00:00.000Z'),
  };
}

function syncEntry(periodStart: string) {
  return {
    rule_id: '11111111-1111-4111-8111-111111111111',
    scope: RuleScope.PER_CUSTOMER,
    customer_id: 'alice',
    accumulated_cost_usd: 3,
    period_start: periodStart,
    event_count: 1,
  };
}

function queryParams(): Record<string, string> {
  return mocks.queryCostEvents.mock.calls[0]?.[2] as Record<string, string>;
}

function querySql(): string {
  return mocks.queryCostEvents.mock.calls[0]?.[1] as string;
}

describe('budget sync period window', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.queryCostEvents.mockResolvedValue([{ s: '4.5' }]);
    mocks.getRule.mockResolvedValue(budgetRule(RulePeriod.HOUR));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("aggregates the SDK's period when the server clock has already rolled into the next one", async () => {
    // Sync sent at 13:59:59.9 SDK-time lands at 14:00:00.5 server-time.
    vi.setSystemTime(new Date('2026-06-10T14:00:00.500Z'));

    const result = await reconcileBudgetSync('builder-a', [syncEntry('2026-06-10T13:00:00.000Z')]);

    expect(queryParams().from).toBe('2026-06-10 13:00:00');
    expect(queryParams().to).toBe('2026-06-10 14:00:00');
    expect(querySql()).toContain('timestamp < {to:DateTime}');
    expect(result[0]?.period_start).toBe('2026-06-10T13:00:00.000Z');
    expect(result[0]?.server_total_usd).toBe(4.5);
  });

  it('does not fold the finished period into a new-period key when the server clock lags the SDK', async () => {
    // SDK clock a second ahead: it already keys 14:00 while the server is
    // still at 13:59. Pre-fix this aggregated the entire 13:00 hour and the
    // SDK applied it to the 14:00 accumulator (false hard stop).
    vi.setSystemTime(new Date('2026-06-10T13:59:59.000Z'));

    const result = await reconcileBudgetSync('builder-a', [syncEntry('2026-06-10T14:00:00.000Z')]);

    expect(queryParams().from).toBe('2026-06-10 14:00:00');
    expect(queryParams().to).toBe('2026-06-10 15:00:00');
    expect(result[0]?.period_start).toBe('2026-06-10T14:00:00.000Z');
  });

  it('snaps a mid-period timestamp to the period boundaries containing it', async () => {
    mocks.getRule.mockResolvedValue(budgetRule(RulePeriod.DAY));
    vi.setSystemTime(new Date('2026-06-10T12:00:00.000Z'));

    await reconcileBudgetSync('builder-a', [syncEntry('2026-06-09T17:30:00.000Z')]);

    expect(queryParams().from).toBe('2026-06-09 00:00:00');
    expect(queryParams().to).toBe('2026-06-10 00:00:00');
  });

  it('falls back to the server-clock current period when period_start is unparseable', async () => {
    vi.setSystemTime(new Date('2026-06-10T14:30:00.000Z'));

    await reconcileBudgetSync('builder-a', [syncEntry('not-a-timestamp')]);

    expect(queryParams().from).toBe('2026-06-10 14:00:00');
    expect(queryParams().to).toBe('2026-06-10 15:00:00');
  });

  it('falls back when period_start parses to an out-of-bounds year instead of 500ing on a malformed ClickHouse literal', async () => {
    vi.setSystemTime(new Date('2026-06-10T14:30:00.000Z'));

    // new Date(8.64e15).toISOString() is "+275760-09-13..." — chTimestamp's
    // 19-char slice would truncate it into an invalid DateTime param.
    await reconcileBudgetSync('builder-a', [syncEntry(new Date(8.64e15).toISOString())]);

    expect(queryParams().from).toBe('2026-06-10 14:00:00');
    expect(queryParams().to).toBe('2026-06-10 15:00:00');
  });
});

// F3 (B4): sync resolution looks the rule up BY ID and checks applicability,
// instead of listActiveRulesForCustomer. A legacy pooled rule that still
// carries a customer target (created before the validator rejected the
// combination) syncs with customer_id=null — under the old listing-based
// lookup it was never found, so every sync returned the "deleted" zero
// total and wiped the SDK's blocked state (customers oscillated between
// blocked and unblocked every cycle).
describe('budget sync rule resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-10T14:30:00.000Z'));
    mocks.queryCostEvents.mockResolvedValue([{ s: '12' }]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function pooledTargetedRule(overrides: Partial<Rule> = {}): Rule {
    return {
      ...budgetRule(RulePeriod.HOUR),
      config: { limit_usd: 10, period: RulePeriod.HOUR, scope: RuleScope.POOLED },
      customer_id: 'alice',
      ...overrides,
    };
  }

  function pooledEntry() {
    return {
      rule_id: '11111111-1111-4111-8111-111111111111',
      scope: RuleScope.POOLED,
      customer_id: null,
      accumulated_cost_usd: 3,
      period_start: '2026-06-10T14:00:00.000Z',
      event_count: 1,
    };
  }

  it('reconciles a legacy pooled+targeted rule instead of wiping the accumulator', async () => {
    mocks.getRule.mockResolvedValue(pooledTargetedRule());

    const result = await reconcileBudgetSync('builder-a', [pooledEntry()]);

    // Real server total (not the deleted-rule zero) and the exceeded flag
    // computed against the rule's limit — 12 >= 10.
    expect(result[0]?.server_total_usd).toBe(12);
    expect(result[0]?.budget_exceeded).toBe(true);
    expect(result[0]?.budget_remaining_usd).toBe(0);
    // Pooled → aggregated across ALL customers (no customer_id filter).
    expect(mocks.queryCostEvents).toHaveBeenCalledTimes(1);
    expect(querySql()).not.toContain('customer_id = {customer_id:String}');
    expect(queryParams()).not.toHaveProperty('customer_id');
  });

  it('returns the trim response for a disabled rule', async () => {
    mocks.getRule.mockResolvedValue(pooledTargetedRule({ enabled: false }));

    const result = await reconcileBudgetSync('builder-a', [pooledEntry()]);

    expect(result[0]?.server_total_usd).toBe(0);
    expect(result[0]?.budget_exceeded).toBe(false);
    expect(mocks.queryCostEvents).not.toHaveBeenCalled();
  });

  it('returns the trim response for a draft rule', async () => {
    mocks.getRule.mockResolvedValue(pooledTargetedRule({ status: RuleStatus.DRAFT }));

    const result = await reconcileBudgetSync('builder-a', [pooledEntry()]);

    expect(result[0]?.server_total_usd).toBe(0);
    expect(mocks.queryCostEvents).not.toHaveBeenCalled();
  });

  it('returns the trim response for a deleted or cross-tenant rule id', async () => {
    mocks.getRule.mockResolvedValue(null);

    const result = await reconcileBudgetSync('builder-a', [pooledEntry()]);

    expect(result[0]?.server_total_usd).toBe(0);
    expect(mocks.queryCostEvents).not.toHaveBeenCalled();
  });

  it('trims a per-customer entry whose rule now targets a different customer', async () => {
    // Retarget race: SDK still holds an accumulator for bob, but the rule
    // was moved to alice between fetches. The stale entry must trim.
    mocks.getRule.mockResolvedValue(budgetRule(RulePeriod.HOUR));

    const result = await reconcileBudgetSync('builder-a', [
      {
        rule_id: '11111111-1111-4111-8111-111111111111',
        scope: RuleScope.PER_CUSTOMER,
        customer_id: 'bob',
        accumulated_cost_usd: 3,
        period_start: '2026-06-10T14:00:00.000Z',
        event_count: 1,
      },
    ]);

    expect(result[0]?.server_total_usd).toBe(0);
    expect(mocks.queryCostEvents).not.toHaveBeenCalled();
  });

  it('still reconciles a per-customer entry for the targeted customer', async () => {
    mocks.getRule.mockResolvedValue(budgetRule(RulePeriod.HOUR));

    const result = await reconcileBudgetSync('builder-a', [syncEntry('2026-06-10T14:00:00.000Z')]);

    expect(result[0]?.server_total_usd).toBe(12);
    expect(result[0]?.budget_exceeded).toBe(true);
    // Per-customer → aggregation scoped to the composite customer id.
    expect(queryParams().customer_id).toBe('builder-a:alice');
  });
});
