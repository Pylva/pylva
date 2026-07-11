// B4-4c — margin_protection evaluation. Pins the pieces the feature is
// made of: audience resolution (targeted / global per_customer / pooled),
// revenue-vs-cost math via the invoice formula, severity (WARN, ERROR when
// negative), internal↔external↔composite id bridging, MARGIN_RISK anomaly
// persistence, margin.alert dispatch through the rule's own channels,
// durable alert_history dedup, insufficient_revenue_data_treatment
// ('skip' default; 'alert' emits ONE summary per rule per period), and
// last_triggered_at stamping.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AnomalyRecommendationAction,
  AnomalySeverity,
  AnomalySourceType,
  RuleEnforcement,
  RulePeriod,
  RuleScope,
  RuleStatus,
  RuleType,
  type Rule,
} from '@pylva/shared';

const mocks = vi.hoisted(() => ({
  aggregateSpendForRule: vi.fn(),
  applyFormula: vi.fn(),
  countCustomers: vi.fn(),
  deliverAlert: vi.fn(),
  fetchPeriodAggregates: vi.fn(),
  getActiveVersion: vi.fn(),
  getUsageForPeriod: vi.fn(),
  insertAnomalyEvent: vi.fn(),
  listAlertChannelEntriesForRule: vi.fn(),
  listCustomersWithOpenPricing: vi.fn(),
  listRules: vi.fn(),
  markRuleTriggered: vi.fn(),
  recommendFromDiagnosis: vi.fn(),
  // Rows returned by the fake alert_history dedup query.
  alertHistoryRows: [] as Array<{ id: string }>,
}));

vi.mock('../../src/lib/rules/repository.js', () => ({
  listRules: mocks.listRules,
  listAlertChannelEntriesForRule: mocks.listAlertChannelEntriesForRule,
  markRuleTriggered: mocks.markRuleTriggered,
}));

vi.mock('../../src/lib/customers/lookup.js', () => ({
  countCustomers: mocks.countCustomers,
  listCustomersWithOpenPricing: mocks.listCustomersWithOpenPricing,
}));

vi.mock('../../src/lib/billing/pricing-versioning.js', () => ({
  getActiveVersion: mocks.getActiveVersion,
  rowToCustomerPricing: (row: unknown) => row,
}));

vi.mock('../../src/lib/billing/clickhouse-usage.js', () => ({
  getUsageForPeriod: mocks.getUsageForPeriod,
}));

vi.mock('../../src/lib/billing/formulas.js', () => ({
  applyFormula: mocks.applyFormula,
}));

vi.mock('../../src/lib/budget/aggregate.js', () => ({
  aggregateSpendForRule: mocks.aggregateSpendForRule,
}));

vi.mock('../../src/lib/anomaly/repository.js', () => ({
  insertAnomalyEvent: mocks.insertAnomalyEvent,
}));

vi.mock('../../src/lib/anomaly/clickhouse-queries.js', () => ({
  fetchPeriodAggregates: mocks.fetchPeriodAggregates,
}));

vi.mock('../../src/lib/alerts/delivery.js', () => ({
  deliverAlert: mocks.deliverAlert,
}));

vi.mock('../../src/lib/rules/recommendations.js', () => ({
  recommendFromDiagnosis: mocks.recommendFromDiagnosis,
}));

// hasAlertedThisPeriod runs a drizzle select through withRLS; emulate just
// the chain it uses and let tests control the returned rows.
vi.mock('../../src/lib/db/rls.js', () => ({
  withRLS: async (_builderId: string, cb: (tx: unknown) => Promise<unknown>) =>
    cb({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => mocks.alertHistoryRows,
          }),
        }),
      }),
    }),
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const { evaluateMarginRules, marginPct } = await import('../../src/lib/rules/margin-evaluator.js');

const BUILDER = 'builder-a';
const NOW = new Date('2026-06-10T12:30:00.000Z');
const CATALOG = { tiers: [] } as never;

