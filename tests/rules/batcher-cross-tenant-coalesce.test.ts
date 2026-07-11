// Regression: the 60s alert batcher must NOT coalesce two builders' fires into
// one batch. channelConfigKey originally keyed only on the channel target
// (slack_webhook_url / sorted email recipients / webhook_config_id). Neither
// slack_webhook_url nor email_recipients carries DB uniqueness across builders
// (schema.ts), so two tenants can configure the SAME Slack URL or recipient
// list. When both fired within the window, the second builder's payload was
// pushed into the first's pending batch and delivered + written to
// alert_history under the FIRST builder's id (the deliver callback closes over
// builder A's builder_id in deliverAlert) — a cross-tenant isolation break (R7).
// The fix prefixes the key with the payload's builder_id.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AlertDeliveryChannel,
  WebhookEventType,
  type AlertChannelEntry,
  type AlertPayload,
  type BatchedAlertPayload,
} from '@pylva/shared';

// Mock the logger so importing the batcher doesn't pull in the env-validated
// config module (createEnv throws without a full server env in unit tests).
vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));
import {
  schedule,
  flushAll,
  _resetBatcherForTests,
  _pendingSizeForTests,
} from '../../src/lib/alerts/batcher.js';

const SHARED_SLACK_URL = 'https://hooks.slack.com/services/T000/B000/shared';
const SHARED_EMAIL_RECIPIENTS = ['alerts@example.com', 'ops@example.com'];

function slackEntry(ruleId: string): AlertChannelEntry {
  return {
    id: `chan-${ruleId}`,
    rule_id: ruleId,
    channel: AlertDeliveryChannel.SLACK,
    enabled: true,
    slack_webhook_url: SHARED_SLACK_URL,
    created_at: new Date('2026-06-24T00:00:00Z'),
    updated_at: new Date('2026-06-24T00:00:00Z'),
  };
}

function emailEntry(ruleId: string, recipients = SHARED_EMAIL_RECIPIENTS): AlertChannelEntry {
  return {
    id: `chan-email-${ruleId}`,
    rule_id: ruleId,
    channel: AlertDeliveryChannel.EMAIL,
    enabled: true,
    email_recipients: recipients,
    created_at: new Date('2026-06-24T00:00:00Z'),
    updated_at: new Date('2026-06-24T00:00:00Z'),
  };
}

function costPayload(builderId: string, ruleId: string): AlertPayload {
  return {
    version: '1.0',
    rule_id: ruleId,
    fired_at: '2026-06-24T00:00:00Z',
    payload: {
      id: `evt-${builderId}-${ruleId}`,
      type: WebhookEventType.COST_THRESHOLD_EXCEEDED,
      builder_id: builderId,
      timestamp: '2026-06-24T00:00:00Z',
      data: {
        customer_id: null,
        threshold_usd: 100,
        current_usd: 120,
        period: 'month',
        rule_id: ruleId,
      },
    },
  };
}

afterEach(() => {
  _resetBatcherForTests();
});

describe('batcher cross-tenant coalescing', () => {
  it('keeps two builders sharing a Slack URL in separate batches', () => {
    schedule(slackEntry('rule-a'), costPayload('builder-a', 'rule-a'), async () => {});
    schedule(slackEntry('rule-b'), costPayload('builder-b', 'rule-b'), async () => {});

    // Two distinct tenants → two distinct pending batches, never coalesced.
    expect(_pendingSizeForTests()).toBe(2);
  });

  it('keeps two builders sharing an email recipient set in separate batches', () => {
    schedule(emailEntry('rule-a'), costPayload('builder-a', 'rule-a'), async () => {});
    schedule(
      emailEntry('rule-b', [...SHARED_EMAIL_RECIPIENTS].reverse()),
      costPayload('builder-b', 'rule-b'),
      async () => {},
    );

    // Same recipients, different order, different tenants → still separate.
    expect(_pendingSizeForTests()).toBe(2);
  });

  it('flushes one homogeneous batch per tenant — no foreign builder_id mixed in', async () => {
    schedule(slackEntry('rule-a'), costPayload('builder-a', 'rule-a'), async () => {});
    schedule(slackEntry('rule-b'), costPayload('builder-b', 'rule-b'), async () => {});

    const flushed: string[][] = [];
    await flushAll((_entry: AlertChannelEntry, coalesced: AlertPayload | BatchedAlertPayload) => {
      const payloads = 'batch' in coalesced ? coalesced.batch : [coalesced];
      flushed.push(payloads.map((p) => p.payload.builder_id));
      return Promise.resolve();
    });

    // Pre-fix: a single coalesced batch carrying BOTH builder ids → length 1,
    // a Set of size 2. Post-fix: two batches, each homogeneous.
    expect(flushed.length).toBe(2);
    for (const ids of flushed) {
      expect(new Set(ids).size).toBe(1);
    }
    expect(flushed.map((ids) => ids[0]).sort()).toEqual(['builder-a', 'builder-b']);
  });

  it('still coalesces same-builder fires to the same channel target', () => {
    schedule(slackEntry('rule-a'), costPayload('builder-a', 'rule-a'), async () => {});
    schedule(slackEntry('rule-a2'), costPayload('builder-a', 'rule-a2'), async () => {});

    // Same tenant, same Slack URL → one coalesced batch (in-tenant batching kept).
    expect(_pendingSizeForTests()).toBe(1);
  });

  it('keeps same-builder email coalescing for recipient permutations', () => {
    schedule(emailEntry('rule-a'), costPayload('builder-a', 'rule-a'), async () => {});
    schedule(
      emailEntry('rule-a2', [...SHARED_EMAIL_RECIPIENTS].reverse()),
      costPayload('builder-a', 'rule-a2'),
      async () => {},
    );

    expect(_pendingSizeForTests()).toBe(1);
  });

  it('awaits async delivery work during flushAll', async () => {
    schedule(slackEntry('rule-a'), costPayload('builder-a', 'rule-a'), async () => {});

    let resolveDelivery!: () => void;
    const deliveryPromise = new Promise<void>((resolve) => {
      resolveDelivery = resolve;
    });

    let flushSettled = false;
    const flushPromise = flushAll(() => deliveryPromise);
    void flushPromise.then(() => {
      flushSettled = true;
    });

    await Promise.resolve();
    expect(flushSettled).toBe(false);

    resolveDelivery();
    await flushPromise;
    expect(flushSettled).toBe(true);
  });
});
