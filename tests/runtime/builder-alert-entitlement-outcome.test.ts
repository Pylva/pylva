import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebhookPayload } from '@pylva/shared';

const mocks = vi.hoisted(() => ({
  authorizeBuilderCapability: vi.fn(),
  deliverEmail: vi.fn(),
  deliverSlack: vi.fn(),
  deliverWebhook: vi.fn(),
  withRLS: vi.fn(),
}));

vi.mock('../../src/lib/auth/builder-entitlement.js', () => ({
  authorizeBuilderCapability: mocks.authorizeBuilderCapability,
}));

vi.mock('../../src/lib/auth/product-access-mutation.js', () => ({
  isProductAccessMutationDeniedError: vi.fn(() => false),
  withProductAccessMutation: vi.fn(),
}));

vi.mock('../../src/lib/alerts/channels/email.js', () => ({
  deliverEmail: mocks.deliverEmail,
}));

vi.mock('../../src/lib/alerts/channels/slack.js', () => ({
  deliverSlack: mocks.deliverSlack,
}));

vi.mock('../../src/lib/alerts/channels/webhook.js', () => ({
  deliverWebhook: mocks.deliverWebhook,
}));

vi.mock('../../src/lib/db/rls.js', () => ({
  withRLS: mocks.withRLS,
}));

vi.mock('../../src/lib/db/schema.js', () => ({
  builderAlertConfig: {
    builder_id: { name: 'builder_id' },
    channel: { name: 'channel' },
    enabled: { name: 'enabled' },
    webhook_config_id: { name: 'webhook_config_id' },
    email_recipients: { name: 'email_recipients' },
    slack_webhook_url: { name: 'slack_webhook_url' },
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})),
}));

vi.mock('../../src/lib/auth/audit-log.js', () => ({
  auditLog: vi.fn(),
}));

vi.mock('../../src/lib/audit/actions.js', () => ({
  AuditAction: { ALERT_SKIPPED_NO_CONFIG: 'alert.skipped_no_config' },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }),
  },
}));

const { deliverBuilderAlert } = await import('../../src/lib/alerts/builder-alert.js');
const { AlertDeliveryEntitlementLookupError } =
  await import('../../src/lib/alerts/entitlement-fence.js');

const payload = {
  id: 'event-a',
  type: 'budget_exceeded',
  builder_id: 'builder-a',
  timestamp: '2026-07-23T00:00:00.000Z',
  data: {},
} as unknown as WebhookPayload;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeBuilderCapability.mockResolvedValue({ allowed: true });
  mocks.deliverEmail.mockResolvedValue({ ok: true, attempts: 1 });
  mocks.deliverSlack.mockResolvedValue({ ok: true, attempts: 1 });
  mocks.deliverWebhook.mockResolvedValue({ ok: true, attempts: 1 });
  mocks.withRLS.mockImplementation(
    async (_builderId: string, callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => [
                {
                  channel: 'slack',
                  enabled: true,
                  webhook_config_id: null,
                  email_recipients: null,
                  slack_webhook_url: 'https://hooks.slack.com/services/T/B/X',
                },
              ],
            }),
          }),
        }),
      }),
  );
});

describe('builder alert lifecycle outcome', () => {
  it('returns access_denied without loading config for a suspended workspace', async () => {
    mocks.authorizeBuilderCapability.mockResolvedValue({ allowed: false });

    await expect(deliverBuilderAlert({ builderId: 'builder-a', payload })).resolves.toEqual({
      kind: 'access_denied',
    });

    expect(mocks.withRLS).not.toHaveBeenCalled();
    expect(mocks.deliverSlack).not.toHaveBeenCalled();
  });

  it('reports the successful channel attempt without an unlocked post-send recheck', async () => {
    mocks.authorizeBuilderCapability
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValue({ allowed: false });

    await expect(deliverBuilderAlert({ builderId: 'builder-a', payload })).resolves.toEqual({
      kind: 'delivered',
    });

    expect(mocks.deliverSlack).toHaveBeenCalledTimes(1);
    expect(mocks.authorizeBuilderCapability).toHaveBeenCalledTimes(1);
  });

  it('fails distinctly when authoritative entitlement lookup is unavailable', async () => {
    mocks.authorizeBuilderCapability.mockResolvedValue({
      allowed: false,
      lookup: { kind: 'lookup_failed' },
    });

    await expect(deliverBuilderAlert({ builderId: 'builder-a', payload })).rejects.toBeInstanceOf(
      AlertDeliveryEntitlementLookupError,
    );

    expect(mocks.withRLS).not.toHaveBeenCalled();
    expect(mocks.deliverSlack).not.toHaveBeenCalled();
  });
});
