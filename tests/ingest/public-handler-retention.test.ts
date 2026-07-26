import { beforeEach, describe, expect, it, vi } from 'vitest';
import { forShareEntitlementTxExecuteImpl } from '../_helpers/drizzle-mock.js';

const mocks = vi.hoisted(() => ({
  aggregateSpendForRule: vi.fn(),
  calculateCostUsd: vi.fn(),
  evaluatePostCall: vi.fn(),
  filterDuplicates: vi.fn(),
  checkEventCap: vi.fn(),
  formatTierUsage: vi.fn(),
  insertCostEventsWithRetry: vi.fn(),
  lookupPricing: vi.fn(),
  listActiveRulesForCustomer: vi.fn(),
  publishFeedMessage: vi.fn(),
  recordAcceptedEvents: vi.fn(),
  recordSourceSighting: vi.fn(),
  freshTier: 'pro' as string | null,
  freshAccessState: 'active' as string | null,
  freshEntitlementSource: 'admin' as string | null,
  txExecute: vi.fn(),
  txInsert: vi.fn(),
  txInsertValues: vi.fn(),
  txOnConflictDoNothing: vi.fn(),
  undoFilterDuplicates: vi.fn(),
  withRLS: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('../../src/lib/budget/aggregate.js', () => ({
  aggregateSpendForRule: mocks.aggregateSpendForRule,
}));

vi.mock('../../src/lib/config.js', () => ({
  env: {
    PUBLIC_SITE_URL: 'https://pylva.test',
    PYLVA_DEPLOYMENT_MODE: 'self_hosted',
    SELF_HOSTED_MONTHLY_EVENTS_LIMIT: 10_000_000,
    SELF_HOSTED_MAX_CUSTOMERS: 500,
    SELF_HOSTED_TELEMETRY_RETENTION_DAYS: 120,
    SELF_HOSTED_BILLING_RETENTION_DAYS: 730,
  },
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

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({
      warn: mocks.logWarn,
      info: vi.fn(),
      error: mocks.logError,
      debug: vi.fn(),
    }),
  },
}));

vi.mock('../../src/lib/realtime/feed-publisher.js', () => ({
  publishFeedMessage: mocks.publishFeedMessage,
}));

vi.mock('../../src/lib/rules/post-call-evaluator.js', () => ({
  evaluatePostCall: mocks.evaluatePostCall,
}));

vi.mock('../../src/lib/rules/repository.js', () => ({
  listActiveRulesForCustomer: mocks.listActiveRulesForCustomer,
}));

const { handleTelemetryIngest } = await import('../../src/lib/ingest/public-handler.js');

interface InsertedRetentionRow {
  span_id: string;
  retention_days: number;
  billing_retention_days: number;
}

function event(spanId: string): Record<string, unknown> {
  return {
    schema_version: '1.6',
    run_id: '00000000-0000-4000-8000-000000000010',
    parent_run_id: null,
    trace_id: '00000000-0000-4000-8000-000000000011',
    span_id: spanId,
    parent_span_id: null,
    customer_id: 'alice',
    step_name: 'chat',
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
  };
}

async function ingestPayload(payload: Record<string, unknown>) {
  return handleTelemetryIngest({
    builderId: 'builder-a',
    keyId: 'key-a',
    productAccessVerified: true,
    rawBody: JSON.stringify(payload),
  });
}

async function ingestOne(spanId: string): Promise<InsertedRetentionRow> {
  mocks.filterDuplicates.mockResolvedValueOnce(new Set([spanId]));

  const response = await ingestPayload({
    batch_id: '00000000-0000-4000-8000-000000000001',
    sdk_version: '1.0.0',
    events: [event(spanId)],
  });

  expect(response.status).toBe(200);
  expect(mocks.insertCostEventsWithRetry).toHaveBeenCalledTimes(1);
  const rows = mocks.insertCostEventsWithRetry.mock.calls[0]?.[0] as
    | InsertedRetentionRow[]
    | undefined;
  expect(rows).toHaveLength(1);
  return rows![0]!;
}

describe('handleTelemetryIngest retention stamping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.aggregateSpendForRule.mockResolvedValue(0);
    mocks.calculateCostUsd.mockReturnValue({
      cost_usd: 1,
      pricing_status: 'priced',
    });
    mocks.evaluatePostCall.mockResolvedValue(undefined);
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
    mocks.filterDuplicates.mockImplementation(
      async (_builderId: string, items: Array<{ span_id: string }>) =>
        new Set(items.map((item) => item.span_id)),
    );
    mocks.formatTierUsage.mockImplementation((used: number, cap: number) => `${used}/${cap}`);
    mocks.insertCostEventsWithRetry.mockResolvedValue(undefined);
    mocks.lookupPricing.mockResolvedValue({
      llm: new Map(),
      metric: new Map(),
    });
    mocks.listActiveRulesForCustomer.mockResolvedValue([]);
    mocks.publishFeedMessage.mockResolvedValue(undefined);
    mocks.recordAcceptedEvents.mockImplementation(
      async (_builderId: string, decision: { used: number | null }, count: number) =>
        decision.used === null ? null : decision.used + count,
    );
    mocks.recordSourceSighting.mockResolvedValue(undefined);
    mocks.freshTier = 'pro';
    mocks.freshAccessState = 'active';
    mocks.freshEntitlementSource = 'admin';
    mocks.txExecute.mockImplementation(
      forShareEntitlementTxExecuteImpl(() =>
        mocks.freshAccessState === null
          ? null
          : {
              plan: mocks.freshTier,
              access_state: mocks.freshAccessState,
              entitlement_source: mocks.freshEntitlementSource,
            },
      ),
    );
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
  });

  it.each([
    ['pro', 90, 365, '00000000-0000-4000-8000-000000000022'],
    ['scale', 365, 18_250, '00000000-0000-4000-8000-000000000023'],
    ['enterprise', 18_250, 18_250, '00000000-0000-4000-8000-000000000024'],
  ] as const)(
    'stamps %s retention days on ClickHouse rows',
    async (tier, retention, billing, spanId) => {
      mocks.checkEventCap.mockResolvedValueOnce({
        enabled: true,
        blocked: false,
        tier,
        cap: 1_000_000,
        used: 0,
        window: {
          start: new Date('2026-06-01T00:00:00.000Z'),
          end: new Date('2026-07-01T00:00:00.000Z'),
          source: 'calendar_month',
        },
      });
      mocks.freshTier = tier;
      mocks.freshEntitlementSource =
        tier === 'enterprise' ? 'enterprise_contract' : 'admin';

      const row = await ingestOne(spanId);

      expect(mocks.checkEventCap).toHaveBeenCalledTimes(1);
      expect(row).toMatchObject({
        span_id: spanId,
        retention_days: retention,
        billing_retention_days: billing,
      });
    },
  );

  it('stamps explicit self-host retention without assigning a plan', async () => {
    mocks.checkEventCap.mockResolvedValueOnce({
      enabled: true,
      blocked: false,
      tier: null,
      cap: Infinity,
      used: null,
      window: null,
    });
    mocks.freshTier = null;
    mocks.freshAccessState = 'active';
    mocks.freshEntitlementSource = 'self_hosted';

    const row = await ingestOne('00000000-0000-4000-8000-000000000025');

    expect(row).toMatchObject({
      retention_days: 120,
      billing_retention_days: 730,
    });
  });

  it('fails closed without writing when the locked entitlement lookup throws', async () => {
    mocks.checkEventCap.mockResolvedValueOnce({
      enabled: false,
      blocked: false,
      tier: null,
      cap: Infinity,
      used: null,
      window: null,
    });
    mocks.txExecute.mockImplementationOnce(async () => {
      throw new Error('db unavailable');
    });

    const response = await ingestPayload({
      batch_id: '00000000-0000-4000-8000-000000000003',
      sdk_version: '1.0.0',
      events: [event('00000000-0000-4000-8000-000000000026')],
    });

    expect(response.status).toBe(500);
    expect(mocks.insertCostEventsWithRetry).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'db unavailable' }),
      'ingest persistence entitlement fence failed',
    );
  });

  it('does not auto-register provider=other from reported non-LLM events', async () => {
    const spanId = '00000000-0000-4000-8000-000000000027';
    mocks.filterDuplicates.mockResolvedValueOnce(new Set([spanId]));

    const response = await ingestPayload({
      batch_id: '00000000-0000-4000-8000-000000000002',
      sdk_version: '1.0.0',
      events: [
        {
          ...event(spanId),
          model: null,
          provider: null,
          tokens_in: 0,
          tokens_out: 0,
          tool_name: 'tavily_search',
          instrumentation_tier: 'reported',
          metric: 'tavily_requests',
          metric_value: 1,
        },
      ],
    });

    expect(response.status).toBe(200);
    expect(mocks.insertCostEventsWithRetry).toHaveBeenCalledTimes(1);
    expect(mocks.recordSourceSighting).not.toHaveBeenCalled();
  });
});
