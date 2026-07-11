import { describe, expect, it } from 'vitest';
import { RuleType } from '@pylva/shared';
import {
  ADVANCED_RULE_TYPES,
  LIVE_TRAFFIC_RULE_TYPES,
  affectsLiveTraffic,
  isAdvancedRuleType,
} from '../../src/lib/rules/categories.js';

// Pure categorization helpers — no mocks. These pin the exact set membership:
// the tier-gate (advanced) and activation-warning (live traffic) surfaces both
// key off these sets, so accidental additions/removals must fail loudly.

describe('ADVANCED_RULE_TYPES', () => {
  it('contains exactly model_routing, reliability_failover, margin_protection', () => {
    expect([...ADVANCED_RULE_TYPES].sort()).toEqual([
      'margin_protection',
      'model_routing',
      'reliability_failover',
    ]);
  });
});

describe('LIVE_TRAFFIC_RULE_TYPES', () => {
  it('contains exactly model_routing, reliability_failover, budget_limit', () => {
    expect([...LIVE_TRAFFIC_RULE_TYPES].sort()).toEqual([
      'budget_limit',
      'model_routing',
      'reliability_failover',
    ]);
  });
});

describe('isAdvancedRuleType', () => {
  it.each([RuleType.MODEL_ROUTING, RuleType.RELIABILITY_FAILOVER, RuleType.MARGIN_PROTECTION])(
    'classifies %s as advanced',
    (type) => {
      expect(isAdvancedRuleType(type)).toBe(true);
    },
  );

  it.each([RuleType.COST_THRESHOLD, RuleType.BUDGET_LIMIT])('classifies %s as basic', (type) => {
    expect(isAdvancedRuleType(type)).toBe(false);
  });

  it.each(['', 'customer_throttle', 'MODEL_ROUTING', 'model-routing', 'not-a-rule-type'])(
    'rejects unknown type string %j',
    (type) => {
      expect(isAdvancedRuleType(type)).toBe(false);
    },
  );
});

describe('affectsLiveTraffic', () => {
  it.each([RuleType.MODEL_ROUTING, RuleType.RELIABILITY_FAILOVER, RuleType.BUDGET_LIMIT])(
    '%s reshapes live SDK traffic (pre-call)',
    (type) => {
      expect(affectsLiveTraffic(type)).toBe(true);
    },
  );

  it.each([RuleType.COST_THRESHOLD, RuleType.MARGIN_PROTECTION])(
    '%s only fires alerts (post-call)',
    (type) => {
      expect(affectsLiveTraffic(type)).toBe(false);
    },
  );
});
