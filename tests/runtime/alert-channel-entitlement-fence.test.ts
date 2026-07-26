import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AlertDeliveryChannel,
  WebhookEventType,
  type AlertChannelEntry,
  type AlertPayload,
} from '@pylva/shared';

const mocks = vi.hoisted(() => ({
  authorizeBuilderCapability: vi.fn(),
  configRows: vi.fn(),
  externalFetch: vi.fn(),
  resendSend: vi.fn(),
  withProductAccessMutation: vi.fn(),
  writeToDlq: vi.fn(),
}));

vi.mock('../../src/lib/auth/builder-entitlement.js', () => ({
  authorizeBuilderCapability: mocks.authorizeBuilderCapability,
}));

vi.mock('../../src/lib/auth/product-access-mutation.js', () => ({
  isProductAccessMutationDeniedError: (error: unknown) =>
    error instanceof Error &&
    (error as Error & { code?: unknown }).code === 'product_access_mutation_denied',
  withProductAccessMutation: mocks.withProductAccessMutation,
}));

vi.mock('../../src/lib/db/rls.js', () => ({
  withRLS: (_builderId: string, callback: (tx: unknown) => Promise<unknown>) =>
    callback({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => mocks.configRows(),
          }),
        }),
      }),
    }),
}));

vi.mock('../../src/lib/db/schema.js', () => ({
  webhookConfigs: {
    id: { name: 'id' },
    builder_id: { name: 'builder_id' },
    url: { name: 'url' },
    secret: { name: 'secret' },
    events: { name: 'events' },
  },
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn(() => ({})),
  eq: vi.fn(() => ({})),
}));

vi.mock('../../src/lib/external-egress.js', () => ({
  externalFetch: mocks.externalFetch,
}));

vi.mock('../../src/lib/alerts/dlq.js', () => ({
  writeToDlq: mocks.writeToDlq,
}));

vi.mock('../../src/lib/config.js', () => ({
  env: {
    RESEND_API_KEY: 're_test_key',
    ALERT_FROM_EMAIL: 'alerts@pylva.com',
  },
}));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: mocks.resendSend };
  },
}));

vi.mock('../../src/lib/alerts/templates/email/alert.js', () => ({
  renderAlertEmail: vi.fn(() => ({ subject: 'Alert', html: '<p>Alert</p>' })),
}));

vi.mock('../../src/lib/alerts/templates/slack/block-builder.js', () => ({
  buildAlertBlocks: vi.fn(() => []),
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }),
  },
}));

const { deliverWebhook } = await import('../../src/lib/alerts/channels/webhook.js');
const { deliverEmail } = await import('../../src/lib/alerts/channels/email.js');
const { deliverSlack } = await import('../../src/lib/alerts/channels/slack.js');
const { AlertDeliveryAccessDeniedError } =
  await import('../../src/lib/alerts/entitlement-fence.js');

const payload: AlertPayload = {
  version: '1.0',
  rule_id: 'rule-a',
  fired_at: '2026-07-23T00:00:00.000Z',
  payload: {
    id: 'event-a',
    type: WebhookEventType.COST_THRESHOLD_EXCEEDED,
    builder_id: 'builder-a',
    timestamp: '2026-07-23T00:00:00.000Z',
    data: {
      customer_id: null,
      threshold_usd: 10,
      current_usd: 12,
      period: 'day',
      rule_id: 'rule-a',
    },
  },
};

const context = { builder_id: 'builder-a', rule_id: 'rule-a' };

function webhookEntry(): AlertChannelEntry {
  return {
    id: 'channel-webhook',
    rule_id: 'rule-a',
    channel: AlertDeliveryChannel.WEBHOOK,
    enabled: true,
    webhook_config_id: 'webhook-a',
    created_at: new Date('2026-07-23T00:00:00.000Z'),
    updated_at: new Date('2026-07-23T00:00:00.000Z'),
  };
}

function emailEntry(): AlertChannelEntry {
  return {
    id: 'channel-email',
    rule_id: 'rule-a',
    channel: AlertDeliveryChannel.EMAIL,
    enabled: true,
    email_recipients: ['ops@example.com'],
    created_at: new Date('2026-07-23T00:00:00.000Z'),
    updated_at: new Date('2026-07-23T00:00:00.000Z'),
  };
}

