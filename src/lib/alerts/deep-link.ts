// Shared deep-link construction for alert templates (email + Slack).
// Extracted from duplicated `extractCustomerId` + `deepLink` that had landed
// in both email/alert.ts and slack/block-builder.ts.
//
// Slug enrichment is pending — callers pass `slug = '-'` today; future work
// threads the builder slug from the delivery path.

import { env } from '../config.js';
import { WebhookEventType, type WebhookPayload } from '@pylva/shared';

export function extractCustomerIdFromPayload(payload: WebhookPayload): string | null {
  if ('data' in payload && typeof payload.data === 'object' && payload.data !== null) {
    const d = payload.data as { customer_id?: unknown };
    if (typeof d.customer_id === 'string') return d.customer_id;
  }
  return null;
}

function extractSourceSlug(payload: WebhookPayload): string | null {
  if ('data' in payload && typeof payload.data === 'object' && payload.data !== null) {
    const d = payload.data as { source_slug?: unknown };
    if (typeof d.source_slug === 'string') return d.source_slug;
  }
  return null;
}

export function buildDashboardDeepLink(payload: WebhookPayload, slug = '-'): string {
  const base = env.OAUTH_REDIRECT_BASE_URL;

  if (
    payload.type === WebhookEventType.INSTRUMENTATION_SILENCE ||
    payload.type === WebhookEventType.INSTRUMENTATION_COST_DROP ||
    payload.type === WebhookEventType.INSTRUMENTATION_HEALTH
  ) {
    const sourceSlug = extractSourceSlug(payload);
    return sourceSlug
      ? `${base}/o/${slug}/dashboard/cost-sources?source=${encodeURIComponent(sourceSlug)}`
      : `${base}/o/${slug}/dashboard/cost-sources`;
  }

  if (payload.type === WebhookEventType.ANOMALY_DETECTED) {
    // Always construct from the persisted anomaly id + caller's slug.
    // We previously preferred `recommendation.deep_link_url`, but the
    // recommender ran before insert and stamped a placeholder id +
    // builder UUID (not slug) into the URL — every "Investigate" link
    // 404'd (bug_001). The recommender no longer sets the field.
    return `${base}/o/${slug}/dashboard?anomaly=${encodeURIComponent(payload.data.anomaly_id)}`;
  }

  const customer = extractCustomerIdFromPayload(payload);
  return customer
    ? `${base}/o/${slug}/dashboard/end-users/${encodeURIComponent(customer)}`
    : `${base}/o/${slug}/dashboard/rules/history`;
}
