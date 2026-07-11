// Regression test for bug_012: the anomaly cron must persist the bare
// EXTERNAL customer id, not the composite ClickHouse key
// (`<builderId>:<external>`).
//
// cost_events.customer_id is stored as `<builderId>:<external>` for tenant
// isolation. The runner indexes its period aggregates by that composite key,
// but everything downstream expects the bare external id:
//   - convert-to-rule copies anomaly.customer_id verbatim into
//     rules.customer_id, which is external-by-convention (preview re-prefixes
//     the builder id). A composite value makes the materialized model-routing
//     rule's scope filter double-prefixed -> it matches zero events and the
//     cost-saving rule silently never fires.
//   - the per-customer anomaly drill-down filters on the external id, so
//     composite-stored rows are invisible.
//   - `customerIdSchema` forbids the ':' a composite carries, so the draft
//     rule's match.customer_id would be rejected if ever re-validated.
//
// The fix derives the external id in the runner while keeping the composite
// key for the aggregate lookups. This test pins both the persisted
// customer_id AND the recommendation's draft-rule match to the external id.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  AnomalyRecommendationAction,
  AnomalySourceType,
  AnomalyStatus,
  type AnomalyEvent,
} from '@pylva/shared';
import type { InsertAnomalyEventInput } from '../../src/lib/anomaly/repository.js';

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
const EXTERNAL_ID = 'acme';
const COMPOSITE_ID = `${BUILDER_ID}:${EXTERNAL_ID}`;

interface ModelSlice {
  provider: string;
  model: string;
  cost_usd: number;
}

// Aggregate whose per-customer maps are keyed by the COMPOSITE id, exactly
// as fetchPeriodAggregates produces them from cost_events.
function makeAggregate(builderTotal: number, customerCost: number, models: ModelSlice[]) {
  const slices = { steps: [], models, sources: [] };
  return {
    total_cost_usd: builderTotal,
    total_tokens_in: 0,
    total_tokens_out: 0,
    all: slices,
    byCustomer: new Map([[COMPOSITE_ID, slices]]),
    costByCustomer: new Map([[COMPOSITE_ID, customerCost]]),
  };
}

function echoInsertedRow(input: InsertAnomalyEventInput): AnomalyEvent {
  return {
    id: 'a-inserted',
    builder_id: input.builder_id,
    customer_id: input.customer_id,
    source_type: input.source_type,
    status: AnomalyStatus.OPEN,
    severity: input.severity!,
    period_start: input.period_start,
    period_end: input.period_end,
    actual_value: input.actual_value ?? null,
    baseline_value: input.baseline_value ?? null,
    delta_pct: input.delta_pct ?? null,
    diagnosis: input.diagnosis,
    recommendation: input.recommendation,
    created_at: input.period_end,
    dismissed_at: null,
  };
}

describe('bug_012 - anomaly runner persists external customer_id, not composite', () => {
  beforeEach(() => {
    insertAnomalyEventMock.mockReset();
    deliverBuilderAlertMock.mockReset();
    fetchPeriodAggregatesMock.mockReset();
    listBuildersWithEventsMock.mockReset();
    loadModelTierCatalogMock.mockReset();

    // Catalog with a flagship -> standard downgrade target so the recommender
    // produces CREATE_DRAFT_MODEL_ROUTING_RULE (exercises draft_rule.match).
    loadModelTierCatalogMock.mockResolvedValue({
      byProviderModel: new Map([
        [
          'openai|gpt-4o',
          {
            provider: 'openai',
            model: 'gpt-4o',
            tier: 'flagship',
            input_per_1m_usd: 5,
            output_per_1m_usd: 15,
          },
        ],
        [
          'openai|gpt-4o-mini',
          {
            provider: 'openai',
            model: 'gpt-4o-mini',
            tier: 'standard',
            input_per_1m_usd: 0.15,
            output_per_1m_usd: 0.6,
          },
        ],
      ]),
    });
    listBuildersWithEventsMock.mockResolvedValue([
      { builderId: BUILDER_ID, earliestEvent: new Date('2026-03-01T00:00:00Z') },
    ]);
    insertAnomalyEventMock.mockImplementation((input: InsertAnomalyEventInput) =>
      Promise.resolve(echoInsertedRow(input)),
    );
    deliverBuilderAlertMock.mockResolvedValue(undefined);
  });

  it('stores the external id on the row, the recommendation, and the alert payload', async () => {
    // current >> baseline for the customer bucket -> cost_spike fires.
    fetchPeriodAggregatesMock
      .mockResolvedValueOnce(
        makeAggregate(200, 200, [{ provider: 'openai', model: 'gpt-4o', cost_usd: 200 }]),
      ) // current
      .mockResolvedValueOnce(
        makeAggregate(50, 50, [{ provider: 'openai', model: 'gpt-4o', cost_usd: 50 }]),
      ) // prior
      .mockResolvedValueOnce(
        makeAggregate(50, 50, [{ provider: 'openai', model: 'gpt-4o', cost_usd: 50 }]),
      ); // baseline

    const result = await detectAnomalies({ now: new Date('2026-04-26T12:15:01.123Z') });
    expect(result.anomalies_inserted).toBeGreaterThan(0);

    const calls = insertAnomalyEventMock.mock.calls.map((c) => c[0] as InsertAnomalyEventInput);

    // No persisted customer_id may carry the composite ':' separator.
    for (const input of calls) {
      if (input.customer_id !== null) {
        expect(input.customer_id).not.toContain(':');
      }
    }

    // The customer-scoped anomaly is stored with the bare external id.
    const customerScoped = calls.find((c) => c.customer_id !== null);
    expect(customerScoped).toBeDefined();
    expect(customerScoped!.customer_id).toBe(EXTERNAL_ID);

    // And its draft model-routing rule matches the external id - otherwise
    // convert-to-rule would mint a rule that never fires.
    const rec = customerScoped!.recommendation;
    expect(rec.action).toBe(AnomalyRecommendationAction.CREATE_DRAFT_MODEL_ROUTING_RULE);
    expect(rec.draft_rule?.match.customer_id).toBe(EXTERNAL_ID);

    // The dispatched alert payload carries the external id too (no UUID leak).
    expect(deliverBuilderAlertMock).toHaveBeenCalled();
    for (const [arg] of deliverBuilderAlertMock.mock.calls) {
      const cid = (arg as { payload: { data: { customer_id: string | null } } }).payload.data
        .customer_id;
      if (cid !== null) expect(cid).not.toContain(':');
    }
  });

  it('covers the cost_spike source_type', async () => {
    fetchPeriodAggregatesMock
      .mockResolvedValueOnce(
        makeAggregate(200, 200, [{ provider: 'openai', model: 'gpt-4o', cost_usd: 200 }]),
      )
      .mockResolvedValueOnce(
        makeAggregate(50, 50, [{ provider: 'openai', model: 'gpt-4o', cost_usd: 50 }]),
      )
      .mockResolvedValueOnce(
        makeAggregate(50, 50, [{ provider: 'openai', model: 'gpt-4o', cost_usd: 50 }]),
      );

    await detectAnomalies({ now: new Date('2026-04-26T12:15:01.123Z') });
    const calls = insertAnomalyEventMock.mock.calls.map((c) => c[0] as InsertAnomalyEventInput);
    expect(calls.some((c) => c.source_type === AnomalySourceType.COST_SPIKE)).toBe(true);
  });
});
