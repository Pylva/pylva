// Verifies anomaly-typed payloads always route to the cost-dashboard
// `?anomaly={id}` deep link assembled from the persisted anomaly id +
// caller's slug. The recommendation's `deep_link_url` (if any legacy
// row still carries one) is intentionally ignored — the recommender
// runs before insert, doesn't know the real id, and historically
// stamped a placeholder + builder UUID that 404'd in production
// (bug_001).

import { describe, it, expect, vi } from 'vitest';
import {
  AnomalyRecommendationAction,
  AnomalySeverity,
  AnomalySourceType,
  WebhookEventType,
  type AnomalyDetectedPayload,
} from '@pylva/shared';

vi.mock('../../src/lib/config.js', () => ({
  env: { OAUTH_REDIRECT_BASE_URL: 'https://app.example.com' },
}));

const { buildDashboardDeepLink } = await import('../../src/lib/alerts/deep-link.js');

const BASE: AnomalyDetectedPayload = {
  id: 'evt-1',
  type: WebhookEventType.ANOMALY_DETECTED,
  builder_id: 'b-1',
  timestamp: new Date('2026-04-26T12:00:00Z').toISOString(),
  data: {
    anomaly_id: 'a-1',
    customer_id: null,
    source_type: AnomalySourceType.COST_SPIKE,
    severity: AnomalySeverity.WARN,
    actual_value: 120,
    baseline_value: 100,
    delta_pct: 20,
    period_start: '2026-04-25T00:00:00.000Z',
    period_end: '2026-04-26T00:00:00.000Z',
    diagnosis: {},
    recommendation: { action: AnomalyRecommendationAction.INVESTIGATE_DEEP_LINK },
  },
};

describe('buildDashboardDeepLink — ANOMALY_DETECTED', () => {
  it('always assembles from the persisted anomaly id + caller slug', () => {
    expect(buildDashboardDeepLink(BASE, 'acme')).toBe(
      'https://app.example.com/o/acme/dashboard?anomaly=a-1',
    );
  });

  it('ignores any legacy `deep_link_url` on the recommendation (bug_001 regression)', () => {
    const payload: AnomalyDetectedPayload = {
      ...BASE,
      data: {
        ...BASE.data,
        recommendation: {
          action: AnomalyRecommendationAction.INVESTIGATE_DEEP_LINK,
          // Older rows may still carry this — the broken UUID-as-slug
          // shape that bug_001 produced. Assert the dispatcher does
          // NOT honor it.
          deep_link_url: '/o/00000000-0000-0000-0000-000000000bad/dashboard?anomaly=pending-x-1',
        },
      },
    };
    expect(buildDashboardDeepLink(payload, 'acme')).toBe(
      'https://app.example.com/o/acme/dashboard?anomaly=a-1',
    );
  });
});
