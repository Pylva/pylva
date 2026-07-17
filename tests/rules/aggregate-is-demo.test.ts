// Regression: aggregateSpendForRule (the firing/threshold path used by the
// post-call evaluator, the SDK budget_exceeded flag, and budget sync
// reconciliation) summed cost_events WITHOUT an `is_demo = 0` filter, while
// previewRule and every dashboard query exclude demo events. Seeded demo
// rows (is_demo=1, never purged) therefore counted toward real cost-threshold
// / budget rules — firing a false alert or hard-stopping a real call on fake
// money, while the activation preview showed $0. Rules must act on REAL
// traffic only, matching preview semantics.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  RuleEnforcement,
  RulePeriod,
  RuleScope,
  RuleStatus,
  RuleType,
  type Rule,
} from '@pylva/shared';

const queryMock = vi.fn();

vi.mock('../../src/lib/clickhouse/client.js', () => ({
  queryCostEvents: queryMock,
}));

vi.mock('../../src/lib/clickhouse/datetime.js', () => ({
  chTimestamp: (d: Date) => d.toISOString(),
}));

const { aggregateSpendForRule } = await import('../../src/lib/budget/aggregate.js');

const NOW = new Date('2026-06-14T12:00:00Z');

function makeRule(): Rule {
  return {
    id: 'rule-1',
    builder_id: 'b1',
    type: RuleType.COST_THRESHOLD,
    enforcement: RuleEnforcement.POST_CALL,
    name: 'cost threshold',
    enabled: true,
    customer_id: null,
    status: RuleStatus.ACTIVE,
    activated_at: NOW,
    last_triggered_at: null,
    last_error: null,
    created_at: NOW,
    updated_at: NOW,
    config: {
      threshold_usd: 100,
      period: RulePeriod.MONTH,
      scope: RuleScope.POOLED,
    },
  } as unknown as Rule;
}

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue([{ s: '0' }]);
});

describe('aggregateSpendForRule — excludes demo events', () => {
  it('filters is_demo = 0 in the pooled aggregate (rules act on real traffic)', async () => {
    await aggregateSpendForRule('b1', makeRule(), null);

    expect(queryMock).toHaveBeenCalledTimes(1);
    const sql = queryMock.mock.calls[0]![1] as string;
    expect(sql).toContain('is_demo = 0');
  });

  it('keeps is_demo = 0 in the per-customer + windowed variant', async () => {
    await aggregateSpendForRule('b1', makeRule(), 'b1:cust-1', {
      from: new Date('2026-06-01T00:00:00Z'),
      to: NOW,
    });

    const sql = queryMock.mock.calls[0]![1] as string;
    expect(sql).toContain('is_demo = 0');
    // The is_demo predicate must not crowd out the existing tenant / window
    // / customer predicates.
    expect(sql).toContain('builder_id = {builder_id:String}');
    expect(sql).toContain('customer_id = {customer_id:String}');
    expect(sql).toContain("timestamp < parseDateTime64BestEffort({to:String}, 3, 'UTC')");
  });
});
