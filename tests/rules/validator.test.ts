// B4-0a — rule validator coverage. Existing variants (cost_threshold,
// budget_limit, margin_protection) ship with B2a route tests; this file
// focuses on the new B4-T1 variants (model_routing + reliability_failover)
// that the validator now accepts.

import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import { RuleEnforcement, RulePeriod, RuleScope, RuleType } from '@pylva/shared';
import {
  POOLED_TARGETING_MESSAGE,
  ruleCreateSchema,
  isSupportedRuleType,
} from '../../src/lib/rules/validator.js';

describe('isSupportedRuleType', () => {
  it('accepts all 5 supported types', () => {
    expect(isSupportedRuleType(RuleType.COST_THRESHOLD)).toBe(true);
    expect(isSupportedRuleType(RuleType.BUDGET_LIMIT)).toBe(true);
    expect(isSupportedRuleType(RuleType.MARGIN_PROTECTION)).toBe(true);
    expect(isSupportedRuleType(RuleType.MODEL_ROUTING)).toBe(true);
    expect(isSupportedRuleType(RuleType.RELIABILITY_FAILOVER)).toBe(true);
  });

  it('rejects unknown types', () => {
    expect(isSupportedRuleType('not_a_type')).toBe(false);
    expect(isSupportedRuleType('')).toBe(false);
  });

  it('rejects the removed customer_throttle type', () => {
    expect(isSupportedRuleType('customer_throttle')).toBe(false);
  });
});

