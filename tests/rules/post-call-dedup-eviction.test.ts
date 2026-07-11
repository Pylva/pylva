// Regression: the post-call evaluator's dedup sweep must evict keys only
// after their rule period has ENDED. The original sweep evicted any key
// whose period_start was >2 days old, which wiped live week/month keys two
// days into the period — every subsequent ingest event re-fired the same
// cost_threshold / budget_limit alert for the rest of the period.

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
  aggregateSpendForRule: vi.fn(),
  deliverAlert: vi.fn(),
  listActiveRulesForCustomer: vi.fn(),
  listChannelsForRule: vi.fn(),
}));

vi.mock('../../src/lib/budget/aggregate.js', () => ({
  aggregateSpendForRule: mocks.aggregateSpendForRule,
}));

vi.mock('../../src/lib/alerts/delivery.js', () => ({
  deliverAlert: mocks.deliverAlert,
}));

vi.mock('../../src/lib/rules/repository.js', () => ({
  listActiveRulesForCustomer: mocks.listActiveRulesForCustomer,
  listAlertChannelEntriesForRule: mocks.listChannelsForRule,
  markRuleTriggered: vi.fn(async () => undefined),
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

function monthlyBudgetRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 'rule-1',
    builder_id: 'builder-a',
    type: RuleType.BUDGET_LIMIT,
    enforcement: RuleEnforcement.POST_CALL,
    name: 'Monthly budget',
    enabled: true,
    config: {
      limit_usd: 10,
      period: RulePeriod.MONTH,
      scope: RuleScope.PER_CUSTOMER,
    },
    customer_id: 'alice',
    status: RuleStatus.ACTIVE,
    activated_at: null,
    last_triggered_at: null,
    last_error: null,
    created_at: new Date('2026-06-01T00:00:00.000Z'),
    updated_at: new Date('2026-06-01T00:00:00.000Z'),
    ...overrides,
  };
}

const EVICTION_SWEEP_MS = 5 * 60 * 1000;

describe('post-call dedup eviction', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    // Mid-month: period_start (June 1) is far older than the old sweep's
    // 2-day cutoff, but the month period is still live.
    vi.setSystemTime(new Date('2026-06-10T12:00:00.000Z'));
    vi.clearAllMocks();
    mocks.aggregateSpendForRule.mockResolvedValue(12);
    mocks.deliverAlert.mockResolvedValue(undefined);
    mocks.listActiveRulesForCustomer.mockResolvedValue([monthlyBudgetRule()]);
    mocks.listChannelsForRule.mockResolvedValue([]);
    const { _resetPostCallEvalForTests } = await import('../../src/lib/rules/post-call-evaluator');
    _resetPostCallEvalForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not re-fire a month-period rule after the 5-minute eviction sweep', async () => {
    const { evaluatePostCall } = await import('../../src/lib/rules/post-call-evaluator');
    const event = {
      customer_id: 'builder-a:alice',
      cost_usd: 12,
      timestamp: '2026-06-10T12:00:00.000Z',
    };

    await evaluatePostCall('builder-a', [event]);
    expect(mocks.deliverAlert).toHaveBeenCalledTimes(1);

    // Run the eviction sweep, then ingest more traffic. The dedup key for
    // the live June period must survive the sweep.
    vi.advanceTimersByTime(EVICTION_SWEEP_MS + 1_000);
    await evaluatePostCall('builder-a', [event]);

    expect(mocks.deliverAlert).toHaveBeenCalledTimes(1);
  });

  it('fires again once a new period starts', async () => {
    const { evaluatePostCall } = await import('../../src/lib/rules/post-call-evaluator');

    await evaluatePostCall('builder-a', [
      {
        customer_id: 'builder-a:alice',
        cost_usd: 12,
        timestamp: '2026-06-10T12:00:00.000Z',
      },
    ]);
    expect(mocks.deliverAlert).toHaveBeenCalledTimes(1);

    // July: new period_start → new dedup key → the July overage alerts.
    vi.setSystemTime(new Date('2026-07-01T01:00:00.000Z'));
    await evaluatePostCall('builder-a', [
      {
        customer_id: 'builder-a:alice',
        cost_usd: 12,
        timestamp: '2026-07-01T01:00:00.000Z',
      },
    ]);

    expect(mocks.deliverAlert).toHaveBeenCalledTimes(2);
  });

  it('still dedups day-period rules within the same day across sweeps', async () => {
    mocks.listActiveRulesForCustomer.mockResolvedValue([
      monthlyBudgetRule({
        config: {
          limit_usd: 10,
          period: RulePeriod.DAY,
          scope: RuleScope.PER_CUSTOMER,
        },
      }),
    ]);
    const { evaluatePostCall } = await import('../../src/lib/rules/post-call-evaluator');
    const event = {
      customer_id: 'builder-a:alice',
      cost_usd: 12,
      timestamp: '2026-06-10T12:00:00.000Z',
    };

    await evaluatePostCall('builder-a', [event]);
    vi.advanceTimersByTime(EVICTION_SWEEP_MS + 1_000);
    await evaluatePostCall('builder-a', [event]);

    expect(mocks.deliverAlert).toHaveBeenCalledTimes(1);
  });

  it('skips disabled rules defensively even if a caller returns one', async () => {
    mocks.listActiveRulesForCustomer.mockResolvedValue([monthlyBudgetRule({ enabled: false })]);
    const { evaluatePostCall } = await import('../../src/lib/rules/post-call-evaluator');

    await evaluatePostCall('builder-a', [
      {
        customer_id: 'builder-a:alice',
        cost_usd: 12,
        timestamp: '2026-06-10T12:00:00.000Z',
      },
    ]);

    expect(mocks.aggregateSpendForRule).not.toHaveBeenCalled();
    expect(mocks.deliverAlert).not.toHaveBeenCalled();
  });
});
