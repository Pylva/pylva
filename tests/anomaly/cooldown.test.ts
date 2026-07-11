// Regression test: the anomaly cron persists the anomaly row BEFORE it
// checks the 24h dispatch cooldown, and `anomaly_events.created_at`
// defaults to now(). If the cooldown query is allowed to match the row
// the runner just inserted, the new row's severity equals itself, the
// "strict escalation" override is false, and `isInCooldown` returns true
// -- so the FIRST alert of every brand-new anomaly shape is silently
// suppressed and the builder is never notified.
//
// The fix threads the inserted row's id into `isInCooldown` as
// `exclude_anomaly_id`, and the repository excludes it from the lookup so
// the dedup compares against PRIOR anomalies only.
//
// This suite drives the real runner against a stateful fake `isInCooldown`
// that mirrors the production predicate (same builder/customer/source_type
// within 24h, excluding `exclude_anomaly_id`, severity-escalation
// override). It is therefore sensitive to the runner-side fix: drop the
// `exclude_anomaly_id` and the first-alert assertion fails.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  AnomalyRecommendationAction,
  AnomalySeverity,
  AnomalySourceType,
  AnomalyStatus,
  type AnomalyEvent,
  type AnomalySeverity as AnomalySeverityType,
} from '@pylva/shared';

const insertAnomalyEventMock = vi.fn();
const deliverBuilderAlertMock = vi.fn();
const fetchPeriodAggregatesMock = vi.fn();
const listBuildersWithEventsMock = vi.fn();
const loadModelTierCatalogMock = vi.fn();

// In-memory anomaly store shared by the insert + cooldown fakes so the
// cooldown check sees exactly what the runner persisted, the way a real
// DB would.
interface StoredRow {
  id: string;
  builder_id: string;
  customer_id: string | null;
  source_type: AnomalySourceType;
  severity: AnomalySeverityType;
  created_at: Date;
}
const store: StoredRow[] = [];

const SEVERITY_RANK: Record<AnomalySeverityType, number> = {
  [AnomalySeverity.INFO]: 0,
  [AnomalySeverity.WARN]: 1,
  [AnomalySeverity.ERROR]: 2,
};
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

// Faithful re-implementation of the production cooldown predicate,
// operating over `store`. The `exclude_anomaly_id` branch is the crux:
// when the runner passes it, the just-inserted row is filtered out.
const isInCooldownFake = vi.fn(
  async (input: {
    builder_id: string;
    customer_id: string | null;
    source_type: AnomalySourceType;
    new_severity: AnomalySeverityType;
    now?: Date;
    exclude_anomaly_id?: string;
  }): Promise<boolean> => {
    const now = input.now ?? new Date();
    const cutoff = now.getTime() - COOLDOWN_MS;
    const matches = store.filter(
      (r) =>
        r.builder_id === input.builder_id &&
        r.customer_id === input.customer_id &&
        r.source_type === input.source_type &&
        r.created_at.getTime() >= cutoff &&
        (input.exclude_anomaly_id ? r.id !== input.exclude_anomaly_id : true),
    );
    if (matches.length === 0) return false;
    const maxPriorRank = matches.reduce(
      (max, row) => Math.max(max, SEVERITY_RANK[row.severity] ?? 0),
      -1,
    );
    return (SEVERITY_RANK[input.new_severity] ?? 0) <= maxPriorRank;
  },
);