const ALICE = { id: 'uuid-alice', external_id: 'alice' };
const BOB = { id: 'uuid-bob', external_id: 'bob' };

function marginRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 'rule-margin',
    builder_id: BUILDER,
    type: RuleType.MARGIN_PROTECTION,
    enforcement: RuleEnforcement.POST_CALL,
    name: 'Margin guard',
    enabled: true,
    config: { margin_threshold_pct: 20, period: RulePeriod.DAY, scope: RuleScope.PER_CUSTOMER },
    customer_id: null,
    status: RuleStatus.ACTIVE,
    activated_at: null,
    last_triggered_at: null,
    last_error: null,
    created_at: new Date('2026-06-01T00:00:00.000Z'),
    updated_at: new Date('2026-06-01T00:00:00.000Z'),
    ...overrides,
  };
}

const EMPTY_SLICES = { steps: [], models: [], sources: [] };

function aggregatesWith(models: Array<{ provider: string; model: string; cost_usd: number }>) {
  return {
    total_cost_usd: models.reduce((s, m) => s + m.cost_usd, 0),
    total_tokens_in: 0,
    total_tokens_out: 0,
    all: { steps: [], models, sources: [] },
    byCustomer: new Map([
      [`${BUILDER}:alice`, { steps: [], models, sources: [] }],
      [`${BUILDER}:bob`, EMPTY_SLICES],
    ]),
    costByCustomer: new Map(),
  };
}

/** revenue/cost per external customer id, applied to the shared mocks. */
function primeMeasurements(perCustomer: Record<string, { revenue: number; cost: number }>) {
  mocks.getActiveVersion.mockImplementation(async ({ customerId }: { customerId: string }) => ({
    pricing_row_for: customerId,
  }));
  mocks.getUsageForPeriod.mockImplementation(async ({ customerId }: { customerId: string }) => ({
    composite: customerId,
  }));
  mocks.applyFormula.mockImplementation((_pricing: unknown, usage: { composite: string }) => ({
    amount_usd: perCustomer[usage.composite.split(':')[1]!]?.revenue ?? 0,
    line_items: [],
    has_unpriced_events: false,
  }));
  mocks.aggregateSpendForRule.mockImplementation(
    async (_b: string, _rule: Rule, composite: string | null) =>
      composite === null ? 0 : (perCustomer[composite.split(':')[1]!]?.cost ?? 0),
  );
}

