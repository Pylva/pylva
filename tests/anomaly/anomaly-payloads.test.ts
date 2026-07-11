// Pure-unit coverage of `buildAnomalyDetectedPayload` — verifies the
// wire-shape webhook receivers will see, plus the deep_link_url passes
// through from the recommendation.

import { describe, it, expect } from 'vitest';
import {
  AnomalyRecommendationAction,
  AnomalySeverity,
  AnomalyStatus,
  AnomalySourceType,
  DriverKind,
  WebhookEventType,
  type AnomalyEvent,
} from '@pylva/shared';
import { buildAnomalyDetectedPayload } from '../../src/lib/alerts/anomaly-payloads.js';

const ANOMALY: AnomalyEvent = {
  id: '00000000-0000-0000-0000-0000000000aa',
  builder_id: '00000000-0000-0000-0000-000000000001',
  customer_id: 'cust-acme',
  source_type: AnomalySourceType.COST_SPIKE,
  status: AnomalyStatus.OPEN,
  severity: AnomalySeverity.WARN,
  period_start: new Date('2026-04-25T00:00:00Z'),
  period_end: new Date('2026-04-26T00:00:00Z'),
  actual_value: 120,
  baseline_value: 100,
  delta_pct: 20,
  diagnosis: {
    top_drivers: [
      {
        kind: DriverKind.MODEL,
        label: 'openai/gpt-4o',
        delta_usd: 12,
        provider: 'openai',
        model: 'gpt-4o',
      },
    ],
    iteration_inflation: { step_name: 'summarize', from: 1, to: 5 },
  },
  recommendation: {
    action: AnomalyRecommendationAction.CREATE_DRAFT_MODEL_ROUTING_RULE,
    projected_savings_usd: 7.5,
    ab_suggestion: { traffic_pct: 10, rationale: 'Try routing 10% first.' },
    // bug_001: recommender no longer stamps deep_link_url; the
    // dispatcher constructs it from the persisted anomaly id at fire
    // time via `src/lib/alerts/deep-link.ts`.
  },
  created_at: new Date('2026-04-26T00:30:00Z'),
  dismissed_at: null,
};

describe('buildAnomalyDetectedPayload', () => {
  it('produces a wire-shape payload with the diagnosis + recommendation', () => {
    const payload = buildAnomalyDetectedPayload(ANOMALY.builder_id, ANOMALY);
    expect(payload.type).toBe(WebhookEventType.ANOMALY_DETECTED);
    expect(payload.builder_id).toBe(ANOMALY.builder_id);
    expect(payload.data.anomaly_id).toBe(ANOMALY.id);
    expect(payload.data.customer_id).toBe('cust-acme');
    expect(payload.data.source_type).toBe(AnomalySourceType.COST_SPIKE);
    expect(payload.data.severity).toBe(AnomalySeverity.WARN);
    expect(payload.data.actual_value).toBe(120);
    expect(payload.data.delta_pct).toBe(20);
    expect(payload.data.diagnosis.top_drivers).toEqual(ANOMALY.diagnosis.top_drivers);
    expect(payload.data.diagnosis.iteration_inflation).toEqual(
      ANOMALY.diagnosis.iteration_inflation,
    );
    expect(payload.data.recommendation.action).toBe(
      AnomalyRecommendationAction.CREATE_DRAFT_MODEL_ROUTING_RULE,
    );
    expect(payload.data.recommendation.projected_savings_usd).toBe(7.5);
    expect(payload.data.recommendation.deep_link_url).toBeUndefined();
  });

  it('serializes period boundaries as ISO 8601 strings', () => {
    const payload = buildAnomalyDetectedPayload(ANOMALY.builder_id, ANOMALY);
    expect(payload.data.period_start).toBe('2026-04-25T00:00:00.000Z');
    expect(payload.data.period_end).toBe('2026-04-26T00:00:00.000Z');
  });

  it('omits absent diagnosis + recommendation fields', () => {
    const minimal: AnomalyEvent = {
      ...ANOMALY,
      diagnosis: { insufficient_revenue_data: true },
      recommendation: { action: AnomalyRecommendationAction.INVESTIGATE_DEEP_LINK },
    };
    const payload = buildAnomalyDetectedPayload(minimal.builder_id, minimal);
    expect(payload.data.diagnosis.top_drivers).toBeUndefined();
    expect(payload.data.diagnosis.iteration_inflation).toBeUndefined();
    expect(payload.data.diagnosis.insufficient_revenue_data).toBe(true);
    expect(payload.data.recommendation.projected_savings_usd).toBeUndefined();
    expect(payload.data.recommendation.deep_link_url).toBeUndefined();
  });
});
