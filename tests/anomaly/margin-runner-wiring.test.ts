// B4-4c — the anomaly cron invokes the margin evaluator per builder:
// with the shared catalog, BEFORE the spike/drop cold-start gate (margin
// rules are explicit config, not baseline statistics), folding its anomaly
// counters into the run result, and isolating its failures so a margin bug
// can't stall spike/drop detection.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const evaluateMarginRulesMock = vi.fn();
const fetchPeriodAggregatesMock = vi.fn();
const listBuildersWithEventsMock = vi.fn();
const loadModelTierCatalogMock = vi.fn();

vi.mock('../../src/lib/anomaly/repository.js', () => ({
  insertAnomalyEvent: vi.fn(),
  expireStaleAnomalies: vi.fn().mockResolvedValue(0),
  isInCooldown: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../src/lib/alerts/builder-alert.js', () => ({
  deliverBuilderAlert: vi.fn(),
}));

vi.mock('../../src/lib/anomaly/clickhouse-queries.js', () => ({
  fetchPeriodAggregates: fetchPeriodAggregatesMock,
  listBuildersWithEvents: listBuildersWithEventsMock,
}));

vi.mock('../../src/lib/anomaly/model-tier-catalog.js', () => ({
  loadModelTierCatalog: loadModelTierCatalogMock,
}));

vi.mock('../../src/lib/customers/lookup.js', () => ({
  listCustomersWithOpenPricing: vi.fn(async () => []),
}));

vi.mock('../../src/lib/rules/margin-evaluator.js', () => ({
  evaluateMarginRules: evaluateMarginRulesMock,
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}));

const { detectAnomalies } = await import('../../src/lib/anomaly/runner.js');

const NOW = new Date('2026-04-26T12:00:00Z');
const BUILDER_ID = '00000000-0000-0000-0000-000000000001';
const CATALOG = { catalog: true };

function emptyAggregate() {
  return {
    total_cost_usd: 0,
    total_tokens_in: 0,
    total_tokens_out: 0,
    all: { steps: [], models: [], sources: [] },
    byCustomer: new Map(),
    costByCustomer: new Map(),
  };
}

function marginSummary(overrides: Record<string, number> = {}) {
  return {
    rules_evaluated: 1,
    anomalies_inserted: 0,
    anomalies_skipped_idempotent: 0,
    alerts_fired: 0,
    customers_skipped_insufficient_revenue: 0,
    ...overrides,
  };
}

describe('detect-anomalies runner — margin wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadModelTierCatalogMock.mockResolvedValue(CATALOG);
    fetchPeriodAggregatesMock.mockResolvedValue(emptyAggregate());
    evaluateMarginRulesMock.mockResolvedValue(marginSummary());
  });

  it('evaluates margin rules per builder with the shared catalog', async () => {
    listBuildersWithEventsMock.mockResolvedValue([
      { builderId: BUILDER_ID, earliestEvent: new Date('2026-01-01T00:00:00Z') },
    ]);

    await detectAnomalies({ now: NOW });

    expect(evaluateMarginRulesMock).toHaveBeenCalledTimes(1);
    expect(evaluateMarginRulesMock).toHaveBeenCalledWith({
      builderId: BUILDER_ID,
      catalog: CATALOG,
      now: NOW,
    });
  });

  it('still evaluates margin rules for cold-start builders (margin is config, not baseline)', async () => {
    listBuildersWithEventsMock.mockResolvedValue([
      // 2 days of telemetry — inside the 7-day spike/drop cold-start gate.
      { builderId: BUILDER_ID, earliestEvent: new Date('2026-04-24T12:00:00Z') },
    ]);

    const result = await detectAnomalies({ now: NOW });

    expect(result.cold_start_skipped).toBe(1);
    expect(evaluateMarginRulesMock).toHaveBeenCalledTimes(1);
    // Cold start skips the aggregate fetches entirely.
    expect(fetchPeriodAggregatesMock).not.toHaveBeenCalled();
  });

  it('folds margin anomaly counters into the run result', async () => {
    listBuildersWithEventsMock.mockResolvedValue([
      { builderId: BUILDER_ID, earliestEvent: new Date('2026-04-24T12:00:00Z') },
    ]);
    evaluateMarginRulesMock.mockResolvedValue(
      marginSummary({ anomalies_inserted: 2, anomalies_skipped_idempotent: 1 }),
    );

    const result = await detectAnomalies({ now: NOW });

    expect(result.anomalies_inserted).toBe(2);
    expect(result.anomalies_skipped_idempotent).toBe(1);
  });

  it('isolates margin evaluation failures from spike/drop detection', async () => {
    listBuildersWithEventsMock.mockResolvedValue([
      { builderId: BUILDER_ID, earliestEvent: new Date('2026-01-01T00:00:00Z') },
    ]);
    evaluateMarginRulesMock.mockRejectedValue(new Error('margin exploded'));

    const result = await detectAnomalies({ now: NOW });

    // Not an errored builder — the spike/drop pass still ran.
    expect(result.errors).toBe(0);
    expect(result.scanned_builders).toBe(1);
    expect(fetchPeriodAggregatesMock).toHaveBeenCalled();
  });
});
