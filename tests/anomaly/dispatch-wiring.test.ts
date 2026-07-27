// Verifies the anomaly cron orchestrator dispatches a builder alert for
// every successfully inserted anomaly, skips dispatch on idempotent
// no-ops, and survives dispatch errors without crashing the cron.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  AnomalyRecommendationAction,
  AnomalySeverity,
  AnomalySourceType,
  AnomalyStatus,
  type AnomalyEvent,
} from '@pylva/shared';

const insertAnomalyEventMock = vi.fn();
const isInCooldownMock = vi.fn();
const deliverBuilderAlertMock = vi.fn();
const fetchPeriodAggregatesMock = vi.fn();
const listBuildersWithEventsMock = vi.fn();
const loadModelTierCatalogMock = vi.fn();
const authorizeBuilderCapabilityMock = vi.fn();
const logInfoMock = vi.fn();
const logWarnMock = vi.fn();

vi.mock('../../src/lib/anomaly/repository.js', () => ({
  insertAnomalyEvent: insertAnomalyEventMock,
  expireStaleAnomalies: vi.fn().mockResolvedValue(0),
  isInCooldown: isInCooldownMock,
}));

vi.mock('../../src/lib/alerts/builder-alert.js', () => ({
  deliverBuilderAlert: deliverBuilderAlertMock,
}));

vi.mock('../../src/lib/anomaly/clickhouse-queries.js', () => ({
  fetchPeriodAggregates: fetchPeriodAggregatesMock,
  listBuildersWithEvents: listBuildersWithEventsMock,
}));

vi.mock('../../src/lib/anomaly/model-tier-catalog.js', () => ({
  loadModelTierCatalog: loadModelTierCatalogMock,
}));

// B4-4c: the runner now evaluates margin rules + looks up priced customers
// per builder. Mock both so this suite keeps exercising ONLY the spike/drop
// path (empty pricing list == the pre-B4-4c has_revenue_data=false shape).
vi.mock('../../src/lib/customers/lookup.js', () => ({
  listCustomersWithOpenPricing: vi.fn(async () => []),
}));
vi.mock('../../src/lib/rules/margin-evaluator.js', () => ({
  evaluateMarginRules: vi.fn(async () => ({
    rules_evaluated: 0,
    anomalies_inserted: 0,
    anomalies_skipped_idempotent: 0,
    alerts_fired: 0,
    customers_skipped_insufficient_revenue: 0,
  })),
}));

vi.mock('../../src/lib/auth/builder-entitlement.js', () => ({
  authorizeBuilderCapability: authorizeBuilderCapabilityMock,
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({ warn: logWarnMock, info: logInfoMock, error: vi.fn() }),
  },
}));

const { detectAnomalies } = await import('../../src/lib/anomaly/runner.js');
const { ProductAccessMutationDeniedError } =
  await import('../../src/lib/auth/product-access-mutation-error.js');

const NOW = new Date('2026-04-26T12:00:00Z');
const BUILDER_ID = '00000000-0000-0000-0000-000000000001';

interface ModelSlice {
  provider: string;
  model: string;
  cost_usd: number;
}
interface StepSlice {
  step_name: string;
  cost_usd: number;
  iterations: number;
}

function makeAggregate(totalCost: number, models: ModelSlice[] = [], steps: StepSlice[] = []) {
  const all = { steps, models, sources: [] };
  const byCustomer = new Map<string | null, typeof all>();
  const costByCustomer = new Map<string | null, number>();
  return {
    total_cost_usd: totalCost,
    total_tokens_in: 0,
    total_tokens_out: 0,
    all,
    byCustomer,
    costByCustomer,
  };
}

function makeInsertedRow(): AnomalyEvent {
  return {
    id: 'a-inserted',
    builder_id: BUILDER_ID,
    customer_id: null,
    source_type: AnomalySourceType.COST_SPIKE,
    status: AnomalyStatus.OPEN,
    severity: AnomalySeverity.WARN,
    period_start: new Date(NOW.getTime() - 86_400_000),
    period_end: NOW,
    actual_value: 200,
    baseline_value: 50,
    delta_pct: 300,
    diagnosis: { insufficient_revenue_data: true },
    recommendation: {
      action: AnomalyRecommendationAction.INVESTIGATE_DEEP_LINK,
    },
    created_at: NOW,
    dismissed_at: null,
  };
}

