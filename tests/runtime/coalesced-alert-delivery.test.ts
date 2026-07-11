import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AlertDeliveryChannel,
  WebhookEventType,
  type AlertChannelEntry,
  type AlertPayload,
  type BatchedAlertPayload,
} from '@pylva/shared';

const mocks = vi.hoisted(() => ({
  deliverWebhook: vi.fn(),
  deliverEmail: vi.fn(),
  deliverSlack: vi.fn(),
  withRLS: vi.fn(),
  historyRows: [] as Array<{ rlsBuilderId: string; values: Record<string, unknown> }>,
}));

vi.mock('../../src/lib/alerts/channels/webhook.js', () => ({
  deliverWebhook: mocks.deliverWebhook,
}));

vi.mock('../../src/lib/alerts/channels/email.js', () => ({
  deliverEmail: mocks.deliverEmail,
}));

vi.mock('../../src/lib/alerts/channels/slack.js', () => ({
  deliverSlack: mocks.deliverSlack,
}));

vi.mock('../../src/lib/db/rls.js', () => ({
  withRLS: mocks.withRLS,
}));

vi.mock('../../src/lib/db/schema.js', () => ({
  alertHistory: { name: 'alert_history' },
}));

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

const { deliverCoalescedAlert } = await import('../../src/lib/alerts/delivery.js');

function webhookEntry(ruleId: string): AlertChannelEntry {
  return {
    id: `chan-webhook-${ruleId}`,
    rule_id: ruleId,
    channel: AlertDeliveryChannel.WEBHOOK,
    enabled: true,
    webhook_config_id: `webhook-${ruleId}`,
    created_at: new Date('2026-06-24T00:00:00Z'),
    updated_at: new Date('2026-06-24T00:00:00Z'),
  };
}

function slackEntry(ruleId: string): AlertChannelEntry {
  return {
    id: `chan-slack-${ruleId}`,
    rule_id: ruleId,
    channel: AlertDeliveryChannel.SLACK,
    enabled: true,
    slack_webhook_url: 'https://hooks.slack.com/services/T000/B000/shared',
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.historyRows.length = 0;
  mocks.deliverWebhook.mockResolvedValue({ ok: true, attempts: 1 });
  mocks.deliverEmail.mockResolvedValue({ ok: true, attempts: 1 });
  mocks.deliverSlack.mockResolvedValue({ ok: true, attempts: 1 });
  mocks.withRLS.mockImplementation(
    async (builderId: string, cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        insert: (_table: unknown) => ({
          values: async (values: Record<string, unknown>) => {
            mocks.historyRows.push({ rlsBuilderId: builderId, values });
          },
        }),
      }),
  );
});

describe('coalesced alert delivery', () => {
  it('uses the payload builder_id for webhook flush delivery and alert_history', async () => {
    const payload = costPayload('builder-a', 'rule-a');
    const entry = webhookEntry('rule-a');

    await deliverCoalescedAlert(entry, payload);

    expect(mocks.deliverWebhook).toHaveBeenCalledWith([payload], entry, {
      builder_id: 'builder-a',
      rule_id: 'rule-a',
    });
    expect(mocks.withRLS).toHaveBeenCalledWith('builder-a', expect.any(Function));
    expect(mocks.historyRows).toHaveLength(1);
    expect(mocks.historyRows[0]).toMatchObject({
      rlsBuilderId: 'builder-a',
      values: {
        builder_id: 'builder-a',
        rule_id: 'rule-a',
        delivery_status: { webhook: { ok: true, attempts: 1, last_error: null } },
      },
    });
  });

  it('splits a mixed-builder coalesced payload before channel delivery and history writes', async () => {
    const payloadA = costPayload('builder-a', 'rule-a');
    const payloadB = costPayload('builder-b', 'rule-b');
    const coalesced: BatchedAlertPayload = {
      version: '1.0',
      batch: [payloadA, payloadB],
      count: 2,
      fired_at: payloadA.fired_at,
    };
    const entry = slackEntry('rule-a');

    await deliverCoalescedAlert(entry, coalesced);

    expect(mocks.deliverSlack).toHaveBeenCalledTimes(2);
    expect(mocks.deliverSlack).toHaveBeenNthCalledWith(1, [payloadA], entry, {
      builder_id: 'builder-a',
      rule_id: 'rule-a',
    });
    expect(mocks.deliverSlack).toHaveBeenNthCalledWith(2, [payloadB], entry, {
      builder_id: 'builder-b',
      rule_id: 'rule-b',
    });
    expect(mocks.historyRows.map((row) => row.rlsBuilderId).sort()).toEqual([
      'builder-a',
      'builder-b',
    ]);
    expect(mocks.historyRows.map((row) => row.values.builder_id).sort()).toEqual([
      'builder-a',
      'builder-b',
    ]);
  });
});