describe('evaluateMarginRules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.alertHistoryRows = [];
    mocks.listRules.mockResolvedValue([marginRule()]);
    mocks.listCustomersWithOpenPricing.mockResolvedValue([ALICE, BOB]);
    mocks.countCustomers.mockResolvedValue(2);
    mocks.listAlertChannelEntriesForRule.mockResolvedValue([]);
    mocks.deliverAlert.mockResolvedValue(undefined);
    mocks.markRuleTriggered.mockResolvedValue(undefined);
    mocks.fetchPeriodAggregates.mockResolvedValue(
      aggregatesWith([{ provider: 'openai', model: 'gpt-4o', cost_usd: 90 }]),
    );
    mocks.recommendFromDiagnosis.mockReturnValue({
      action: AnomalyRecommendationAction.INVESTIGATE_DEEP_LINK,
    });
    mocks.insertAnomalyEvent.mockImplementation(async (input: Record<string, unknown>) => ({
      id: 'anomaly-1',
      status: 'open',
      created_at: NOW,
      updated_at: NOW,
      ...input,
    }));
    primeMeasurements({
      alice: { revenue: 100, cost: 90 }, // margin 10% < 20% threshold
      bob: { revenue: 100, cost: 10 }, // margin 90% — healthy
    });
  });

  it('computes margin as (revenue - cost) / revenue', () => {
    expect(marginPct(100, 90)).toBeCloseTo(10);
    expect(marginPct(100, 150)).toBeCloseTo(-50);
  });

  it('fires for exactly the low-margin customer on a global per_customer rule', async () => {
    const summary = await evaluateMarginRules({ builderId: BUILDER, catalog: CATALOG, now: NOW });

    expect(summary.rules_evaluated).toBe(1);
    expect(summary.anomalies_inserted).toBe(1);
    expect(summary.alerts_fired).toBe(1);

    expect(mocks.insertAnomalyEvent).toHaveBeenCalledTimes(1);
    expect(mocks.insertAnomalyEvent.mock.calls[0]?.[0]).toMatchObject({
      builder_id: BUILDER,
      customer_id: 'alice',
      source_type: AnomalySourceType.MARGIN_RISK,
      severity: AnomalySeverity.WARN,
      actual_value: 10,
      baseline_value: 20,
    });
    // period window is the rule's UTC day.
    expect(mocks.insertAnomalyEvent.mock.calls[0]?.[0].period_start).toEqual(
      new Date('2026-06-10T00:00:00.000Z'),
    );
    expect(mocks.insertAnomalyEvent.mock.calls[0]?.[0].period_end).toEqual(
      new Date('2026-06-11T00:00:00.000Z'),
    );
    expect(mocks.markRuleTriggered).toHaveBeenCalledWith(BUILDER, 'rule-margin');
  });

  it('emits the contract-shaped margin.alert through the rule channels', async () => {
    const channel = { id: 'ch-1', rule_id: 'rule-margin', channel: 'webhook', enabled: true };
    mocks.listAlertChannelEntriesForRule.mockResolvedValue([channel]);

    await evaluateMarginRules({ builderId: BUILDER, catalog: CATALOG, now: NOW });

    expect(mocks.deliverAlert).toHaveBeenCalledTimes(1);
    const dispatched = mocks.deliverAlert.mock.calls[0]?.[0];
    expect(dispatched.channels).toEqual([channel]);
    expect(dispatched.rule_id).toBe('rule-margin');
    // Wire shape pinned by tests/contracts/alerts-contract.json (margin.alert).
    expect(dispatched.payload.payload).toMatchObject({
      type: 'margin.alert',
      builder_id: BUILDER,
      data: {
        customer_id: 'alice',
        margin_percent: 10,
        threshold_percent: 20,
        diagnosis: { top_drivers: [{ label: 'openai/gpt-4o', cost_usd: 90 }] },
      },
    });
  });

  it('bridges ids correctly: internal for pricing, composite for ClickHouse, external for rows', async () => {
    await evaluateMarginRules({ builderId: BUILDER, catalog: CATALOG, now: NOW });

    expect(mocks.getActiveVersion).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: 'uuid-alice' }),
    );
    expect(mocks.getUsageForPeriod).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: 'builder-a:alice' }),
    );
    expect(mocks.aggregateSpendForRule).toHaveBeenCalledWith(
      BUILDER,
      expect.objectContaining({ id: 'rule-margin' }),
      'builder-a:alice',
      expect.anything(),
    );
    expect(mocks.insertAnomalyEvent.mock.calls[0]?.[0].customer_id).toBe('alice');
  });

  it('escalates to ERROR severity when margin is negative', async () => {
    primeMeasurements({
      alice: { revenue: 100, cost: 150 }, // margin -50%
      bob: { revenue: 100, cost: 10 },
    });

    await evaluateMarginRules({ builderId: BUILDER, catalog: CATALOG, now: NOW });

    expect(mocks.insertAnomalyEvent.mock.calls[0]?.[0]).toMatchObject({
      customer_id: 'alice',
      severity: AnomalySeverity.ERROR,
      actual_value: -50,
    });
  });

  it('evaluates only the targeted customer for a targeted rule', async () => {
    mocks.listRules.mockResolvedValue([marginRule({ customer_id: 'bob' })]);

    const summary = await evaluateMarginRules({ builderId: BUILDER, catalog: CATALOG, now: NOW });

    expect(mocks.getUsageForPeriod).toHaveBeenCalledTimes(1);
    expect(mocks.getUsageForPeriod).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: 'builder-a:bob' }),
    );
    // bob is healthy — nothing fires.
    expect(summary.alerts_fired).toBe(0);
    expect(mocks.insertAnomalyEvent).not.toHaveBeenCalled();
  });

  it('evaluates customers beyond the first 500 in a global rule audience', async () => {
    const audience = Array.from({ length: 501 }, (_, index) => ({
      id: `uuid-${index}`,
      external_id: `customer-${index.toString().padStart(3, '0')}`,
    }));
    mocks.listCustomersWithOpenPricing.mockResolvedValue(audience);
    primeMeasurements(
      Object.fromEntries(
        audience.map((customer, index) => [
          customer.external_id,
          { revenue: 100, cost: index === 500 ? 90 : 10 },
        ]),
      ),
    );

    const summary = await evaluateMarginRules({ builderId: BUILDER, catalog: CATALOG, now: NOW });

    expect(mocks.getUsageForPeriod).toHaveBeenCalledTimes(501);
    expect(summary.alerts_fired).toBe(1);
    expect(mocks.insertAnomalyEvent).toHaveBeenCalledWith(
      expect.objectContaining({ customer_id: 'customer-500' }),
    );
  });

  it('aggregates cost+revenue across the audience for pooled scope', async () => {
    mocks.listRules.mockResolvedValue([
      marginRule({
        config: {
          margin_threshold_pct: 60,
          period: RulePeriod.DAY,
          scope: RuleScope.POOLED,
        },
      }),
    ]);
    // Pool: revenue 200, cost 100 → margin 50% < 60% → one pooled fire.
    primeMeasurements({
      alice: { revenue: 100, cost: 90 },
      bob: { revenue: 100, cost: 10 },
    });

    const summary = await evaluateMarginRules({ builderId: BUILDER, catalog: CATALOG, now: NOW });

    expect(summary.alerts_fired).toBe(1);
    expect(mocks.insertAnomalyEvent).toHaveBeenCalledTimes(1);
    expect(mocks.insertAnomalyEvent.mock.calls[0]?.[0]).toMatchObject({
      customer_id: null,
      actual_value: 50,
    });
    const payload = mocks.deliverAlert.mock.calls[0]?.[0].payload.payload;
    expect(payload.data.customer_id).toBeNull();
  });

  it('skips dispatch (but not the anomaly row) when alert_history already has this period', async () => {
    mocks.alertHistoryRows = [{ id: 'previous-alert' }];

    const summary = await evaluateMarginRules({ builderId: BUILDER, catalog: CATALOG, now: NOW });

    expect(mocks.insertAnomalyEvent).toHaveBeenCalledTimes(1);
    expect(mocks.deliverAlert).not.toHaveBeenCalled();
    expect(mocks.markRuleTriggered).not.toHaveBeenCalled();
    expect(summary.alerts_fired).toBe(0);
  });

  it('counts idempotent anomaly skips separately', async () => {
    mocks.insertAnomalyEvent.mockResolvedValue(null);

    const summary = await evaluateMarginRules({ builderId: BUILDER, catalog: CATALOG, now: NOW });

    expect(summary.anomalies_inserted).toBe(0);
    expect(summary.anomalies_skipped_idempotent).toBe(1);
  });

  it("silently counts zero-revenue customers under the default 'skip' treatment", async () => {
    primeMeasurements({
      alice: { revenue: 0, cost: 90 }, // no computable margin
      bob: { revenue: 100, cost: 10 },
    });

    const summary = await evaluateMarginRules({ builderId: BUILDER, catalog: CATALOG, now: NOW });

    expect(summary.customers_skipped_insufficient_revenue).toBe(1);
    expect(mocks.insertAnomalyEvent).not.toHaveBeenCalled();
    expect(mocks.deliverAlert).not.toHaveBeenCalled();
  });

  it("emits ONE summary per rule per period under the 'alert' treatment", async () => {
    mocks.listRules.mockResolvedValue([
      marginRule({
        config: {
          margin_threshold_pct: 20,
          period: RulePeriod.DAY,
          scope: RuleScope.PER_CUSTOMER,
          insufficient_revenue_data_treatment: 'alert',
        },
      }),
    ]);
    // 2 priced customers, alice zero revenue; 3 more customers with no
    // pricing at all (countCustomers 5 − audience 2).
    mocks.countCustomers.mockResolvedValue(5);
    primeMeasurements({
      alice: { revenue: 0, cost: 90 },
      bob: { revenue: 100, cost: 10 },
    });

    const summary = await evaluateMarginRules({ builderId: BUILDER, catalog: CATALOG, now: NOW });

    // One summary anomaly (customer null) — never one per unpriced customer.
    expect(mocks.insertAnomalyEvent).toHaveBeenCalledTimes(1);
    const row = mocks.insertAnomalyEvent.mock.calls[0]?.[0];
    expect(row).toMatchObject({
      customer_id: null,
      source_type: AnomalySourceType.MARGIN_RISK,
      severity: AnomalySeverity.WARN,
      actual_value: null,
    });
    expect(row.diagnosis.insufficient_revenue_data).toBe(true);
    expect(row.diagnosis.notes?.[0]).toContain('4 of 5');
    // Dispatched as anomaly.detected — margin.alert requires a real margin.
    expect(mocks.deliverAlert).toHaveBeenCalledTimes(1);
    expect(mocks.deliverAlert.mock.calls[0]?.[0].payload.payload.type).toBe('anomaly.detected');
    expect(summary.customers_skipped_insufficient_revenue).toBe(4);
  });

  it('isolates one customer measurement failure from the rest of the audience', async () => {
    mocks.getUsageForPeriod.mockImplementation(async ({ customerId }: { customerId: string }) => {
      if (customerId === 'builder-a:alice') throw new Error('clickhouse hiccup');
      return { composite: customerId };
    });

    const summary = await evaluateMarginRules({ builderId: BUILDER, catalog: CATALOG, now: NOW });

    // alice unmeasurable (counted), bob healthy — no fires, no throw.
    expect(summary.rules_evaluated).toBe(1);
    expect(summary.customers_skipped_insufficient_revenue).toBe(1);
    expect(mocks.deliverAlert).not.toHaveBeenCalled();
  });

  it('ignores drafts, disabled rules, other types, and malformed configs', async () => {
    mocks.listRules.mockResolvedValue([
      marginRule({ id: 'r-draft', status: RuleStatus.DRAFT }),
      marginRule({ id: 'r-disabled', enabled: false }),
      marginRule({ id: 'r-budget', type: RuleType.BUDGET_LIMIT }),
      marginRule({ id: 'r-malformed', config: { period: 'day' } }),
    ]);

    const summary = await evaluateMarginRules({ builderId: BUILDER, catalog: CATALOG, now: NOW });

    expect(summary.rules_evaluated).toBe(0);
    expect(mocks.getUsageForPeriod).not.toHaveBeenCalled();
    expect(mocks.deliverAlert).not.toHaveBeenCalled();
  });

  it('does nothing (and skips the pricing query) when no margin rules exist', async () => {
    mocks.listRules.mockResolvedValue([marginRule({ type: RuleType.BUDGET_LIMIT })]);

    const summary = await evaluateMarginRules({ builderId: BUILDER, catalog: CATALOG, now: NOW });

    expect(summary.rules_evaluated).toBe(0);
    expect(mocks.listCustomersWithOpenPricing).not.toHaveBeenCalled();
  });
});