describe('detectAnomalies — alert dispatch wiring', () => {
  beforeEach(() => {
    insertAnomalyEventMock.mockReset();
    isInCooldownMock.mockReset().mockResolvedValue(false);
    deliverBuilderAlertMock.mockReset();
    fetchPeriodAggregatesMock.mockReset();
    listBuildersWithEventsMock.mockReset();
    loadModelTierCatalogMock.mockReset();
    authorizeBuilderCapabilityMock.mockReset().mockResolvedValue({ allowed: true });
    logInfoMock.mockReset();
    logWarnMock.mockReset();

    loadModelTierCatalogMock.mockResolvedValue({ byProviderModel: new Map() });
    listBuildersWithEventsMock.mockResolvedValue([
      { builderId: BUILDER_ID, earliestEvent: new Date(NOW.getTime() - 30 * 86_400_000) },
    ]);
    // current >> baseline → cost_spike fires; current model slice with
    // strictly higher spend than prior produces a non-empty top_drivers
    // list so the recommender returns INVESTIGATE_DEEP_LINK (not DISMISS).
    fetchPeriodAggregatesMock
      .mockResolvedValueOnce(
        makeAggregate(200, [{ provider: 'openai', model: 'gpt-4o', cost_usd: 200 }]),
      )
      .mockResolvedValueOnce(
        makeAggregate(50, [{ provider: 'openai', model: 'gpt-4o', cost_usd: 50 }]),
      )
      .mockResolvedValueOnce(
        makeAggregate(50, [{ provider: 'openai', model: 'gpt-4o', cost_usd: 50 }]),
      );
  });

  it('dispatches an alert for every successfully inserted anomaly', async () => {
    insertAnomalyEventMock.mockResolvedValue(makeInsertedRow());
    deliverBuilderAlertMock.mockResolvedValue({ kind: 'delivered' });

    const result = await detectAnomalies({ now: NOW });

    expect(result.anomalies_inserted).toBeGreaterThan(0);
    expect(deliverBuilderAlertMock).toHaveBeenCalledTimes(result.anomalies_inserted);
    const call = deliverBuilderAlertMock.mock.calls[0]!;
    expect(call[0].builderId).toBe(BUILDER_ID);
    expect(call[0].payload.type).toBe('anomaly.detected');
    expect(call[0].payload.data.anomaly_id).toBe('a-inserted');
  });

  it('skips dispatch when insert is an idempotent no-op (returns null)', async () => {
    insertAnomalyEventMock.mockResolvedValue(null);

    const result = await detectAnomalies({ now: NOW });

    expect(result.anomalies_skipped_idempotent).toBeGreaterThan(0);
    expect(result.anomalies_inserted).toBe(0);
    expect(deliverBuilderAlertMock).not.toHaveBeenCalled();
  });

  it('survives dispatch failures without rolling back the cycle', async () => {
    insertAnomalyEventMock.mockResolvedValue(makeInsertedRow());
    deliverBuilderAlertMock.mockRejectedValue(new Error('channel down'));

    const result = await detectAnomalies({ now: NOW });

    expect(result.anomalies_inserted).toBeGreaterThan(0);
    expect(result.errors).toBe(0); // dispatch errors don't increment cycle errors
  });

  it('does not report a lifecycle-denied delivery as dispatched', async () => {
    insertAnomalyEventMock.mockResolvedValue(makeInsertedRow());
    deliverBuilderAlertMock.mockResolvedValue({ kind: 'access_denied' });

    const result = await detectAnomalies({ now: NOW });

    expect(result).toMatchObject({ anomalies_inserted: 1, errors: 0 });
    expect(logInfoMock).toHaveBeenCalledWith(
      expect.objectContaining({ anomaly_id: 'a-inserted' }),
      'anomaly alert stopped after workspace access changed',
    );
    expect(logInfoMock).not.toHaveBeenCalledWith(
      expect.anything(),
      'anomaly alert dispatched',
    );
  });

  it('does not report a skipped outcome as successful dispatch', async () => {
    insertAnomalyEventMock.mockResolvedValue(makeInsertedRow());
    deliverBuilderAlertMock.mockResolvedValueOnce({
      kind: 'skipped',
      reason: 'no_config',
    });

    await expect(detectAnomalies({ now: NOW })).resolves.toMatchObject({
      anomalies_inserted: 1,
      errors: 0,
    });
    expect(logInfoMock).toHaveBeenCalledWith(
      expect.objectContaining({ anomaly_id: 'a-inserted', reason: 'no_config' }),
      'anomaly alert not dispatched',
    );
    expect(logInfoMock).not.toHaveBeenCalledWith(
      expect.anything(),
      'anomaly alert dispatched',
    );
  });

  it('warns for an explicit failed outcome without rolling back the anomaly', async () => {
    insertAnomalyEventMock.mockResolvedValue(makeInsertedRow());
    deliverBuilderAlertMock.mockResolvedValue({
      kind: 'failed',
      error: 'channel down',
    });

    await expect(detectAnomalies({ now: NOW })).resolves.toMatchObject({
      anomalies_inserted: 1,
      errors: 0,
    });
    expect(logWarnMock).toHaveBeenCalledWith(
      expect.objectContaining({ anomaly_id: 'a-inserted' }),
      'anomaly alert dispatch failed',
    );
    expect(logInfoMock).not.toHaveBeenCalledWith(
      expect.anything(),
      'anomaly alert dispatched',
    );
  });

  it('does not persist or deliver after suspension lands during aggregate loading', async () => {
    let resumeCurrentAggregate!: (value: ReturnType<typeof makeAggregate>) => void;
    let signalAggregateStarted!: () => void;
    const aggregateStarted = new Promise<void>((resolve) => {
      signalAggregateStarted = resolve;
    });
    const pausedCurrentAggregate = new Promise<ReturnType<typeof makeAggregate>>((resolve) => {
      resumeCurrentAggregate = resolve;
    });
    let hasProductAccess = true;

    authorizeBuilderCapabilityMock.mockImplementation(async () => ({
      allowed: hasProductAccess,
    }));
    fetchPeriodAggregatesMock.mockReset();
    fetchPeriodAggregatesMock
      .mockImplementationOnce(() => {
        signalAggregateStarted();
        return pausedCurrentAggregate;
      })
      .mockResolvedValueOnce(
        makeAggregate(50, [{ provider: 'openai', model: 'gpt-4o', cost_usd: 50 }]),
      )
      .mockResolvedValueOnce(
        makeAggregate(50, [{ provider: 'openai', model: 'gpt-4o', cost_usd: 50 }]),
      );
    insertAnomalyEventMock.mockResolvedValue(makeInsertedRow());
    deliverBuilderAlertMock.mockResolvedValue({ kind: 'delivered' });

    const run = detectAnomalies({ now: NOW });
    await aggregateStarted;
    hasProductAccess = false;
    resumeCurrentAggregate(
      makeAggregate(200, [{ provider: 'openai', model: 'gpt-4o', cost_usd: 200 }]),
    );

    await expect(run).resolves.toMatchObject({
      anomalies_inserted: 0,
      anomalies_skipped_idempotent: 0,
      errors: 0,
    });
    expect(insertAnomalyEventMock).not.toHaveBeenCalled();
    expect(deliverBuilderAlertMock).not.toHaveBeenCalled();
  });

  it('does not deliver after suspension lands between persistence and dispatch', async () => {
    let resumeCooldown!: (cooled: boolean) => void;
    let signalCooldownStarted!: () => void;
    const cooldownStarted = new Promise<void>((resolve) => {
      signalCooldownStarted = resolve;
    });
    const pausedCooldown = new Promise<boolean>((resolve) => {
      resumeCooldown = resolve;
    });
    let hasProductAccess = true;

    authorizeBuilderCapabilityMock.mockImplementation(async () => ({
      allowed: hasProductAccess,
    }));
    insertAnomalyEventMock.mockResolvedValue(makeInsertedRow());
    isInCooldownMock.mockImplementationOnce(() => {
      signalCooldownStarted();
      return pausedCooldown;
    });
    deliverBuilderAlertMock.mockResolvedValue({ kind: 'delivered' });

    const run = detectAnomalies({ now: NOW });
    await cooldownStarted;
    hasProductAccess = false;
    resumeCooldown(false);

    await expect(run).resolves.toMatchObject({
      anomalies_inserted: 1,
      errors: 0,
    });
    expect(insertAnomalyEventMock).toHaveBeenCalledTimes(1);
    expect(deliverBuilderAlertMock).not.toHaveBeenCalled();
  });

  it('stops when the locked insert observes suspension after the pre-insert checkpoint', async () => {
    let rejectLockedInsert!: () => void;
    let signalLockedInsertStarted!: () => void;
    const lockedInsertStarted = new Promise<void>((resolve) => {
      signalLockedInsertStarted = resolve;
    });
    const pausedLockedInsert = new Promise<never>((_resolve, reject) => {
      rejectLockedInsert = () => reject(new ProductAccessMutationDeniedError(BUILDER_ID));
    });

    insertAnomalyEventMock.mockImplementationOnce(() => {
      signalLockedInsertStarted();
      return pausedLockedInsert;
    });

    const run = detectAnomalies({ now: NOW });
    await lockedInsertStarted;
    rejectLockedInsert();

    await expect(run).resolves.toMatchObject({
      anomalies_inserted: 0,
      anomalies_skipped_idempotent: 0,
      errors: 0,
    });
    expect(insertAnomalyEventMock).toHaveBeenCalledTimes(1);
    expect(deliverBuilderAlertMock).not.toHaveBeenCalled();
  });
});