vi.mock('../../src/lib/anomaly/repository.js', () => ({
  insertAnomalyEvent: insertAnomalyEventMock,
  expireStaleAnomalies: vi.fn().mockResolvedValue(0),
  isInCooldown: isInCooldownFake,
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

function makeAggregate(
  totalCost: number,
  models: Array<{ provider: string; model: string; cost_usd: number }> = [],
) {
  return {
    total_cost_usd: totalCost,
    total_tokens_in: 0,
    total_tokens_out: 0,
    all: { steps: [], models, sources: [] },
    byCustomer: new Map(),
    costByCustomer: new Map(),
  };
}

// current >> baseline -> cost_spike fires with a non-empty diagnosis so the
// runner reaches the insert + cooldown + dispatch path.
function spikeFixture() {
  return [
    makeAggregate(200, [{ provider: 'openai', model: 'gpt-4o', cost_usd: 200 }]), // current
    makeAggregate(50, [{ provider: 'openai', model: 'gpt-4o', cost_usd: 50 }]), // prior
    makeAggregate(50, [{ provider: 'openai', model: 'gpt-4o', cost_usd: 50 }]), // baseline
  ];
}

function primeAggregates() {
  const f = spikeFixture();
  fetchPeriodAggregatesMock
    .mockResolvedValueOnce(f[0]!)
    .mockResolvedValueOnce(f[1]!)
    .mockResolvedValueOnce(f[2]!);
}

// Insert mock that mirrors the DB: assigns an id, stamps created_at=now,
// appends to the shared store, and returns the row (as the real
// insertAnomalyEvent would on a successful, non-conflicting insert).
let idSeq = 0;
function makeInsertingMock(now: Date, severity: AnomalySeverityType = AnomalySeverity.WARN) {
  return (input: {
    builder_id: string;
    customer_id: string | null;
    source_type: AnomalySourceType;
    period_start: Date;
    period_end: Date;
  }): Promise<AnomalyEvent> => {
    const row: AnomalyEvent = {
      id: `a-${++idSeq}`,
      builder_id: input.builder_id,
      customer_id: input.customer_id,
      source_type: input.source_type,
      status: AnomalyStatus.OPEN,
      severity,
      period_start: input.period_start,
      period_end: input.period_end,
      actual_value: 200,
      baseline_value: 50,
      delta_pct: 300,
      diagnosis: { insufficient_revenue_data: true },
      recommendation: { action: AnomalyRecommendationAction.INVESTIGATE_DEEP_LINK },
      created_at: now,
      dismissed_at: null,
    };
    store.push({
      id: row.id,
      builder_id: row.builder_id,
      customer_id: row.customer_id,
      source_type: row.source_type,
      severity,
      created_at: now,
    });
    return Promise.resolve(row);
  };
}

describe('anomaly cooldown -- first alert must not self-suppress', () => {
  beforeEach(() => {
    store.length = 0;
    idSeq = 0;
    insertAnomalyEventMock.mockReset();
    deliverBuilderAlertMock.mockReset().mockResolvedValue(undefined);
    fetchPeriodAggregatesMock.mockReset();
    listBuildersWithEventsMock.mockReset();
    loadModelTierCatalogMock.mockReset();
    isInCooldownFake.mockClear();

    loadModelTierCatalogMock.mockResolvedValue({ byProviderModel: new Map() });
    listBuildersWithEventsMock.mockResolvedValue([
      { builderId: BUILDER_ID, earliestEvent: new Date('2026-03-01T00:00:00Z') },
    ]);
  });

  it('dispatches the alert for a brand-new anomaly shape (no prior rows)', async () => {
    const now = new Date('2026-04-26T12:15:00.000Z');
    primeAggregates();
    insertAnomalyEventMock.mockImplementationOnce(makeInsertingMock(now));

    const result = await detectAnomalies({ now });

    expect(result.anomalies_inserted).toBe(1);
    // The crux: the first alert reaches dispatch. Without the
    // exclude_anomaly_id fix the cooldown query would match the row we
    // just inserted and suppress this call.
    expect(deliverBuilderAlertMock).toHaveBeenCalledTimes(1);
  });

  it('passes the inserted row id as exclude_anomaly_id', async () => {
    const now = new Date('2026-04-26T12:15:00.000Z');
    primeAggregates();
    insertAnomalyEventMock.mockImplementationOnce(makeInsertingMock(now));

    await detectAnomalies({ now });

    expect(isInCooldownFake).toHaveBeenCalledTimes(1);
    const call = isInCooldownFake.mock.calls[0]![0];
    expect(call.exclude_anomaly_id).toBe('a-1');
  });

  it('still suppresses a second same-severity anomaly within 24h', async () => {
    // Tick 1 at 12:15 fires + dispatches and leaves a prior row in the
    // store. Tick 2 at 18:15 (same day, same severity) must be suppressed
    // by that PRIOR row -- proving the exclusion did not break real dedup.
    const t1 = new Date('2026-04-26T12:15:00.000Z');
    primeAggregates();
    insertAnomalyEventMock.mockImplementationOnce(makeInsertingMock(t1));
    await detectAnomalies({ now: t1 });
    expect(deliverBuilderAlertMock).toHaveBeenCalledTimes(1);

    const t2 = new Date('2026-04-26T18:15:00.000Z');
    primeAggregates();
    insertAnomalyEventMock.mockImplementationOnce(makeInsertingMock(t2));
    await detectAnomalies({ now: t2 });

    // No new dispatch -- the prior row (a-1) is within 24h and same
    // severity, so the second alert is correctly deduped.
    expect(deliverBuilderAlertMock).toHaveBeenCalledTimes(1);
  });

  it('lets a strict severity escalation through within 24h', async () => {
    const t1 = new Date('2026-04-26T12:15:00.000Z');
    primeAggregates();
    insertAnomalyEventMock.mockImplementationOnce(makeInsertingMock(t1, AnomalySeverity.WARN));
    await detectAnomalies({ now: t1 });
    expect(deliverBuilderAlertMock).toHaveBeenCalledTimes(1);

    const t2 = new Date('2026-04-26T18:15:00.000Z');
    primeAggregates();
    insertAnomalyEventMock.mockImplementationOnce(makeInsertingMock(t2, AnomalySeverity.ERROR));
    await detectAnomalies({ now: t2 });

    // WARN -> ERROR is a strict escalation: the alert fires despite the
    // prior row being inside the 24h window.
    expect(deliverBuilderAlertMock).toHaveBeenCalledTimes(2);
  });

  it('does not re-dispatch a duplicate ERROR after an intervening WARN', async () => {
    // Spike oscillates across three hourly ticks, all within 24h:
    //   t1 ERROR (alerted) -> t2 WARN (suppressed) -> t3 ERROR.
    // t3 must not re-page because an ERROR already fired inside the window.
    const t1 = new Date('2026-04-26T12:15:00.000Z');
    primeAggregates();
    insertAnomalyEventMock.mockImplementationOnce(makeInsertingMock(t1, AnomalySeverity.ERROR));
    await detectAnomalies({ now: t1 });
    expect(deliverBuilderAlertMock).toHaveBeenCalledTimes(1);

    const t2 = new Date('2026-04-26T14:15:00.000Z');
    primeAggregates();
    insertAnomalyEventMock.mockImplementationOnce(makeInsertingMock(t2, AnomalySeverity.WARN));
    await detectAnomalies({ now: t2 });
    expect(deliverBuilderAlertMock).toHaveBeenCalledTimes(1);

    const t3 = new Date('2026-04-26T16:15:00.000Z');
    primeAggregates();
    insertAnomalyEventMock.mockImplementationOnce(makeInsertingMock(t3, AnomalySeverity.ERROR));
    await detectAnomalies({ now: t3 });

    expect(deliverBuilderAlertMock).toHaveBeenCalledTimes(1);
  });
});
