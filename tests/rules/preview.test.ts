// B4-1 — pure-unit coverage of previewRule's per-rule-type description +
// scope-filter behavior. ClickHouse client is mocked to return canned
// rows; assertions cover the shape and rule-type-specific summary text.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  RuleEnforcement,
  RuleScope,
  RuleStatus,
  RuleType,
  type ModelRoutingConfig,
  type ReliabilityFailoverConfig,
  type Rule,
} from '@pylva/shared';

const queryMock = vi.fn();

vi.mock('../../src/lib/clickhouse/client.js', () => ({
  queryCostEvents: queryMock,
}));

vi.mock('../../src/lib/clickhouse/datetime.js', () => ({
  chTimestamp: (d: Date) => d.toISOString(),
}));

const { previewRule } = await import('../../src/lib/rules/preview.js');

const NOW = new Date('2026-04-26T12:00:00Z');

function makeRule(overrides: Partial<Rule> & Pick<Rule, 'type' | 'config'>): Rule {
  return {
    id: 'rule-1',
    builder_id: 'b1',
    enforcement: RuleEnforcement.PRE_CALL,
    name: 'test rule',
    enabled: true,
    customer_id: null,
    status: RuleStatus.ACTIVE,
    activated_at: null,
    last_triggered_at: null,
    last_error: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function setupCanned(opts: {
  customers?: Array<{ customer_id: string; event_count: number; total_cost_usd: number }>;
  steps?: Array<{ step_name: string | null; event_count: number }>;
  models?: Array<{ provider: string | null; model: string | null; event_count: number }>;
  total?: { total_event_count: number; total_cost_usd: number };
}): void {
  const customers = opts.customers ?? [
    { customer_id: 'b1:cust_1', event_count: 50, total_cost_usd: 1.25 },
  ];
  const steps = opts.steps ?? [{ step_name: 'summarize', event_count: 50 }];
  const models = opts.models ?? [{ provider: 'openai', model: 'gpt-4o', event_count: 50 }];
  const total = opts.total ?? { total_event_count: 50, total_cost_usd: 1.25 };

  queryMock.mockReset();
  queryMock.mockImplementation((_builderId: string, sql: string) => {
    if (sql.includes('GROUP BY customer_id')) {
      return Promise.resolve(
        customers.map((c) => ({
          customer_id: c.customer_id,
          event_count: String(c.event_count),
          total_cost_usd: String(c.total_cost_usd),
        })),
      );
    }
    if (sql.includes('GROUP BY step_name')) {
      return Promise.resolve(
        steps.map((s) => ({ step_name: s.step_name, event_count: String(s.event_count) })),
      );
    }
    if (sql.includes('GROUP BY provider, model')) {
      return Promise.resolve(
        models.map((m) => ({
          provider: m.provider,
          model: m.model,
          event_count: String(m.event_count),
        })),
      );
    }
    return Promise.resolve([
      {
        total_event_count: String(total.total_event_count),
        total_cost_usd: String(total.total_cost_usd),
      },
    ]);
  });
}

describe('previewRule — model_routing', () => {
  beforeEach(() => {
    setupCanned({});
  });

  it('returns top-N customers/steps/models + live_traffic_warning=true', async () => {
    const cfg: ModelRoutingConfig = {
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
    };
    const rule = makeRule({
      type: RuleType.MODEL_ROUTING,
      config: cfg as unknown as Record<string, unknown>,
    });
    const preview = await previewRule(rule, NOW);

    expect(preview.rule_type).toBe(RuleType.MODEL_ROUTING);
    expect(preview.live_traffic_warning).toBe(true);
    expect(preview.affected_customers).toHaveLength(1);
    expect(preview.affected_customers[0]).toMatchObject({ customer_id: 'cust_1', event_count: 50 });
    expect(preview.description).toContain('gpt-4o-mini');
    expect(preview.description).toContain("step 'summarize'");
  });

  it('strips the builder-id prefix from composite customer_id', async () => {
    setupCanned({
      customers: [{ customer_id: 'b1:cust_external_42', event_count: 10, total_cost_usd: 0.1 }],
    });
    const cfg: ModelRoutingConfig = {
      scope: RuleScope.PER_CUSTOMER,
      match: { step_name: 'evaluate' },
      route_to: { provider: 'openai', model: 'gpt-4o-mini' },
      fallback: {
        on_cross_provider_auth_error: true,
        on_access_denied: true,
        on_model_not_found: true,
        use_original_model: true,
        skip_same_provider_401: true,
      },
    };
    const rule = makeRule({
      type: RuleType.MODEL_ROUTING,
      config: cfg as unknown as Record<string, unknown>,
    });
    const preview = await previewRule(rule, NOW);
    expect(preview.affected_customers[0]?.customer_id).toBe('cust_external_42');
  });

  it('column customer_id wins over match.customer_id (no contradictory AND)', async () => {
    // Regression: validator permits the top-level customer_id COLUMN and
    // config.match.customer_id to be set independently and differ. The SDK
    // engine collapses them with column precedence (ruleCustomer =
    // ruleCustomerId ?? match.customer_id), so a rule with column=cust_A,
    // match.customer_id=cust_B reroutes cust_A's traffic. Preview must NOT
    // emit two contradictory `customer_id =` clauses (which would AND to
    // zero matches and zero the activation impact_pct gate).
    const captured: Array<{ sql: string; params: Record<string, unknown> }> = [];
    queryMock.mockReset();
    queryMock.mockImplementation(
      (_builderId: string, sql: string, params: Record<string, unknown>) => {
        captured.push({ sql, params });
        if (sql.includes('GROUP BY customer_id')) {
          return Promise.resolve([
            { customer_id: 'b1:cust_A', event_count: '500', total_cost_usd: '5' },
          ]);
        }
        if (sql.includes('GROUP BY step_name')) return Promise.resolve([]);
        if (sql.includes('GROUP BY provider, model')) return Promise.resolve([]);
        return Promise.resolve([
          { total_event_count: '500', total_cost_usd: '5', total_customers: '1' },
        ]);
      },
    );

    const cfg: ModelRoutingConfig = {
      scope: RuleScope.PER_CUSTOMER,
      match: { customer_id: 'cust_B', model: 'gpt-4o' },
      route_to: { provider: 'openai', model: 'gpt-4o-mini' },
      fallback: {
        on_cross_provider_auth_error: true,
        on_access_denied: true,
        on_model_not_found: true,
        use_original_model: true,
        skip_same_provider_401: true,
      },
    };
    const rule = makeRule({
      type: RuleType.MODEL_ROUTING,
      customer_id: 'cust_A',
      config: cfg as unknown as Record<string, unknown>,
    });
    const preview = await previewRule(rule, NOW);

    const { sql, params } = captured[0]!;
    // Exactly one customer_id equality predicate, bound to the COLUMN value.
    expect(sql.match(/customer_id = \{/g) ?? []).toHaveLength(1);
    expect(params['customer_id']).toBe('b1:cust_A');
    expect(params).not.toHaveProperty('match_customer_id');
    // ...so the column-customer's live traffic is surfaced, not zeroed out.
    expect(preview.total_event_count).toBe(500);
    expect(preview.affected_customers[0]).toMatchObject({ customer_id: 'cust_A' });
    expect(preview.description).toContain('customer cust_A');
    expect(preview.description).not.toContain('cust_B');
  });

  it('preserves an empty column customer_id for existing model_routing rows', async () => {
    const captured: Array<{ sql: string; params: Record<string, unknown> }> = [];
    queryMock.mockReset();
    queryMock.mockImplementation(
      (_builderId: string, sql: string, params: Record<string, unknown>) => {
        captured.push({ sql, params });
        if (sql.includes('GROUP BY customer_id')) return Promise.resolve([]);
        if (sql.includes('GROUP BY step_name')) return Promise.resolve([]);
        if (sql.includes('GROUP BY provider, model')) return Promise.resolve([]);
        return Promise.resolve([
          { total_event_count: '0', total_cost_usd: '0', total_customers: '0' },
        ]);
      },
    );

    const cfg: ModelRoutingConfig = {
      scope: RuleScope.PER_CUSTOMER,
      match: { customer_id: 'cust_B', model: 'gpt-4o' },
      route_to: { provider: 'openai', model: 'gpt-4o-mini' },
      fallback: {
        on_cross_provider_auth_error: true,
        on_access_denied: true,
        on_model_not_found: true,
        use_original_model: true,
        skip_same_provider_401: true,
      },
    };
    const rule = makeRule({
      type: RuleType.MODEL_ROUTING,
      customer_id: '',
      config: cfg as unknown as Record<string, unknown>,
    });
    const preview = await previewRule(rule, NOW);

    const { sql, params } = captured[0]!;
    expect(sql.match(/customer_id = \{/g) ?? []).toHaveLength(1);
    expect(params['customer_id']).toBe('b1:');
    expect(params).not.toHaveProperty('match_customer_id');
    expect(preview.description).toContain('customer ""');
    expect(preview.description).not.toContain('cust_B');
  });

  it('uses match.customer_id when the column customer_id is unset', async () => {
    const captured: Array<{ sql: string; params: Record<string, unknown> }> = [];
    queryMock.mockReset();
    queryMock.mockImplementation(
      (_builderId: string, sql: string, params: Record<string, unknown>) => {
        captured.push({ sql, params });
        if (sql.includes('GROUP BY customer_id')) {
          return Promise.resolve([
            { customer_id: 'b1:cust_B', event_count: '50', total_cost_usd: '0.5' },
          ]);
        }
        if (sql.includes('GROUP BY step_name')) return Promise.resolve([]);
        if (sql.includes('GROUP BY provider, model')) return Promise.resolve([]);
        return Promise.resolve([
          { total_event_count: '50', total_cost_usd: '0.5', total_customers: '1' },
        ]);
      },
    );

    const cfg: ModelRoutingConfig = {
      scope: RuleScope.PER_CUSTOMER,
      match: { customer_id: 'cust_B', model: 'gpt-4o' },
      route_to: { provider: 'openai', model: 'gpt-4o-mini' },
      fallback: {
        on_cross_provider_auth_error: true,
        on_access_denied: true,
        on_model_not_found: true,
        use_original_model: true,
        skip_same_provider_401: true,
      },
    };
    const rule = makeRule({
      type: RuleType.MODEL_ROUTING,
      config: cfg as unknown as Record<string, unknown>,
    });
    const preview = await previewRule(rule, NOW);

    const { sql, params } = captured[0]!;
    expect(sql.match(/customer_id = \{/g) ?? []).toHaveLength(1);
    expect(params['customer_id']).toBe('b1:cust_B');
    expect(params).not.toHaveProperty('match_customer_id');
    expect(preview.total_event_count).toBe(50);
    expect(preview.description).toContain('customer cust_B');
  });

  it('emits a warning when no events match', async () => {
    setupCanned({
      customers: [],
      steps: [],
      models: [],
      total: { total_event_count: 0, total_cost_usd: 0 },
    });
    const cfg: ModelRoutingConfig = {
      scope: RuleScope.PER_CUSTOMER,
      match: { step_name: 'never_run' },
      route_to: { provider: 'openai', model: 'gpt-4o-mini' },
      fallback: {
        on_cross_provider_auth_error: true,
        on_access_denied: true,
        on_model_not_found: true,
        use_original_model: true,
        skip_same_provider_401: true,
      },
    };
    const rule = makeRule({
      type: RuleType.MODEL_ROUTING,
      config: cfg as unknown as Record<string, unknown>,
    });
    const preview = await previewRule(rule, NOW);
    expect(preview.warnings.some((w) => w.includes('No events matched'))).toBe(true);
  });
});

describe('previewRule — reliability_failover', () => {
  beforeEach(() => setupCanned({}));

  it('describes the primary→backup transition + lists the customer', async () => {
    const cfg: ReliabilityFailoverConfig = {
      customer_id: 'cust_42',
      primary_provider: 'anthropic',
      backup_provider: 'openai',
      enabled: false,
      consent_to_cost_shift: true,
      trigger_error_rate_pct: 10,
      window_seconds: 300,
      recover_error_rate_pct: 5,
      recover_after_seconds: 300,
      recovery_probe_after_seconds: 1800,
    };
    const rule = makeRule({
      type: RuleType.RELIABILITY_FAILOVER,
      config: cfg as unknown as Record<string, unknown>,
    });
    const preview = await previewRule(rule, NOW);
    expect(preview.live_traffic_warning).toBe(true);
    expect(preview.description).toContain('anthropic');
    expect(preview.description).toContain('openai');
    expect(preview.description).toContain('cust_42');
  });

  it('scopes by config.customer_id only — column customer_id never ANDs a second predicate', async () => {
    // Regression: validator permits the top-level customer_id COLUMN
    // (baseMeta) and config.customer_id (reliabilityFailoverConfig) to be set
    // independently and differ. The SDK apply path (findFailoverRule) matches
    // on cfg.customer_id ONLY and ignores the column, so preview must scope by
    // cfg.customer_id alone. Previously the else branch also appended
    // `AND customer_id = {column}`, producing `customer_id = cust_A AND
    // customer_id = cust_B` → zero matches → zeroed activation impact_pct gate
    // even though the rule reroutes cust_B's live traffic (apply≠preview).
    const captured: Array<{ sql: string; params: Record<string, unknown> }> = [];
    queryMock.mockReset();
    queryMock.mockImplementation(
      (_builderId: string, sql: string, params: Record<string, unknown>) => {
        captured.push({ sql, params });
        if (sql.includes('GROUP BY customer_id')) {
          return Promise.resolve([
            { customer_id: 'b1:cust_B', event_count: '300', total_cost_usd: '3' },
          ]);
        }
        if (sql.includes('GROUP BY step_name')) return Promise.resolve([]);
        if (sql.includes('GROUP BY provider, model')) return Promise.resolve([]);
        return Promise.resolve([
          { total_event_count: '300', total_cost_usd: '3', total_customers: '1' },
        ]);
      },
    );

    const cfg: ReliabilityFailoverConfig = {
      customer_id: 'cust_B',
      primary_provider: 'anthropic',
      backup_provider: 'openai',
      enabled: false,
      consent_to_cost_shift: true,
      trigger_error_rate_pct: 10,
      window_seconds: 300,
      recover_error_rate_pct: 5,
      recover_after_seconds: 300,
      recovery_probe_after_seconds: 1800,
    };
    const rule = makeRule({
      type: RuleType.RELIABILITY_FAILOVER,
      customer_id: 'cust_A',
      config: cfg as unknown as Record<string, unknown>,
    });
    const preview = await previewRule(rule, NOW);

    const { sql, params } = captured[0]!;
    // Exactly one customer_id equality predicate, bound to the CONFIG value.
    expect(sql.match(/customer_id = \{/g) ?? []).toHaveLength(1);
    expect(params['failover_customer_id']).toBe('b1:cust_B');
    expect(params).not.toHaveProperty('customer_id');
    // ...so cust_B's rerouted traffic is surfaced, not zeroed out.
    expect(preview.total_event_count).toBe(300);
    expect(preview.affected_customers[0]).toMatchObject({ customer_id: 'cust_B' });
  });
});

describe('previewRule — non-pre-call types', () => {
  beforeEach(() => setupCanned({}));

  it('cost_threshold sets live_traffic_warning=false (alert-only)', async () => {
    const rule = makeRule({
      type: RuleType.COST_THRESHOLD,
      config: { threshold_usd: 100, period: 'month', scope: RuleScope.PER_CUSTOMER },
    });
    const preview = await previewRule(rule, NOW);
    expect(preview.live_traffic_warning).toBe(false);
    expect(preview.description).toContain('$100');
    expect(preview.description).toContain('month');
  });

  it('budget_limit sets live_traffic_warning=true (pre-call hard-stop)', async () => {
    const rule = makeRule({
      type: RuleType.BUDGET_LIMIT,
      config: { limit_usd: 50, period: 'day', hard_stop: true, scope: RuleScope.PER_CUSTOMER },
    });
    const preview = await previewRule(rule, NOW);
    expect(preview.live_traffic_warning).toBe(true);
    expect(preview.description).toContain('block at SDK pre-call');
  });

  it('margin_protection is alert-only (no live traffic impact)', async () => {
    const rule = makeRule({
      type: RuleType.MARGIN_PROTECTION,
      config: { margin_threshold_pct: 20, period: 'month', scope: RuleScope.PER_CUSTOMER },
    });
    const preview = await previewRule(rule, NOW);
    expect(preview.live_traffic_warning).toBe(false);
    expect(preview.description).toContain('20%');
  });
});

// F8 (B11): impact_pct = matched/total. The affected_customers list is a
// TOP_N=20 display sample — using its length as the numerator floored
// impact at 20/N for large builders, so the >=50% high-impact warning never
// fired for exactly the builders it exists for. matched_customers is the
// uncapped uniqExact over the rule's scoped window; total_customers is the
// builder-wide distinct count regardless of rule filters.
describe('previewRule — impact numerator/denominator (B11)', () => {
  function setupImpactMock(opts: { matched: number; total: number; sampleSize: number }): void {
    queryMock.mockReset();
    queryMock.mockImplementation((_builderId: string, sql: string) => {
      if (sql.includes('GROUP BY customer_id')) {
        return Promise.resolve(
          Array.from({ length: opts.sampleSize }, (_, i) => ({
            customer_id: `b1:cust_${i}`,
            event_count: '10',
            total_cost_usd: '1',
          })),
        );
      }
      if (sql.includes('GROUP BY step_name') || sql.includes('GROUP BY provider, model')) {
        return Promise.resolve([]);
      }
      if (sql.includes('AS matched_customers')) {
        return Promise.resolve([
          {
            total_event_count: '4200',
            total_cost_usd: '420',
            matched_customers: String(opts.matched),
          },
        ]);
      }
      if (sql.includes('AS total_customers')) {
        return Promise.resolve([{ total_customers: String(opts.total) }]);
      }
      throw new Error(`unexpected query: ${sql}`);
    });
  }

  it('reports the uncapped matched count for a global rule with more customers than the sample', async () => {
    setupImpactMock({ matched: 420, total: 420, sampleSize: 20 });
    const rule = makeRule({
      type: RuleType.BUDGET_LIMIT,
      config: { limit_usd: 5, period: 'day', hard_stop: true, scope: 'per_customer' },
    });

    const preview = await previewRule(rule, NOW);

    expect(preview.affected_customers).toHaveLength(20); // display sample stays capped
    expect(preview.matched_customers).toBe(420); // numerator is not
    // Global rule: no scope filter, so the denominator query is skipped and
    // matched IS the builder-wide total.
    expect(preview.total_customers).toBe(420);
    expect(queryMock).toHaveBeenCalledTimes(4);
  });

  it('computes the denominator over ALL builder traffic for a targeted rule', async () => {
    setupImpactMock({ matched: 1, total: 100, sampleSize: 1 });
    const rule = makeRule({
      type: RuleType.BUDGET_LIMIT,
      customer_id: 'cust_1',
      config: { limit_usd: 5, period: 'day', hard_stop: true, scope: 'per_customer' },
    });

    const preview = await previewRule(rule, NOW);

    expect(preview.matched_customers).toBe(1);
    expect(preview.total_customers).toBe(100);
    expect(queryMock).toHaveBeenCalledTimes(5);
    // The denominator query must NOT carry the rule's customer filter.
    const denominatorCall = queryMock.mock.calls.find(([, sql]) =>
      (sql as string).includes('AS total_customers'),
    );
    expect(denominatorCall?.[1]).not.toContain('customer_id = {customer_id:String}');
    expect(denominatorCall?.[2]).not.toHaveProperty('customer_id');
  });
});
