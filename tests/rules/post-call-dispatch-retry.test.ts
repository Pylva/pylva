// F7 (B7): the post-call evaluator reserved its per-period dedup key BEFORE
// loading channels + dispatching. One transient failure (channel query,
// dispatch) left the key set, silencing that alert for the entire remaining
// period. The reservation now rolls back on failure so the next ingest
// retries — while a successful dispatch still dedups, and the pre-dispatch
// reservation still guards concurrent ingest batches.
//
// F8 (B10): `action_taken: 'blocked'` is a claim that traffic was refused.
// Only pre_call hard stops refuse calls; post_call budget rules and soft
// rules merely observed the overshoot, so they must report 'warned'.

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
  markRuleTriggered: vi.fn(async () => undefined),
}));

vi.mock('../../src/lib/budget/aggregate.js', () => ({
  aggregateSpendForRule: mocks.aggregateSpendForRule,
}));

vi.mock('../../src/lib/alerts/delivery.js', () => ({
  deliverAlert: mocks.deliverAlert,
}));

vi.mock('../../src/lib/rules/repository.js', () => ({
  listActiveRulesForCustomer: mocks.listActiveRulesForCustomer,
  // The evaluator consumes the mapped-entries helper; raw rows of [] map
  // to [], so one mock serves both shapes.
  listAlertChannelEntriesForRule: mocks.listChannelsForRule,
  markRuleTriggered: mocks.markRuleTriggered,
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

const { evaluatePostCall, _resetPostCallEvalForTests } = await import(
  '../../src/lib/rules/post-call-evaluator'
);

function budgetRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 'rule-1',
    builder_id: 'builder-a',
    type: RuleType.BUDGET_LIMIT,
    enforcement: RuleEnforcement.POST_CALL,
    name: 'Daily budget',
    enabled: true,
    config: {
      limit_usd: 10,
      period: RulePeriod.DAY,
      scope: RuleScope.PER_CUSTOMER,
      hard_stop: false,
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

const event = {
  customer_id: 'builder-a:alice',
  cost_usd: 12,
  timestamp: '2026-06-10T12:00:00.000Z',
};

function deliveredAction(callIndex = 0): unknown {
  const payload = mocks.deliverAlert.mock.calls[callIndex]?.[0].payload.payload as {
    data?: { action_taken?: string };
  };
  return payload.data?.action_taken;
}

describe('post-call dispatch failure releases the dedup reservation (B7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.aggregateSpendForRule.mockResolvedValue(12);
    mocks.deliverAlert.mockResolvedValue(undefined);
    mocks.listActiveRulesForCustomer.mockResolvedValue([budgetRule()]);
    mocks.listChannelsForRule.mockResolvedValue([]);
    _resetPostCallEvalForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries on the next ingest after a transient channel-load failure', async () => {
    mocks.listChannelsForRule.mockRejectedValueOnce(new Error('pg connection reset'));

    await evaluatePostCall('builder-a', [event]);
    expect(mocks.deliverAlert).not.toHaveBeenCalled();

    await evaluatePostCall('builder-a', [event]);
    expect(mocks.deliverAlert).toHaveBeenCalledTimes(1);
  });

  it('retries on the next ingest after a transient dispatch failure', async () => {
    mocks.deliverAlert.mockRejectedValueOnce(new Error('alert_history write failed'));

    await evaluatePostCall('builder-a', [event]);
    await evaluatePostCall('builder-a', [event]);

    expect(mocks.deliverAlert).toHaveBeenCalledTimes(2);
  });

  it('still dedups within the period after a successful dispatch', async () => {
    await evaluatePostCall('builder-a', [event]);
    await evaluatePostCall('builder-a', [event]);

    expect(mocks.deliverAlert).toHaveBeenCalledTimes(1);
  });

  it('does not let one rule failure silence other rules for the same customer', async () => {
    const failing = budgetRule();
    const healthy = budgetRule({ id: 'rule-2', name: 'Second budget' });
    mocks.listActiveRulesForCustomer.mockResolvedValue([failing, healthy]);
    // First rule's channel load fails; second rule's succeeds.
    mocks.listChannelsForRule.mockRejectedValueOnce(new Error('pg connection reset'));

    await evaluatePostCall('builder-a', [event]);

    expect(mocks.deliverAlert).toHaveBeenCalledTimes(1);
    expect(mocks.deliverAlert.mock.calls[0]?.[0].rule_id).toBe('rule-2');
  });
});

describe("post-call 'blocked' claim accuracy (B10)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.aggregateSpendForRule.mockResolvedValue(12);
    mocks.deliverAlert.mockResolvedValue(undefined);
    mocks.listChannelsForRule.mockResolvedValue([]);
    _resetPostCallEvalForTests();
  });

  it("reports 'blocked' for a pre_call hard stop", async () => {
    mocks.listActiveRulesForCustomer.mockResolvedValue([
      budgetRule({
        enforcement: RuleEnforcement.PRE_CALL,
        config: {
          limit_usd: 10,
          period: RulePeriod.DAY,
          scope: RuleScope.PER_CUSTOMER,
          hard_stop: true,
        },
      }),
    ]);

    await evaluatePostCall('builder-a', [event]);

    expect(deliveredAction()).toBe('blocked');
  });

  it("reports 'warned' for a post_call rule even with hard_stop=true", async () => {
    // A post_call budget rule never refuses traffic — the SDK only enforces
    // pre_call rules. Claiming 'blocked' would misstate what happened.
    mocks.listActiveRulesForCustomer.mockResolvedValue([
      budgetRule({
        enforcement: RuleEnforcement.POST_CALL,
        config: {
          limit_usd: 10,
          period: RulePeriod.DAY,
          scope: RuleScope.PER_CUSTOMER,
          hard_stop: true,
        },
      }),
    ]);

    await evaluatePostCall('builder-a', [event]);

    expect(deliveredAction()).toBe('warned');
  });

  it("reports 'warned' for a soft pre_call rule", async () => {
    mocks.listActiveRulesForCustomer.mockResolvedValue([
      budgetRule({
        enforcement: RuleEnforcement.PRE_CALL,
        config: {
          limit_usd: 10,
          period: RulePeriod.DAY,
          scope: RuleScope.PER_CUSTOMER,
          hard_stop: false,
        },
      }),
    ]);

    await evaluatePostCall('builder-a', [event]);

    expect(deliveredAction()).toBe('warned');
  });
});
