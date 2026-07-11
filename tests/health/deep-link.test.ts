// Deep-link routing for the new INSTRUMENTATION_* webhook event types added
// in B3-T4b. Verifies cost_sources page routing + source_slug query param.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/lib/config.js', () => ({
  env: { OAUTH_REDIRECT_BASE_URL: 'https://example.test' },
}));

const { buildDashboardDeepLink } = await import('../../src/lib/alerts/deep-link.js');

describe('buildDashboardDeepLink — INSTRUMENTATION_* routing', () => {
  it('routes INSTRUMENTATION_SILENCE to cost-sources with source_slug', () => {
    const url = buildDashboardDeepLink(
      {
        type: 'instrumentation.silence',
        data: {
          source_slug: 'openai',
          source_display_name: 'OpenAI',
          last_seen_at: '2026-04-23T10:00:00Z',
          silent_hours: 50,
          longest_historical_gap_hours: 12,
        },
      } as never,
      'acme',
    );
    expect(url).toBe('https://example.test/o/acme/dashboard/cost-sources?source=openai');
  });

  it('routes INSTRUMENTATION_COST_DROP the same way', () => {
    const url = buildDashboardDeepLink(
      {
        type: 'instrumentation.cost_drop',
        data: {
          source_slug: 'elevenlabs',
          source_display_name: 'ElevenLabs',
          rolling_7d_avg_usd: 1,
          rolling_30d_avg_usd: 100,
          drop_percent: 99,
        },
      } as never,
      'acme',
    );
    expect(url).toBe('https://example.test/o/acme/dashboard/cost-sources?source=elevenlabs');
  });

  it('falls back to cost-sources index when source_slug is missing', () => {
    const url = buildDashboardDeepLink(
      {
        type: 'instrumentation.health',
        data: {},
      } as never,
      'acme',
    );
    expect(url).toBe('https://example.test/o/acme/dashboard/cost-sources');
  });

  it('does not affect existing customer-scoped routing', () => {
    const url = buildDashboardDeepLink(
      {
        type: 'cost.threshold_exceeded',
        data: { customer_id: 'cust_1' },
      } as never,
      'acme',
    );
    expect(url).toBe('https://example.test/o/acme/dashboard/end-users/cust_1');
  });
});