describe('ruleCreateSchema — removed rule types', () => {
  it('rejects customer_throttle payloads', () => {
    const parsed = v.safeParse(ruleCreateSchema, {
      type: 'customer_throttle',
      name: 'old removed rule',
      config: {
        period: RulePeriod.DAY,
        max_calls: 10,
      },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('ruleCreateSchema — model_routing', () => {
  const validBody = {
    type: RuleType.MODEL_ROUTING,
    name: 'route summarize to mini',
    config: {
      scope: RuleScope.PER_CUSTOMER,
      match: { step_name: 'summarize', provider: 'openai', model: 'gpt-4o' },
      route_to: { provider: 'openai', model: 'gpt-4o-mini' },
      fallback: {
        on_cross_provider_auth_error: true,
        on_access_denied: true,
        on_model_not_found: true,
        use_original_model: true,
        skip_same_provider_401: true,
      },
    },
  };

  it('accepts a valid model_routing payload', () => {
    const parsed = v.safeParse(ruleCreateSchema, validBody);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.output.type === RuleType.MODEL_ROUTING) {
      expect(parsed.output.enforcement).toBe(RuleEnforcement.PRE_CALL);
    }
  });

  it('rejects an empty match (would route every call)', () => {
    const parsed = v.safeParse(ruleCreateSchema, {
      ...validBody,
      config: { ...validBody.config, match: {} },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty top-level customer_id', () => {
    const parsed = v.safeParse(ruleCreateSchema, {
      ...validBody,
      customer_id: '',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts arbitrary store-safe provider/model strings in route_to', () => {
    const parsed = v.safeParse(ruleCreateSchema, {
      ...validBody,
      config: {
        ...validBody.config,
        route_to: {
          provider: 'zhipu.chat',
          model: 'ft:gpt-4o-mini:org/name+v1@prod',
        },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects unsafe provider/model strings in route_to', () => {
    const unsafeCases = [
      { provider: '   ', model: 'glm-4' },
      { provider: 'zhipu', model: 'glm\n4' },
      { provider: 'x'.repeat(256), model: 'glm-4' },
    ];

    for (const route_to of unsafeCases) {
      const parsed = v.safeParse(ruleCreateSchema, {
        ...validBody,
        config: { ...validBody.config, route_to },
      });
      expect(parsed.success).toBe(false);
    }
  });

  it('rejects malformed step_name (HTML injection attempt)', () => {
    const parsed = v.safeParse(ruleCreateSchema, {
      ...validBody,
      config: { ...validBody.config, match: { step_name: '<script>alert(1)</script>' } },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects when fallback flags are missing (incomplete contract)', () => {
    const parsed = v.safeParse(ruleCreateSchema, {
      ...validBody,
      config: { ...validBody.config, fallback: { use_original_model: true } },
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts the D41 source_anomaly_id metadata field', () => {
    const parsed = v.safeParse(ruleCreateSchema, {
      ...validBody,
      config: { ...validBody.config, source_anomaly_id: '00000000-0000-0000-0000-000000000aaa' },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a non-UUID source_anomaly_id', () => {
    const parsed = v.safeParse(ruleCreateSchema, {
      ...validBody,
      config: { ...validBody.config, source_anomaly_id: 'not-a-uuid' },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('ruleCreateSchema — reliability_failover', () => {
  const baseConfig = {
    customer_id: 'cust_123',
    primary_provider: 'anthropic',
    backup_provider: 'openai',
    enabled: false,
    consent_to_cost_shift: false,
    trigger_error_rate_pct: 10,
    window_seconds: 300,
    recover_error_rate_pct: 5,
    recover_after_seconds: 300,
    recovery_probe_after_seconds: 1800,
  };

  it('accepts a disabled (draft) failover without consent', () => {
    const parsed = v.safeParse(ruleCreateSchema, {
      type: RuleType.RELIABILITY_FAILOVER,
      name: 'failover anthropic -> openai',
      config: baseConfig,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an enabled failover when consent is granted', () => {
    const parsed = v.safeParse(ruleCreateSchema, {
      type: RuleType.RELIABILITY_FAILOVER,
      name: 'failover anthropic -> openai',
      config: { ...baseConfig, enabled: true, consent_to_cost_shift: true },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an enabled failover without consent (D8/D31)', () => {
    const parsed = v.safeParse(ruleCreateSchema, {
      type: RuleType.RELIABILITY_FAILOVER,
      name: 'failover anthropic -> openai',
      config: { ...baseConfig, enabled: true, consent_to_cost_shift: false },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects when primary_provider == backup_provider', () => {
    const parsed = v.safeParse(ruleCreateSchema, {
      type: RuleType.RELIABILITY_FAILOVER,
      name: 'failover bogus',
      config: { ...baseConfig, primary_provider: 'openai', backup_provider: 'openai' },
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts arbitrary store-safe provider names', () => {
    const parsed = v.safeParse(ruleCreateSchema, {
      type: RuleType.RELIABILITY_FAILOVER,
      name: 'failover cohere-extreme',
      config: { ...baseConfig, primary_provider: 'cohere-extreme' },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects unsafe provider names', () => {
    const parsed = v.safeParse(ruleCreateSchema, {
      type: RuleType.RELIABILITY_FAILOVER,
      name: 'failover bogus',
      config: { ...baseConfig, primary_provider: 'cohere\nextreme' },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects empty customer_id (failover is per-customer only)', () => {
    const parsed = v.safeParse(ruleCreateSchema, {
      type: RuleType.RELIABILITY_FAILOVER,
      name: 'failover bogus',
      config: { ...baseConfig, customer_id: '' },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects out-of-range trigger threshold', () => {
    const parsed = v.safeParse(ruleCreateSchema, {
      type: RuleType.RELIABILITY_FAILOVER,
      name: 'failover bogus',
      config: { ...baseConfig, trigger_error_rate_pct: 0 },
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts the D31 backup-model + consent snapshot fields', () => {
    const parsed = v.safeParse(ruleCreateSchema, {
      type: RuleType.RELIABILITY_FAILOVER,
      name: 'failover with snapshot',
      config: {
        ...baseConfig,
        enabled: true,
        consent_to_cost_shift: true,
        backup_model: 'ft:gpt-4o-mini:org/name+v1@prod',
        consent_backup_input_per_1m_usd: 3.0,
        consent_backup_output_per_1m_usd: 15.0,
        consent_observed_at: '2026-04-01T00:00:00.000Z',
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects negative consent prices', () => {
    const parsed = v.safeParse(ruleCreateSchema, {
      type: RuleType.RELIABILITY_FAILOVER,
      name: 'failover bogus',
      config: { ...baseConfig, consent_backup_input_per_1m_usd: -1 },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('ruleCreateSchema — margin_protection (B4 expanded)', () => {
  it('accepts the B2a-shape margin rule (backwards compatible)', () => {
    const parsed = v.safeParse(ruleCreateSchema, {
      type: RuleType.MARGIN_PROTECTION,
      name: 'margin guard',
      config: { margin_threshold_pct: 20, period: RulePeriod.MONTH, scope: RuleScope.PER_CUSTOMER },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.output.type === RuleType.MARGIN_PROTECTION) {
      expect(parsed.output.config.insufficient_revenue_data_treatment).toBe('skip');
      expect(parsed.output.config.ab_suggestion_traffic_pct).toBe(10);
    }
  });

  it('accepts an explicit ab_suggestion override', () => {
    const parsed = v.safeParse(ruleCreateSchema, {
      type: RuleType.MARGIN_PROTECTION,
      name: 'margin guard aggressive',
      config: {
        margin_threshold_pct: 25,
        period: RulePeriod.MONTH,
        scope: RuleScope.PER_CUSTOMER,
        ab_suggestion_traffic_pct: 25,
        insufficient_revenue_data_treatment: 'alert',
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects ab_suggestion_traffic_pct over 50', () => {
    const parsed = v.safeParse(ruleCreateSchema, {
      type: RuleType.MARGIN_PROTECTION,
      name: 'margin guard',
      config: {
        margin_threshold_pct: 20,
        period: RulePeriod.MONTH,
        scope: RuleScope.PER_CUSTOMER,
        ab_suggestion_traffic_pct: 90,
      },
    });
    expect(parsed.success).toBe(false);
  });
});

// F3 (B4): a pooled-scope rule aggregates spend across ALL end-users, so
// combining it with a single-customer target has no coherent meaning (that
// customer would be gated on everyone's spend) and broke budget-sync
// resolution — the SDK's blocked state was wiped every sync cycle. The
// schema now rejects the combination on every scoped rule type.
describe('ruleCreateSchema — pooled scope must not target a customer', () => {
  const scopedVariants = [
    [
      RuleType.BUDGET_LIMIT,
      { limit_usd: 5, period: RulePeriod.DAY, hard_stop: true, scope: RuleScope.POOLED },
    ],
    [
      RuleType.COST_THRESHOLD,
      { threshold_usd: 25, period: RulePeriod.DAY, scope: RuleScope.POOLED },
    ],
    [
      RuleType.MARGIN_PROTECTION,
      { margin_threshold_pct: 20, period: RulePeriod.MONTH, scope: RuleScope.POOLED },
    ],
  ] as const;

  it.each(scopedVariants)('rejects pooled+targeted %s', (type, config) => {
    const parsed = v.safeParse(ruleCreateSchema, {
      type,
      name: 'pooled but targeted',
      customer_id: 'cust_1',
      config,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues[0]?.message).toBe(POOLED_TARGETING_MESSAGE);
    }
  });

  it.each(scopedVariants)('accepts pooled %s without a customer target', (type, config) => {
    const parsed = v.safeParse(ruleCreateSchema, {
      type,
      name: 'pooled untargeted',
      config,
    });
    expect(parsed.success).toBe(true);
  });

  it.each(scopedVariants)(
    'accepts pooled %s with an explicit null customer target',
    (type, config) => {
      const parsed = v.safeParse(ruleCreateSchema, {
        type,
        name: 'pooled null target',
        customer_id: null,
        config,
      });
      expect(parsed.success).toBe(true);
    },
  );

  it('still accepts per_customer scope with a customer target', () => {
    const parsed = v.safeParse(ruleCreateSchema, {
      type: RuleType.BUDGET_LIMIT,
      name: 'targeted per-customer cap',
      customer_id: 'cust_1',
      config: { limit_usd: 5, period: RulePeriod.DAY, hard_stop: true, scope: RuleScope.PER_CUSTOMER },
    });
    expect(parsed.success).toBe(true);
  });
});