function slackEntry(): AlertChannelEntry {
  return {
    id: 'channel-slack',
    rule_id: 'rule-a',
    channel: AlertDeliveryChannel.SLACK,
    enabled: true,
    slack_webhook_url: 'https://hooks.slack.com/services/T/B/X',
    created_at: new Date('2026-07-23T00:00:00.000Z'),
    updated_at: new Date('2026-07-23T00:00:00.000Z'),
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function productAccessDeniedError(): Error {
  const error = new Error('product access denied') as Error & { code: string };
  error.code = 'product_access_mutation_denied';
  return error;
}

let productAccessAllowed = true;

beforeEach(() => {
  vi.clearAllMocks();
  productAccessAllowed = true;
  mocks.authorizeBuilderCapability.mockResolvedValue({ allowed: true });
  mocks.withProductAccessMutation.mockImplementation(
    async (_builderId: string, callback: (tx: unknown) => Promise<unknown>) => {
      if (!productAccessAllowed) throw productAccessDeniedError();
      return callback({});
    },
  );
  mocks.configRows.mockResolvedValue([
    {
      url: 'https://alerts.example.test/webhook',
      secret: 'secret',
      events: ['rule.fired'],
    },
  ]);
  mocks.externalFetch.mockResolvedValue({
    status: 204,
    statusText: 'No Content',
    headers: {},
    body: '',
  });
  mocks.resendSend.mockResolvedValue({ data: { id: 'email-a' }, error: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('alert channel last-attempt lifecycle fence', () => {
  it('sends no webhook when suspension happens while configuration is loading', async () => {
    const config = deferred<Array<{ url: string; secret: string; events: string[] }>>();
    mocks.configRows.mockImplementationOnce(() => config.promise);

    const delivery = deliverWebhook([payload], webhookEntry(), context);
    await vi.waitFor(() => expect(mocks.configRows).toHaveBeenCalledTimes(1));

    productAccessAllowed = false;
    config.resolve([
      {
        url: 'https://alerts.example.test/webhook',
        secret: 'secret',
        events: ['rule.fired'],
      },
    ]);

    await expect(delivery).rejects.toBeInstanceOf(AlertDeliveryAccessDeniedError);
    expect(mocks.externalFetch).not.toHaveBeenCalled();
    expect(mocks.writeToDlq).not.toHaveBeenCalled();
  });

  it('sends no email when access is denied at the outbound attempt boundary', async () => {
    productAccessAllowed = false;

    await expect(deliverEmail([payload], emailEntry(), context)).rejects.toBeInstanceOf(
      AlertDeliveryAccessDeniedError,
    );

    expect(mocks.resendSend).not.toHaveBeenCalled();
    expect(mocks.writeToDlq).not.toHaveBeenCalled();
  });

  it('does not make another Slack attempt when suspended during retry backoff', async () => {
    vi.useFakeTimers();
    const firstAttempt = deferred<never>();
    const attemptStarted = deferred<void>();
    const firstTransactionExited = deferred<void>();
    mocks.withProductAccessMutation.mockImplementationOnce(
      async (_builderId: string, callback: (tx: unknown) => Promise<unknown>) => {
        try {
          return await callback({});
        } finally {
          firstTransactionExited.resolve();
        }
      },
    );
    mocks.externalFetch.mockImplementationOnce(() => {
      attemptStarted.resolve();
      return firstAttempt.promise;
    });

    const delivery = deliverSlack([payload], slackEntry(), context);
    const rejection = expect(delivery).rejects.toBeInstanceOf(AlertDeliveryAccessDeniedError);
    await attemptStarted.promise;

    firstAttempt.reject(new Error('network reset'));
    await firstTransactionExited.promise;
    productAccessAllowed = false;
    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
    expect(mocks.externalFetch).toHaveBeenCalledTimes(1);
    expect(mocks.writeToDlq).not.toHaveBeenCalled();
  });

  it('retries an entitlement lookup outage instead of treating it as suspension', async () => {
    vi.useFakeTimers();
    mocks.withProductAccessMutation.mockRejectedValueOnce(new Error('postgres unavailable'));

    const delivery = deliverSlack([payload], slackEntry(), context);
    const completion = expect(delivery).resolves.toMatchObject({ ok: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.externalFetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await completion;

    expect(mocks.withProductAccessMutation).toHaveBeenCalledTimes(2);
    expect(mocks.externalFetch).toHaveBeenCalledTimes(1);
    expect(mocks.writeToDlq).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'webhook',
      start: () => deliverWebhook([payload], webhookEntry(), context),
      outbound: mocks.externalFetch,
      response: {
        status: 204,
        statusText: 'No Content',
        headers: {},
        body: '',
      },
    },
    {
      name: 'email',
      start: () => deliverEmail([payload], emailEntry(), context),
      outbound: mocks.resendSend,
      response: { data: { id: 'email-a' }, error: null },
    },
    {
      name: 'slack',
      start: () => deliverSlack([payload], slackEntry(), context),
      outbound: mocks.externalFetch,
      response: {
        status: 204,
        statusText: 'No Content',
        headers: {},
        body: '',
      },
    },
  ])(
    'holds the lifecycle lock through one $name attempt before suspension can commit',
    async ({ start, outbound, response }) => {
      const network = deferred<typeof response>();
      const lockAcquired = deferred<void>();
      const lockReleased = deferred<void>();
      let lockHeld = false;

      mocks.withProductAccessMutation.mockImplementationOnce(
        async (_builderId: string, callback: (tx: unknown) => Promise<unknown>) => {
          if (!productAccessAllowed) throw productAccessDeniedError();
          lockHeld = true;
          lockAcquired.resolve();
          try {
            return await callback({});
          } finally {
            lockHeld = false;
            lockReleased.resolve();
          }
        },
      );
      outbound.mockImplementationOnce(() => network.promise);

      const delivery = start();
      await lockAcquired.promise;
      await vi.waitFor(() => expect(outbound).toHaveBeenCalledTimes(1));

      let suspensionCommitted = false;
      const suspension = (async () => {
        if (lockHeld) await lockReleased.promise;
        productAccessAllowed = false;
        suspensionCommitted = true;
      })();
      await Promise.resolve();

      expect(suspensionCommitted).toBe(false);
      network.resolve(response);
      await expect(delivery).resolves.toMatchObject({ ok: true });
      await suspension;

      expect(suspensionCommitted).toBe(true);
      expect(mocks.withProductAccessMutation).toHaveBeenCalledTimes(1);
    },
  );
});
