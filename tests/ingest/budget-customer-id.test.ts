import { beforeEach, describe, expect, it, vi } from 'vitest';
import { forShareTierTxExecuteImpl } from '../_helpers/drizzle-mock.js';
import {
  RuleEnforcement,
  RulePeriod,
  RuleScope,
  RuleStatus,
  RuleType,
  type BudgetSyncRequest,
  type Rule,
} from '@pylva/shared';

const mocks = vi.hoisted(() => ({
  aggregateSpendForRule: vi.fn(),
  calculateCostUsd: vi.fn(),
  deliverAlert: vi.fn(),
  filterDuplicates: vi.fn(),
  checkEventCap: vi.fn(),
  formatTierUsage: vi.fn(),
  getCapContext: vi.fn(),
  insertCostEventsWithRetry: vi.fn(),
  lookupPricing: vi.fn(),
  getRule: vi.fn(),
  listActiveRulesForCustomer: vi.fn(),
  listChannelsForRule: vi.fn(),
  publishFeedMessage: vi.fn(),
  recordAcceptedEvents: vi.fn(),
  recordSourceSighting: vi.fn(),
  freshTier: 'pro' as string | null,
  txExecute: vi.fn(),
  txInsert: vi.fn(),
  txInsertValues: vi.fn(),
  txOnConflictDoNothing: vi.fn(),
  undoFilterDuplicates: vi.fn(),
  withRLS: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock('../../src/lib/budget/aggregate.js', () => ({
  aggregateSpendForRule: mocks.aggregateSpendForRule,
}));

vi.mock('../../src/lib/config.js', () => ({
  env: { PUBLIC_SITE_URL: 'https://pylva.test' },
}));

vi.mock('../../src/lib/alerts/delivery.js', () => ({
  deliverAlert: mocks.deliverAlert,
}));

vi.mock('../../src/lib/cost-calculator.js', () => ({
  calculateCostUsd: mocks.calculateCostUsd,
}));

vi.mock('../../src/lib/clickhouse/events.js', () => ({
  insertCostEventsWithRetry: mocks.insertCostEventsWithRetry,
}));

vi.mock('../../src/lib/db/rls.js', () => ({
  withRLS: mocks.withRLS,
}));

vi.mock('../../src/lib/ingest/dedup.js', () => ({
  filterDuplicates: mocks.filterDuplicates,
  undoFilterDuplicates: mocks.undoFilterDuplicates,
}));

vi.mock('../../src/lib/ingest/event-cap.js', () => ({
  checkEventCap: mocks.checkEventCap,
  formatTierUsage: mocks.formatTierUsage,
  getCapContext: mocks.getCapContext,
  recordAcceptedEvents: mocks.recordAcceptedEvents,
}));

vi.mock('../../src/lib/ingest/last-seen-buffer.js', () => ({
  recordSourceSighting: mocks.recordSourceSighting,
}));

vi.mock('../../src/lib/ingest/onboarding.js', () => ({
  ensureOnboardingTask: vi.fn(),
}));

vi.mock('../../src/lib/ingest/pricing-lookup.js', () => ({
  lookupPricing: mocks.lookupPricing,
}));

vi.mock('../../src/lib/realtime/feed-publisher.js', () => ({
  publishFeedMessage: mocks.publishFeedMessage,
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({
      warn: mocks.logWarn,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

vi.mock('../../src/lib/rules/repository.js', () => ({
  // Ingest flags + post-call evaluation list per customer; budget sync
  // resolves entries by rule id (F3/B4).
  getRule: mocks.getRule,
  listActiveRulesForCustomer: mocks.listActiveRulesForCustomer,
  listAlertChannelEntriesForRule: mocks.listChannelsForRule,
  markRuleTriggered: vi.fn(async () => undefined),
}));

function budgetRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 'rule-1',
    builder_id: 'builder-a',
    type: RuleType.BUDGET_LIMIT,
    enforcement: RuleEnforcement.POST_CALL,
    name: 'Budget',
    enabled: true,
    config: {
      limit_usd: 10,
      period: RulePeriod.DAY,
      scope: RuleScope.PER_CUSTOMER,
    },
    customer_id: 'alice',
    status: RuleStatus.ACTIVE,
    activated_at: null,
    last_triggered_at: null,
    last_error: null,
    created_at: new Date('2026-06-04T00:00:00.000Z'),
    updated_at: new Date('2026-06-04T00:00:00.000Z'),
    ...overrides,
  };
}

function ingestEvent(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: '1.6',
    run_id: '00000000-0000-4000-8000-000000000010',
    parent_run_id: null,
    trace_id: '00000000-0000-4000-8000-000000000011',
    span_id: '00000000-0000-4000-8000-000000000002',
    parent_span_id: null,
    customer_id: 'alice',
    step_name: null,
    model: 'gpt-test',
    provider: 'other',
    tokens_in: 1,
    tokens_out: 1,
    latency_ms: 10,
    tool_name: null,
    status: 'success',
    framework: 'none',
    instrumentation_tier: 'sdk_wrapper',
    cost_source: 'configured',
    metric: null,
    metric_value: null,
    stream_aborted: false,
    abort_savings_usd: 0,
    sdk_version: '1.0.0',
    timestamp: '2026-06-04T12:00:00.000Z',
    ...overrides,
  };
}

describe('budget customer_id boundaries', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.aggregateSpendForRule.mockResolvedValue(12);
    mocks.calculateCostUsd.mockReturnValue({
      cost_usd: 12,
      pricing_status: 'priced',
      cost_source: 'configured',
    });
    mocks.deliverAlert.mockResolvedValue({ ok: true, attempts: 1 });
    mocks.filterDuplicates.mockResolvedValue(new Set(['00000000-0000-4000-8000-000000000002']));
    mocks.checkEventCap.mockResolvedValue({
      enabled: true,
      blocked: false,
      tier: 'pro',
      cap: 1_000_000,
      used: 0,
      window: {
        start: new Date('2026-06-01T00:00:00.000Z'),
        end: new Date('2026-07-01T00:00:00.000Z'),
        source: 'calendar_month',
      },
    });
    mocks.formatTierUsage.mockImplementation((used: number, cap: number) => `${used}/${cap}`);
    mocks.getCapContext.mockResolvedValue({ tier: 'pro' });
    mocks.insertCostEventsWithRetry.mockResolvedValue(undefined);
    mocks.lookupPricing.mockResolvedValue({
      llm: new Map(),
      metric: new Map(),
    });
    mocks.getRule.mockResolvedValue(budgetRule());
    mocks.listActiveRulesForCustomer.mockResolvedValue([budgetRule()]);
    mocks.listChannelsForRule.mockResolvedValue([]);
    mocks.publishFeedMessage.mockResolvedValue(undefined);
    mocks.recordAcceptedEvents.mockImplementation(
      async (_builderId: string, decision: { used: number | null }, count: number) =>
        decision.used === null ? null : decision.used + count,
    );
    mocks.recordSourceSighting.mockResolvedValue(undefined);
    mocks.freshTier = 'pro';
    mocks.txExecute.mockImplementation(forShareTierTxExecuteImpl(() => mocks.freshTier));
    mocks.txOnConflictDoNothing.mockResolvedValue(undefined);
    mocks.txInsertValues.mockReturnValue({ onConflictDoNothing: mocks.txOnConflictDoNothing });
    mocks.txInsert.mockReturnValue({ values: mocks.txInsertValues });
    mocks.undoFilterDuplicates.mockResolvedValue(undefined);
    mocks.withRLS.mockImplementation(
      async (_builderId: string, fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          execute: mocks.txExecute,
          insert: mocks.txInsert,
          select: (selection: Record<string, unknown>) => ({
            from: () => ({
              where: () =>
                Promise.resolve(
                  Object.prototype.hasOwnProperty.call(selection, 'count') ? [{ count: 0 }] : [],
                ),
            }),
          }),
        }),
    );
    const { _resetPostCallEvalForTests } = await import('../../src/lib/rules/post-call-evaluator');
    _resetPostCallEvalForTests();
  });

  it('persists an overflow-priced event as needs_input and still persists the rest of the batch', async () => {
    const overflowSpan = '00000000-0000-4000-8000-000000000020';
    const normalSpan = '00000000-0000-4000-8000-000000000021';
    const timestamp = '2026-06-04T12:00:00.000Z';
    mocks.filterDuplicates.mockResolvedValue(new Set([overflowSpan, normalSpan]));
    mocks.calculateCostUsd
      .mockReturnValueOnce({
        cost_usd: null,
        pricing_status: 'needs_input',
      })
      .mockReturnValueOnce({
        cost_usd: 1,
        pricing_status: 'priced',
      });

    const { handleTelemetryIngest } = await import('../../src/lib/ingest/public-handler');
    const response = await handleTelemetryIngest({
      builderId: 'builder-a',
      keyId: 'key-a',
      rawBody: JSON.stringify({
        batch_id: '00000000-0000-4000-8000-000000000001',
        sdk_version: '1.0.0',
        events: [
          ingestEvent({ span_id: overflowSpan, timestamp }),
          ingestEvent({ span_id: normalSpan, timestamp }),
        ],
      }),
    });
    const body = JSON.parse(response.body) as {
      accepted: number;
      rejected: number;
      warnings?: Array<{ event_index: number; code: string }>;
    };

    expect(response.status).toBe(200);
    expect(body.accepted).toBe(2);
    expect(body.rejected).toBe(0);
    expect(body.warnings?.[0]).toMatchObject({
      event_index: 0,
      code: 'needs_pricing_input',
    });
    expect(mocks.insertCostEventsWithRetry).toHaveBeenCalledTimes(1);
    expect(mocks.insertCostEventsWithRetry.mock.calls[0]?.[0]).toHaveLength(2);
    expect(mocks.insertCostEventsWithRetry.mock.calls[0]?.[0][0]).toMatchObject({
      span_id: overflowSpan,
      cost_usd: null,
      pricing_status: 'needs_input',
    });
    expect(mocks.insertCostEventsWithRetry.mock.calls[0]?.[0][1]).toMatchObject({
      span_id: normalSpan,
      cost_usd: 1,
      pricing_status: 'priced',
    });
    expect(mocks.undoFilterDuplicates).not.toHaveBeenCalled();
  });

  it('auto-discovers distinct telemetry customers after accepting ClickHouse rows', async () => {
    const spanA = '00000000-0000-4000-8000-000000000030';
    const spanB = '00000000-0000-4000-8000-000000000031';
    const spanDupeCustomer = '00000000-0000-4000-8000-000000000032';
    mocks.filterDuplicates.mockResolvedValue(new Set([spanA, spanB, spanDupeCustomer]));

    const { handleTelemetryIngest } = await import('../../src/lib/ingest/public-handler');
    const response = await handleTelemetryIngest({
      builderId: 'builder-a',
      keyId: 'key-a',
      rawBody: JSON.stringify({
        batch_id: '00000000-0000-4000-8000-000000000001',
        sdk_version: '1.0.0',
        events: [
          ingestEvent({ span_id: spanA, customer_id: 'alice' }),
          ingestEvent({ span_id: spanB, customer_id: 'bob' }),
          ingestEvent({ span_id: spanDupeCustomer, customer_id: 'alice' }),
        ],
      }),
    });

    const insertOrder = mocks.insertCostEventsWithRetry.mock.invocationCallOrder[0] ?? 0;
    const upsertOrder = mocks.txInsert.mock.invocationCallOrder[0] ?? 0;

    expect(response.status).toBe(200);
    expect(mocks.insertCostEventsWithRetry).toHaveBeenCalledTimes(1);
    expect(upsertOrder).toBeGreaterThan(insertOrder);
    expect(mocks.txInsertValues).toHaveBeenCalledWith([
      { builder_id: 'builder-a', external_id: 'alice' },
      { builder_id: 'builder-a', external_id: 'bob' },
    ]);
    expect(mocks.txOnConflictDoNothing).toHaveBeenCalledTimes(1);
    expect(mocks.undoFilterDuplicates).not.toHaveBeenCalled();
  });

  it('waits for customer auto-registration before returning success', async () => {
    let finishRegistration!: () => void;
    const registration = new Promise<void>((resolve) => {
      finishRegistration = resolve;
    });
    mocks.txOnConflictDoNothing.mockReturnValueOnce(registration);

    const { handleTelemetryIngest } = await import('../../src/lib/ingest/public-handler');
    let responseSettled = false;
    const responsePromise = handleTelemetryIngest({
      builderId: 'builder-a',
      keyId: 'key-a',
      rawBody: JSON.stringify({
        batch_id: '00000000-0000-4000-8000-000000000001',
        sdk_version: '1.0.0',
        events: [ingestEvent()],
      }),
    }).then((response) => {
      responseSettled = true;
      return response;
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(mocks.insertCostEventsWithRetry).toHaveBeenCalledTimes(1);
    expect(mocks.txInsertValues).toHaveBeenCalledWith([
      { builder_id: 'builder-a', external_id: 'alice' },
    ]);
    expect(responseSettled).toBe(false);

    finishRegistration();
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(mocks.undoFilterDuplicates).not.toHaveBeenCalled();
  });

  it('keeps successful telemetry ingest nonfatal when customer auto-registration fails', async () => {
    mocks.txOnConflictDoNothing.mockRejectedValueOnce(new Error('postgres unavailable'));

    const { handleTelemetryIngest } = await import('../../src/lib/ingest/public-handler');
    const response = await handleTelemetryIngest({
      builderId: 'builder-a',
      keyId: 'key-a',
      rawBody: JSON.stringify({
        batch_id: '00000000-0000-4000-8000-000000000001',
        sdk_version: '1.0.0',
        events: [ingestEvent()],
      }),
    });
    const body = JSON.parse(response.body) as { accepted: number; rejected: number };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ accepted: 1, rejected: 0 });
    expect(mocks.insertCostEventsWithRetry).toHaveBeenCalledTimes(1);
    expect(mocks.undoFilterDuplicates).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ failed_count: 1 }),
      'customer auto-registration failed after ingest persistence',
    );
  });

  it('ingest budget flags use external id for PG, composite id for ClickHouse, and external id in response', async () => {
    const { handleTelemetryIngest } = await import('../../src/lib/ingest/public-handler');
    const rawBody = JSON.stringify({
      batch_id: '00000000-0000-4000-8000-000000000001',
      sdk_version: '1.0.0',
      events: [
        {
          schema_version: '1.6',
          run_id: '00000000-0000-4000-8000-000000000010',
          parent_run_id: null,
          trace_id: '00000000-0000-4000-8000-000000000011',
          span_id: '00000000-0000-4000-8000-000000000002',
          parent_span_id: null,
          customer_id: 'alice',
          step_name: null,
          model: 'gpt-test',
          provider: 'other',
          tokens_in: 1,
          tokens_out: 1,
          latency_ms: 10,
          tool_name: null,
          status: 'success',
          framework: 'none',
          instrumentation_tier: 'sdk_wrapper',
          cost_source: 'configured',
          metric: null,
          metric_value: null,
          stream_aborted: false,
          abort_savings_usd: 0,
          sdk_version: '1.0.0',
          timestamp: '2026-06-04T12:00:00.000Z',
        },
      ],
    });

    const response = await handleTelemetryIngest({
      builderId: 'builder-a',
      keyId: 'key-a',
      rawBody,
    });
    const body = JSON.parse(response.body) as {
      budget_exceeded?: Array<{
        customer_id: string | null;
        accumulated_usd: number;
      }>;
    };

    expect(response.status).toBe(200);
    expect(mocks.insertCostEventsWithRetry.mock.calls[0]?.[0][0].customer_id).toBe(
      'builder-a:alice',
    );
    expect(mocks.listActiveRulesForCustomer).toHaveBeenCalledWith('builder-a', 'alice');
    expect(mocks.aggregateSpendForRule).toHaveBeenCalledWith(
      'builder-a',
      expect.objectContaining({ id: 'rule-1' }),
      'builder-a:alice',
    );
    expect(body.budget_exceeded?.[0]).toMatchObject({
      customer_id: 'alice',
      accumulated_usd: 12,
    });
  });

  it('post-call evaluation uses external id for PG and payloads, composite id for ClickHouse', async () => {
    const { evaluatePostCall } = await import('../../src/lib/rules/post-call-evaluator');

    await evaluatePostCall('builder-a', [
      {
        customer_id: 'builder-a:alice',
        cost_usd: 12,
        timestamp: '2026-06-04T12:00:00.000Z',
      },
    ]);

    expect(mocks.listActiveRulesForCustomer).toHaveBeenCalledWith('builder-a', 'alice');
    expect(mocks.aggregateSpendForRule).toHaveBeenCalledWith(
      'builder-a',
      expect.objectContaining({ id: 'rule-1' }),
      'builder-a:alice',
    );
    expect(mocks.deliverAlert.mock.calls[0]?.[0].payload.payload.data.customer_id).toBe('alice');
  });

  it('post-call pooled rules aggregate with null customer id', async () => {
    mocks.listActiveRulesForCustomer.mockResolvedValueOnce([
      budgetRule({
        customer_id: null,
        config: {
          limit_usd: 10,
          period: RulePeriod.DAY,
          scope: RuleScope.POOLED,
        },
      }),
    ]);
    const { evaluatePostCall } = await import('../../src/lib/rules/post-call-evaluator');

    await evaluatePostCall('builder-a', [
      {
        customer_id: 'builder-a:alice',
        cost_usd: 12,
        timestamp: '2026-06-04T12:00:00.000Z',
      },
    ]);

    expect(mocks.aggregateSpendForRule).toHaveBeenCalledWith(
      'builder-a',
      expect.objectContaining({ id: 'rule-1' }),
      null,
    );
    expect(mocks.deliverAlert.mock.calls[0]?.[0].payload.payload.data.customer_id).toBeNull();
  });

  it('budget sync sends external id to PG and composite id to ClickHouse', async () => {
    const { reconcileBudgetSync } = await import('../../src/lib/budget/sync-handler');
    const entries: BudgetSyncRequest[] = [
      {
        rule_id: 'rule-1',
        scope: RuleScope.PER_CUSTOMER,
        customer_id: 'alice',
        accumulated_cost_usd: 3,
        period_start: '2026-06-04T00:00:00.000Z',
        event_count: 1,
      },
    ];

    const result = await reconcileBudgetSync('builder-a', entries);

    expect(mocks.getRule).toHaveBeenCalledWith('builder-a', 'rule-1');
    expect(mocks.aggregateSpendForRule).toHaveBeenCalledWith(
      'builder-a',
      expect.objectContaining({ id: 'rule-1' }),
      'builder-a:alice',
      {
        from: new Date('2026-06-04T00:00:00.000Z'),
        to: new Date('2026-06-05T00:00:00.000Z'),
      },
    );
    expect(result[0]?.customer_id).toBe('alice');
    expect(result[0]?.period_start).toBe('2026-06-04T00:00:00.000Z');
    expect(result[0]?.server_total_usd).toBe(12);
  });

  it('budget sync normalizes composite input but keeps pooled aggregate unscoped', async () => {
    mocks.getRule.mockResolvedValueOnce(
      budgetRule({
        customer_id: null,
        config: {
          limit_usd: 10,
          period: RulePeriod.DAY,
          scope: RuleScope.POOLED,
        },
      }),
    );
    const { reconcileBudgetSync } = await import('../../src/lib/budget/sync-handler');

    await reconcileBudgetSync('builder-a', [
      {
        rule_id: 'rule-1',
        scope: RuleScope.POOLED,
        customer_id: 'builder-a:alice',
        accumulated_cost_usd: 3,
        period_start: '2026-06-04T00:00:00.000Z',
        event_count: 1,
      },
    ]);

    expect(mocks.getRule).toHaveBeenCalledWith('builder-a', 'rule-1');
    expect(mocks.aggregateSpendForRule).toHaveBeenCalledWith(
      'builder-a',
      expect.objectContaining({ id: 'rule-1' }),
      null,
      {
        from: new Date('2026-06-04T00:00:00.000Z'),
        to: new Date('2026-06-05T00:00:00.000Z'),
      },
    );
  });

  it('budget sync uses the resolved rule scope instead of client-supplied scope', async () => {
    mocks.getRule.mockResolvedValueOnce(
      budgetRule({
        customer_id: null,
        config: {
          limit_usd: 10,
          period: RulePeriod.DAY,
          scope: RuleScope.POOLED,
        },
      }),
    );
    const { reconcileBudgetSync } = await import('../../src/lib/budget/sync-handler');

    await reconcileBudgetSync('builder-a', [
      {
        rule_id: 'rule-1',
        scope: RuleScope.PER_CUSTOMER,
        customer_id: 'alice',
        accumulated_cost_usd: 3,
        period_start: '2026-06-04T00:00:00.000Z',
        event_count: 1,
      },
    ]);

    expect(mocks.getRule).toHaveBeenCalledWith('builder-a', 'rule-1');
    expect(mocks.aggregateSpendForRule).toHaveBeenCalledWith(
      'builder-a',
      expect.objectContaining({ id: 'rule-1' }),
      null,
      {
        from: new Date('2026-06-04T00:00:00.000Z'),
        to: new Date('2026-06-05T00:00:00.000Z'),
      },
    );
  });
});
