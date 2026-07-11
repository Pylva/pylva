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
const deliverBuilderAlertMock = vi.fn();
const fetchPeriodAggregatesMock = vi.fn();
const listBuildersWithEventsMock = vi.fn();
const loadModelTierCatalogMock = vi.fn();

vi.mock('../../src/lib/anomaly/repository.js', () => ({
  insertAnomalyEvent: insertAnomalyEventMock,
  expireStaleAnomalies: vi.fn().mockResolvedValue(0),
  isInCooldown: vi.fn().mockResolvedValue(false),
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

vi.mock('../../src/lib/logger.js', () => ({
  logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}));

const { detectAnomalies } = await import('../../src/lib/anomaly/runner.js');

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
    deliverBuilderAlertMock.mockReset();
    fetchPeriodAggregatesMock.mockReset();
    listBuildersWithEventsMock.mockReset();
    loadModelTierCatalogMock.mockReset();

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
    deliverBuilderAlertMock.mockResolvedValue(undefined);

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
});
