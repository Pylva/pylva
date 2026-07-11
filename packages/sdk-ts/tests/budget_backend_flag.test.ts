// Backend budget_exceeded flags must produce a backend_ingest_flag refusal on
// the next matching pre-call.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const cachedRules: unknown[] = [];

vi.mock('../src/core/rules_cache.js', () => ({
  ensureRulesCache: vi.fn(async () => {}),
  getCachedRules: () => cachedRules,
  isPassthrough: () => false,
}));

const { maybeEnforcePreCall } = await import('../src/wrappers/_budget.js');
const { markExceededFromBackend, _resetAccumulatorForTests } =
  await import('../src/core/budget_accumulator.js');
const { PylvaBudgetExceeded, BudgetExceededSource } =
  await import('../src/errors/budget_exceeded.js');

function currentDayStartUtc(): string {
  const d = new Date();
  d.setUTCMilliseconds(0);
  d.setUTCSeconds(0);
  d.setUTCMinutes(0);
  d.setUTCHours(0);
  return d.toISOString();
}

describe('maybeEnforcePreCall — backend budget_exceeded flag', () => {
  beforeEach(() => {
    cachedRules.length = 0;
    _resetAccumulatorForTests();
  });

  it('throws backend_ingest_flag after the backend marks a matching budget exceeded', () => {
    const periodStart = currentDayStartUtc();
    cachedRules.push({
      id: 'rule-1',
      type: 'budget_limit',
      enabled: true,
      customer_id: 'cust_1',
      config: {
        limit_usd: 10,
        period: 'day',
        hard_stop: true,
        scope: 'per_customer',
      },
    });
    markExceededFromBackend({
      rule_id: 'rule-1',
      customer_id: 'cust_1',
      limit_usd: 10,
      accumulated_usd: 12,
      period: 'day',
      period_start: periodStart,
    });

    try {
      maybeEnforcePreCall({ customer_id: 'cust_1', estimated_usd: 0 });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PylvaBudgetExceeded);
      if (err instanceof PylvaBudgetExceeded) {
        expect(err.source).toBe(BudgetExceededSource.BACKEND_INGEST_FLAG);
        expect(err.customer_id).toBe('cust_1');
      }
    }
  });
});
