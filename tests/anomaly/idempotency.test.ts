// Regression test for bug_006: the anomaly cron's sliding 24h window
// must truncate `now` to a stable cadence boundary (top-of-hour) so
// migration 030's partial unique index can dedupe consecutive ticks.
//
// The test calls `detectAnomalies` twice with two different `now`
// values inside the same hour. The first invocation's `insertAnomalyEvent`
// returns a row (success); the second returns null (simulating
// ON CONFLICT DO NOTHING from the partial unique index). The assertion
// is that the runner increments `anomalies_skipped_idempotent` on the
// second call — which only happens if both ticks key into identical
// `(period_start, period_end)` bounds.

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

const BUILDER_ID = '00000000-0000-0000-0000-000000000001';

interface ModelSlice {
  provider: string;
  model: string;
  cost_usd: number;
}

function makeAggregate(totalCost: number, models: ModelSlice[] = []) {
  return {
    total_cost_usd: totalCost,
    total_tokens_in: 0,
    total_tokens_out: 0,
    all: { steps: [], models, sources: [] },
    byCustomer: new Map(),
    costByCustomer: new Map(),
  };
}

function makeInsertedRow(periodStart: Date, periodEnd: Date): AnomalyEvent {
  return {
    id: 'a-inserted',
    builder_id: BUILDER_ID,
    customer_id: null,
    source_type: AnomalySourceType.COST_SPIKE,
    status: AnomalyStatus.OPEN,
    severity: AnomalySeverity.WARN,
    period_start: periodStart,
    period_end: periodEnd,
    actual_value: 200,
    baseline_value: 50,
    delta_pct: 300,
    diagnosis: { insufficient_revenue_data: true },
    recommendation: { action: AnomalyRecommendationAction.INVESTIGATE_DEEP_LINK },
    created_at: periodEnd,
    dismissed_at: null,
  };
}

describe('bug_006 — cron idempotency across consecutive ticks', () => {
  beforeEach(() => {
    insertAnomalyEventMock.mockReset();
    deliverBuilderAlertMock.mockReset();
    fetchPeriodAggregatesMock.mockReset();
    listBuildersWithEventsMock.mockReset();
    loadModelTierCatalogMock.mockReset();

    loadModelTierCatalogMock.mockResolvedValue({ byProviderModel: new Map() });
    listBuildersWithEventsMock.mockResolvedValue([
      { builderId: BUILDER_ID, earliestEvent: new Date('2026-03-01T00:00:00Z') },
    ]);
    deliverBuilderAlertMock.mockResolvedValue(undefined);
  });

  it('two ticks within the same hour key into identical period bounds (ON CONFLICT path)', async () => {
    // current >> baseline → cost_spike fires; non-empty diagnosis so
    // the runner reaches the insert path.
    const fixture = () => [
      makeAggregate(200, [{ provider: 'openai', model: 'gpt-4o', cost_usd: 200 }]), // current
      makeAggregate(50, [{ provider: 'openai', model: 'gpt-4o', cost_usd: 50 }]), // prior
      makeAggregate(50, [{ provider: 'openai', model: 'gpt-4o', cost_usd: 50 }]), // baseline
    ];

    // Tick 1: 12:15:01.123Z. Insert succeeds (returns row).
    fetchPeriodAggregatesMock
      .mockResolvedValueOnce(fixture()[0]!)
      .mockResolvedValueOnce(fixture()[1]!)
      .mockResolvedValueOnce(fixture()[2]!);
    let capturedInsertA: { period_start: Date; period_end: Date } | null = null;
    insertAnomalyEventMock.mockImplementationOnce((input) => {
      capturedInsertA = { period_start: input.period_start, period_end: input.period_end };
      return Promise.resolve(makeInsertedRow(input.period_start, input.period_end));
    });
    const r1 = await detectAnomalies({ now: new Date('2026-04-26T12:15:01.123Z') });
    expect(r1.anomalies_inserted).toBe(1);

    // Tick 2: 12:42:55.789Z (same hour, different ms). Insert returns
    // null (simulating partial unique index ON CONFLICT).
    fetchPeriodAggregatesMock
      .mockResolvedValueOnce(fixture()[0]!)
      .mockResolvedValueOnce(fixture()[1]!)
      .mockResolvedValueOnce(fixture()[2]!);
    let capturedInsertB: { period_start: Date; period_end: Date } | null = null;
    insertAnomalyEventMock.mockImplementationOnce((input) => {
      capturedInsertB = { period_start: input.period_start, period_end: input.period_end };
      return Promise.resolve(null);
    });
    const r2 = await detectAnomalies({ now: new Date('2026-04-26T12:42:55.789Z') });
    expect(r2.anomalies_inserted).toBe(0);
    expect(r2.anomalies_skipped_idempotent).toBe(1);

    // Load-bearing assertion: the period bounds passed to the
    // repository are byte-identical across the two ticks.
    expect(capturedInsertA).not.toBeNull();
    expect(capturedInsertB).not.toBeNull();
    expect(capturedInsertA!.period_start.getTime()).toBe(capturedInsertB!.period_start.getTime());
    expect(capturedInsertA!.period_end.getTime()).toBe(capturedInsertB!.period_end.getTime());
    // And the bound is the top-of-hour, not the wall-clock now.
    expect(capturedInsertA!.period_end.toISOString()).toBe('2026-04-26T12:00:00.000Z');
  });
});
