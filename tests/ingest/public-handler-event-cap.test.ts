import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '@pylva/shared';
import { forShareEntitlementTxExecuteImpl, sqlText } from '../_helpers/drizzle-mock.js';

const mocks = vi.hoisted(() => ({
  aggregateSpendForRule: vi.fn(),
  calculateCostUsd: vi.fn(),
  checkEventCap: vi.fn(),
  authorizeBuilderCapability: vi.fn(),
  evaluatePostCall: vi.fn(),
  filterDuplicates: vi.fn(),
  formatTierUsage: vi.fn(),
  insertCostEventsWithRetry: vi.fn(),
  lookupPricing: vi.fn(),
  listActiveRulesForCustomer: vi.fn(),
  publishFeedMessage: vi.fn(),
  recordAcceptedEvents: vi.fn(),
  recordSourceSighting: vi.fn(),
  freshSelfHosted: false,
  freshTier: 'pro' as string | null,
  freshAccessState: 'active' as string | null,
  freshEntitlementSource: 'admin' as string | null,
  txExecute: vi.fn(),
  txInsert: vi.fn(),
  txInsertValues: vi.fn(),
  txOnConflictDoNothing: vi.fn(),
  txSelect: vi.fn(),
  undoFilterDuplicates: vi.fn(),
  validateSemantic: vi.fn(),
  withRLS: vi.fn(),
  logWarn: vi.fn(),
}));

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

vi.mock('../../src/lib/budget/aggregate.js', () => ({
  aggregateSpendForRule: mocks.aggregateSpendForRule,
}));

vi.mock('../../src/lib/auth/builder-entitlement.js', () => ({
  authorizeBuilderCapability: mocks.authorizeBuilderCapability,
  accessDeniedMessage: () => 'Workspace access is suspended; reactivate billing to continue',
}));

vi.mock('../../src/lib/config.js', () => ({
  env: {
    PUBLIC_SITE_URL: 'https://pylva.test',
    PYLVA_DEPLOYMENT_MODE: 'self_hosted',
    SELF_HOSTED_MAX_CUSTOMERS: 3,
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

vi.mock('../../src/lib/ingest/semantic-validation.js', () => ({
  validateSemantic: mocks.validateSemantic,
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

function capDecision(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    blocked: false,
    tier: 'pro',
    cap: 100,
    used: 10,
    window: {
      start: new Date('2026-06-01T00:00:00.000Z'),
      end: new Date('2026-07-01T00:00:00.000Z'),
      source: 'calendar_month',
    },
    ...overrides,
  };
}

function spanId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function ingestEvent(
  index: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: '1.6',
    run_id: '00000000-0000-4000-8000-000000000010',
    parent_run_id: null,
    trace_id: '00000000-0000-4000-8000-000000000011',
    span_id: spanId(index),
    parent_span_id: null,
    customer_id: `customer_${index}`,
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
    ...overrides,
  };
}

function body(events: Record<string, unknown>[]): string {
  return JSON.stringify({
    batch_id: '00000000-0000-4000-8000-000000000001',
    sdk_version: '1.0.0',
    events,
  });
}

async function ingest(rawBody: string) {
  return handleTelemetryIngest({
    builderId: 'builder-a',
    keyId: 'key-a',
    productAccessVerified: true,
    rawBody,
  });
}

describe('handleTelemetryIngest event cap gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorizeBuilderCapability.mockResolvedValue({
      allowed: true,
      lookup: {
        kind: 'resolved',
        resolution: {
          ok: true,
          entitlement: {
            plan: 'pro',
            access_state: 'active',
            entitlement_source: 'stripe',
            has_product_access: true,
            legacy_free: false,
          },
        },
      },
    });
    mocks.aggregateSpendForRule.mockResolvedValue(0);
    mocks.calculateCostUsd.mockReturnValue({ cost_usd: 1, pricing_status: 'priced' });
    mocks.checkEventCap.mockResolvedValue(capDecision());
    mocks.evaluatePostCall.mockResolvedValue(undefined);
    mocks.filterDuplicates.mockImplementation(
      async (_builderId: string, items: Array<{ span_id: string }>) =>
        new Set(items.map((item) => item.span_id)),
    );
    mocks.formatTierUsage.mockImplementation((used: number, cap: number) => `${used}/${cap}`);
    mocks.insertCostEventsWithRetry.mockResolvedValue(undefined);
    mocks.lookupPricing.mockResolvedValue({ llm: new Map(), metric: new Map() });
    mocks.listActiveRulesForCustomer.mockResolvedValue([]);
    mocks.publishFeedMessage.mockResolvedValue(undefined);
    mocks.recordAcceptedEvents.mockImplementation(
      async (_builderId: string, decision: { used: number | null }, count: number) =>
        decision.used === null ? null : decision.used + count,
    );
    mocks.recordSourceSighting.mockResolvedValue(undefined);
    mocks.freshSelfHosted = false;
    mocks.freshTier = 'pro';
    mocks.freshAccessState = 'active';
    mocks.freshEntitlementSource = 'admin';
    mocks.txExecute.mockImplementation(
      forShareEntitlementTxExecuteImpl(() =>
        mocks.freshAccessState === null
          ? null
          : mocks.freshSelfHosted
          ? {
              plan: null,
              access_state: mocks.freshAccessState,
              entitlement_source: 'self_hosted',
            }
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
    mocks.txSelect.mockImplementation((selection: Record<string, unknown>) => ({
      from: () => ({
        where: () =>
          Promise.resolve(
            Object.prototype.hasOwnProperty.call(selection, 'count') ? [{ count: 0 }] : [],
          ),
      }),
    }));
    mocks.undoFilterDuplicates.mockResolvedValue(undefined);
    mocks.validateSemantic.mockReturnValue({ ok: true });
    mocks.withRLS.mockImplementation(
      async (_builderId: string, fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          execute: mocks.txExecute,
          insert: mocks.txInsert,
          select: mocks.txSelect,
        }),
    );
  });

  it('fails closed before cap or persistence for a direct suspended-workspace call', async () => {
    mocks.authorizeBuilderCapability.mockResolvedValueOnce({
      allowed: false,
      lookup: {
        kind: 'resolved',
        resolution: {
          ok: true,
          entitlement: {
            plan: null,
            access_state: 'suspended',
            entitlement_source: 'stripe',
            has_product_access: false,
            legacy_free: false,
          },
        },
      },
    });

    const response = await handleTelemetryIngest({
      builderId: 'builder-a',
      keyId: 'key-a',
      rawBody: body([ingestEvent(1)]),
    });

    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({
      error: { code: ErrorCode.FEATURE_NOT_AVAILABLE },
    });
    expect(mocks.checkEventCap).not.toHaveBeenCalled();
    expect(mocks.insertCostEventsWithRetry).not.toHaveBeenCalled();
  });

  it.each([
    ['middleware-verified', true],
    ['Lambda/direct', false],
  ] as const)(
    'rechecks under the persistence lock after a %s request pauses and is suspended',
    async (_label, middlewareVerified) => {
      const pricingStarted = deferred();
      const continuePricing = deferred();
      mocks.lookupPricing.mockImplementationOnce(async () => {
        pricingStarted.resolve();
        await continuePricing.promise;
        return { llm: new Map(), metric: new Map() };
      });

      const pending = handleTelemetryIngest({
        builderId: 'builder-a',
        keyId: 'key-a',
        ...(middlewareVerified ? { productAccessVerified: true } : {}),
        rawBody: body([ingestEvent(1)]),
      });
      await pricingStarted.promise;

      mocks.freshTier = null;
      mocks.freshAccessState = 'suspended';
      mocks.freshEntitlementSource = 'stripe';
      continuePricing.resolve();

      const response = await pending;

      expect(response.status).toBe(403);
      expect(JSON.parse(response.body)).toMatchObject({
        error: { code: ErrorCode.FEATURE_NOT_AVAILABLE },
      });
      expect(mocks.insertCostEventsWithRetry).not.toHaveBeenCalled();
      expect(mocks.recordAcceptedEvents).not.toHaveBeenCalled();
      expect(mocks.undoFilterDuplicates).toHaveBeenCalledTimes(1);
      expect(sqlText(mocks.txExecute.mock.calls[0]?.[0])).toContain('FOR SHARE');
      expect(mocks.authorizeBuilderCapability).toHaveBeenCalledTimes(
        middlewareVerified ? 0 : 1,
      );
    },
  );

  it('returns 403 before parsing or ingest work when the cap is already reached', async () => {
    mocks.checkEventCap.mockResolvedValueOnce(
      capDecision({
        blocked: true,
        used: 100,
        window: {
          start: new Date('2026-06-01T00:00:00.000Z'),
          end: new Date('2026-07-01T00:00:00.000Z'),
          source: 'calendar_month',
        },
      }),
    );
    const parseSpy = vi.spyOn(JSON, 'parse');

    const response = await ingest('{not-json');
    parseSpy.mockRestore();
    const parsed = JSON.parse(response.body) as { error: { code: string; message: string } };

    expect(response.status).toBe(403);
    expect(parsed.error.code).toBe(ErrorCode.TIER_LIMIT_REACHED);
    expect(parsed.error.message).toContain('pro plan is configured for 100 events per period');
    expect(parsed.error.message).toContain('Ask the operator');
    expect(parsed.error.message).toContain('Ingestion is paused until 2026-07-01T00:00:00.000Z');
    expect(response.headers?.['X-Pylva-Tier-Usage']).toBe('100/100');
    expect(parseSpy).not.toHaveBeenCalled();
    expect(mocks.validateSemantic).not.toHaveBeenCalled();
    expect(mocks.lookupPricing).not.toHaveBeenCalled();
    expect(mocks.filterDuplicates).not.toHaveBeenCalled();
    expect(mocks.insertCostEventsWithRetry).not.toHaveBeenCalled();
  });

  it('returns an internal fail-closed response for a missing limit mapping', async () => {
    mocks.checkEventCap.mockResolvedValueOnce(
      capDecision({
        blocked: true,
        configuration_error: true,
        tier: null,
        cap: 0,
        used: 0,
        window: null,
      }),
    );

    const response = await ingest(body([ingestEvent(1)]));

    expect(response.status).toBe(500);
    expect(JSON.parse(response.body)).toMatchObject({
      error: {
        code: ErrorCode.INTERNAL_ERROR,
        message: 'workspace limit configuration could not be verified',
      },
    });
    expect(mocks.validateSemantic).not.toHaveBeenCalled();
    expect(mocks.lookupPricing).not.toHaveBeenCalled();
    expect(mocks.insertCostEventsWithRetry).not.toHaveBeenCalled();
  });

  it('increments only rows accepted for insert after semantic validation and dedup', async () => {
    const accepted = spanId(1);
    const droppedByDedup = spanId(2);
    const rejected = spanId(3);
    mocks.validateSemantic.mockImplementation((event: { span_id: string }) =>
      event.span_id === rejected ? { ok: false, error: 'semantic bad' } : { ok: true },
    );
    mocks.filterDuplicates.mockResolvedValueOnce(new Set([accepted]));

    const response = await ingest(
      body([
        ingestEvent(1, { span_id: accepted }),
        ingestEvent(2, { span_id: droppedByDedup }),
        ingestEvent(3, { span_id: rejected }),
      ]),
    );
    const parsed = JSON.parse(response.body) as { accepted: number; rejected: number };

    expect(response.status).toBe(200);
    expect(parsed).toMatchObject({ accepted: 1, rejected: 1 });
    expect(mocks.insertCostEventsWithRetry.mock.calls[0]?.[0]).toHaveLength(1);
    expect(mocks.recordAcceptedEvents).toHaveBeenCalledWith(
      'builder-a',
      expect.objectContaining({ used: 10, cap: 100 }),
      1,
    );
  });

  it('does not increment when ClickHouse insert throws', async () => {
    mocks.insertCostEventsWithRetry.mockRejectedValueOnce(new Error('insert failed'));

    const response = await ingest(body([ingestEvent(1)]));

    expect(response.status).toBe(500);
    expect(mocks.recordAcceptedEvents).not.toHaveBeenCalled();
    expect(mocks.undoFilterDuplicates).toHaveBeenCalledTimes(1);
  });

  it('adds usage header to successful finite-cap responses', async () => {
    const response = await ingest(body([ingestEvent(1), ingestEvent(2)]));

    expect(response.status).toBe(200);
    expect(response.headers?.['X-Pylva-Tier-Usage']).toBe('12/100');
  });

  it('omits finite usage header when the Redis increment fails open', async () => {
    mocks.recordAcceptedEvents.mockResolvedValueOnce(null);

    const response = await ingest(body([ingestEvent(1), ingestEvent(2)]));

    expect(response.status).toBe(200);
    expect(response.headers?.['X-Pylva-Tier-Usage']).toBeUndefined();
  });

  it('omits usage header for fail-open decisions with an untrusted starting count', async () => {
    mocks.checkEventCap.mockResolvedValueOnce(capDecision({ used: null }));

    const response = await ingest(body([ingestEvent(1), ingestEvent(2)]));

    expect(response.status).toBe(200);
    expect(response.headers?.['X-Pylva-Tier-Usage']).toBeUndefined();
    expect(mocks.recordAcceptedEvents).toHaveBeenCalledWith(
      'builder-a',
      expect.objectContaining({ used: null, cap: 100 }),
      2,
    );
    expect(mocks.formatTierUsage).not.toHaveBeenCalled();
  });

  it('has no finite usage header when event limits are disabled', async () => {
    mocks.checkEventCap.mockResolvedValueOnce(
      capDecision({ enabled: false, tier: null, cap: Infinity, used: null, window: null }),
    );

    const response = await ingest(body([ingestEvent(1)]));

    expect(response.status).toBe(200);
    expect(response.headers?.['X-Pylva-Tier-Usage']).toBeUndefined();
  });

  it('fails closed before persistence when the locked entitlement lookup throws', async () => {
    mocks.checkEventCap.mockResolvedValueOnce(
      capDecision({ enabled: false, tier: null, cap: Infinity, used: null, window: null }),
    );
    mocks.txExecute.mockImplementationOnce(async () => {
      throw new Error('authoritative PostgreSQL unavailable');
    });

    const response = await ingest(body([ingestEvent(1)]));

    expect(response.status).toBe(500);
    expect(mocks.insertCostEventsWithRetry).not.toHaveBeenCalled();
    expect(mocks.txInsertValues).not.toHaveBeenCalled();
  });

  it('defers customer auto-discovery when its second locked entitlement read resolves unknown', async () => {
    mocks.checkEventCap.mockResolvedValueOnce(
      capDecision({ enabled: false, tier: null, cap: Infinity, used: null, window: null }),
    );
    let entitlementReads = 0;
    mocks.txExecute.mockImplementation(
      forShareEntitlementTxExecuteImpl(() => {
        entitlementReads += 1;
        return entitlementReads === 1
          ? {
              plan: 'pro',
              access_state: 'active',
              entitlement_source: 'admin',
            }
          : null;
      }),
    );

    const response = await ingest(body([ingestEvent(1)]));
    const parsed = JSON.parse(response.body) as {
      accepted: number;
      warnings?: Array<{ code: string }>;
    };

    expect(response.status).toBe(200);
    expect(parsed.accepted).toBe(1);
    expect(parsed.warnings).toBeUndefined();
    expect(mocks.txInsert).not.toHaveBeenCalled();
    expect(sqlText(mocks.txExecute.mock.calls[1]?.[0])).toContain('pg_advisory_xact_lock');
    expect(sqlText(mocks.txExecute.mock.calls[2]?.[0])).toContain('FOR SHARE');
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'customer_discovery_deferred_unknown_tier',
        builder_id: 'builder-a',
        deferred_count: 1,
      }),
      'customer auto-registration deferred because workspace entitlement is unavailable',
    );
  });

  it('keeps enterprise customer auto-discovery unbounded after taking the customer lock', async () => {
    mocks.checkEventCap.mockResolvedValueOnce(
      capDecision({ tier: 'enterprise', cap: Infinity, used: null, window: null }),
    );
    mocks.freshTier = 'enterprise';

    const response = await ingest(body([ingestEvent(1), ingestEvent(2)]));
    const parsed = JSON.parse(response.body) as {
      accepted: number;
      warnings?: Array<{ code: string }>;
    };

    expect(response.status).toBe(200);
    expect(parsed.accepted).toBe(2);
    expect(parsed.warnings).toBeUndefined();
    expect(sqlText(mocks.txExecute.mock.calls[0]?.[0])).toContain('FOR SHARE');
    expect(sqlText(mocks.txExecute.mock.calls[1]?.[0])).toContain('pg_advisory_xact_lock');
    expect(sqlText(mocks.txExecute.mock.calls[2]?.[0])).toContain('FOR SHARE');
    expect(mocks.txSelect).not.toHaveBeenCalled();
    expect(mocks.txInsert).toHaveBeenCalledTimes(1);
    expect(mocks.txInsertValues).toHaveBeenCalledWith([
      { builder_id: 'builder-a', external_id: 'customer_1' },
      { builder_id: 'builder-a', external_id: 'customer_2' },
    ]);
  });

  it('skips customer auto-discovery at customer cap but accepts telemetry with a warning', async () => {
    mocks.checkEventCap.mockResolvedValueOnce(capDecision({ tier: 'scale' }));
    mocks.freshTier = 'pro';
    mocks.txSelect.mockImplementationOnce((selection: Record<string, unknown>) => ({
      from: () => ({
        where: () =>
          Promise.resolve(
            Object.prototype.hasOwnProperty.call(selection, 'count') ? [{ count: 50 }] : [],
          ),
      }),
    }));

    const response = await ingest(body([ingestEvent(1)]));
    const parsed = JSON.parse(response.body) as {
      accepted: number;
      warnings?: Array<{ code: string; message?: string }>;
    };

    expect(response.status).toBe(200);
    expect(parsed.accepted).toBe(1);
    expect(parsed.warnings?.[0]).toMatchObject({
      code: 'customer_limit_reached',
    });
    expect(parsed.warnings?.[0]?.message).toContain('pro plan allows 50 customers');
    expect(mocks.txInsert).not.toHaveBeenCalled();
    expect(sqlText(mocks.txExecute.mock.calls[0]?.[0])).toContain('FOR SHARE');
    expect(sqlText(mocks.txExecute.mock.calls[1]?.[0])).toContain('pg_advisory_xact_lock');
    expect(sqlText(mocks.txExecute.mock.calls[2]?.[0])).toContain('FOR SHARE');
    const lockCallOrder = mocks.txExecute.mock.invocationCallOrder[1];
    const tierCallOrder = mocks.txExecute.mock.invocationCallOrder[2];
    const selectCallOrder = mocks.txSelect.mock.invocationCallOrder[0];
    expect(lockCallOrder).toBeDefined();
    expect(tierCallOrder).toBeDefined();
    expect(selectCallOrder).toBeDefined();
    expect(lockCallOrder!).toBeLessThan(tierCallOrder!);
    expect(tierCallOrder!).toBeLessThan(selectCallOrder!);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'customer_limit_reached', plan: 'pro', skipped_count: 1 }),
      'customer auto-registration skipped at tier customer limit',
    );
  });

  it('enforces the configured self-host customer cap during auto-discovery', async () => {
    mocks.checkEventCap.mockResolvedValueOnce(
      capDecision({ enabled: false, tier: null, cap: Infinity, used: null, window: null }),
    );
    mocks.freshSelfHosted = true;
    mocks.txSelect.mockImplementationOnce((selection: Record<string, unknown>) => ({
      from: () => ({
        where: () =>
          Promise.resolve(
            Object.prototype.hasOwnProperty.call(selection, 'count') ? [{ count: 3 }] : [],
          ),
      }),
    }));

    const response = await ingest(body([ingestEvent(1)]));
    const parsed = JSON.parse(response.body) as {
      accepted: number;
      warnings?: Array<{ code: string; message?: string }>;
    };

    expect(response.status).toBe(200);
    expect(parsed.accepted).toBe(1);
    expect(parsed.warnings?.[0]).toMatchObject({
      code: 'customer_limit_reached',
    });
    expect(parsed.warnings?.[0]?.message).toContain(
      'This self-hosted deployment allows 3 customers',
    );
    expect(parsed.warnings?.[0]?.message).toContain('Raise SELF_HOSTED_MAX_CUSTOMERS');
    expect(mocks.txInsert).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'customer_limit_reached',
        plan: null,
        limit: 3,
        skipped_count: 1,
      }),
      'customer auto-registration skipped at tier customer limit',
    );
  });

  it('accepts a batch that straddles the cap, then blocks the next request', async () => {
    let used = 99;
    mocks.checkEventCap.mockImplementation(async () =>
      capDecision({
        blocked: used >= 100,
        used,
      }),
    );
    mocks.recordAcceptedEvents.mockImplementation(
      async (_builderId: string, _decision: unknown, count: number) => {
        used += count;
        return used;
      },
    );
    const events = Array.from({ length: 100 }, (_value, index) => ingestEvent(index + 1));

    const first = await ingest(body(events));
    const firstBody = JSON.parse(first.body) as { accepted: number };
    const second = await ingest(body([ingestEvent(101)]));

    expect(first.status).toBe(200);
    expect(firstBody.accepted).toBe(100);
    expect(first.headers?.['X-Pylva-Tier-Usage']).toBe('199/100');
    expect(second.status).toBe(403);
  });
});
