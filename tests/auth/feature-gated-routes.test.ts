import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server.js';
import { ErrorCode, Role } from '@pylva/shared';
import type { TierFeature } from '../../src/lib/auth/tier-enforcement.js';

const mocks = vi.hoisted(() => ({
  addChannel: vi.fn(),
  auditLog: vi.fn(),
  checkBuilderFeatureGate: vi.fn(),
  getRule: vi.fn(),
  listChannelsForRule: vi.fn(),
  removeChannel: vi.fn(),
  stripeAccountLinksCreate: vi.fn(),
  stripeAccountsCreate: vi.fn(),
  stripeAccountsUpdate: vi.fn(),
  tableRows: {} as Record<string, Array<Record<string, unknown>>>,
  withRLS: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ kind: 'and', conditions }),
  desc: (column: unknown) => ({ kind: 'desc', column }),
  eq: (left: unknown, right: unknown) => ({ kind: 'eq', left, right }),
  gte: (left: unknown, right: unknown) => ({ kind: 'gte', left, right }),
  isNotNull: (column: unknown) => ({ kind: 'isNotNull', column }),
  lt: (left: unknown, right: unknown) => ({ kind: 'lt', left, right }),
}));

vi.mock('@/lib/auth/builder-context', () => ({
  readBuilderContextFromDashboard: () => ({
    builderId: 'builder-a',
    userId: 'user-a',
    role: Role.OWNER,
  }),
}));

vi.mock('@/lib/auth/tier-enforcement', () => ({
  checkBuilderFeatureGate: mocks.checkBuilderFeatureGate,
}));

vi.mock('@/lib/auth/middleware', () => ({
  Role,
  withRole: () => null,
}));

vi.mock('@/lib/auth/audit-log', () => ({
  auditLog: mocks.auditLog,
}));

vi.mock('@/lib/audit/actions', () => ({
  AuditAction: new Proxy({}, { get: (_target, prop) => String(prop) }),
}));

vi.mock('@/lib/config', () => ({
  env: {
    OAUTH_REDIRECT_BASE_URL: 'http://localhost',
    PYLVA_BACKEND_URL: 'http://localhost',
  },
}));

vi.mock('@/lib/db/schema', () => ({
  builderAlertConfig: {
    __table: 'builder_alert_config',
    builder_id: { name: 'builder_alert_config.builder_id' },
  },
  customerPricing: {
    __table: 'customer_pricing',
    builder_id: { name: 'customer_pricing.builder_id' },
    stripe_customer_id: { name: 'customer_pricing.stripe_customer_id' },
  },
  customers: {
    __table: 'customers',
    builder_id: { name: 'customers.builder_id' },
    email: { name: 'customers.email' },
    id: { name: 'customers.id' },
  },
  invoices: {
    __table: 'invoices',
    billing_cycle_id: { name: 'invoices.billing_cycle_id' },
    builder_id: { name: 'invoices.builder_id' },
    created_at: { name: 'invoices.created_at' },
    customer_id: { name: 'invoices.customer_id' },
    id: { name: 'invoices.id' },
    period_end: { name: 'invoices.period_end' },
    period_start: { name: 'invoices.period_start' },
    status: { name: 'invoices.status' },
  },
  stripeConnect: {
    __table: 'stripe_connect',
    builder_id: { name: 'stripe_connect.builder_id' },
    capabilities_ok: { name: 'stripe_connect.capabilities_ok' },
    status: { name: 'stripe_connect.status' },
    stripe_account_id: { name: 'stripe_connect.stripe_account_id' },
  },
  webhookConfigs: {
    __table: 'webhook_configs',
    builder_id: { name: 'webhook_configs.builder_id' },
    created_at: { name: 'webhook_configs.created_at' },
    enabled: { name: 'webhook_configs.enabled' },
    events: { name: 'webhook_configs.events' },
    id: { name: 'webhook_configs.id' },
    secret: { name: 'webhook_configs.secret' },
    secret_prior: { name: 'webhook_configs.secret_prior' },
    secret_rotated_at: { name: 'webhook_configs.secret_rotated_at' },
    updated_at: { name: 'webhook_configs.updated_at' },
    url: { name: 'webhook_configs.url' },
  },
}));

function rowsResult(rows: Array<Record<string, unknown>>) {
  return Object.assign(Promise.resolve(rows), {
    offset: () => Promise.resolve(rows),
  });
}

function queryFor(tableName: string) {
  const rows = () => mocks.tableRows[tableName] ?? [];
  const query = {
    limit: () => rowsResult(rows()),
    offset: () => Promise.resolve(rows()),
    orderBy: () => query,
    then: Promise.resolve(rows()).then.bind(Promise.resolve(rows())),
    where: () => query,
  };
  return query;
}

vi.mock('@/lib/db/rls', () => ({
  withRLS: mocks.withRLS,
}));

vi.mock('@/lib/rules/repository', () => ({
  addChannel: mocks.addChannel,
  getRule: mocks.getRule,
  listChannelsForRule: mocks.listChannelsForRule,
  removeChannel: mocks.removeChannel,
}));

vi.mock('@/lib/stripe/client', () => ({
  stripeFor: () => ({
    accountLinks: {
      create: mocks.stripeAccountLinksCreate,
    },
    accounts: {
      create: mocks.stripeAccountsCreate,
      update: mocks.stripeAccountsUpdate,
    },
  }),
}));

vi.mock('@/lib/billing/idempotency', () => ({
  checkOrClaim: vi.fn(),
  commitClaim: vi.fn(),
  hashBody: () => 'hash',
  releaseClaim: vi.fn(),
}));

vi.mock('@/lib/billing/invoice-generator', () => ({
  BillingError: class BillingError extends Error {
    code = 'stripe_not_connected';
  },
  generateInvoice: vi.fn(),
}));

vi.mock('@/lib/billing/formulas', () => ({
  applyFormula: () => ({ amount_usd: 0, line_items: [] }),
}));

vi.mock('@/lib/billing/clickhouse-usage', () => ({
  getUsageForPeriod: vi.fn(),
}));

vi.mock('@/lib/billing/pricing-versioning', () => ({
  getActiveVersion: vi.fn(),
  rowToCustomerPricing: vi.fn(),
}));

vi.mock('@/lib/clickhouse/customer-id', () => ({
  resolveCustomerComposite: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    child: () => ({
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }),
  },
}));

const { GET: getWebhooks, POST: createWebhook } =
  await import('../../src/app/api/v1/settings/webhooks/route.js');
const { PATCH: patchWebhook, DELETE: deleteWebhook } =
  await import('../../src/app/api/v1/settings/webhooks/[id]/route.js');
const { POST: rotateWebhook } =
  await import('../../src/app/api/v1/settings/webhooks/[id]/rotate/route.js');
const { POST: postRuleChannel } = await import('../../src/app/api/v1/rules/[id]/channels/route.js');
const { DELETE: deleteRuleChannel } =
  await import('../../src/app/api/v1/rules/[id]/channels/[channel_id]/route.js');
const { GET: getInvoices } = await import('../../src/app/api/v1/billing/invoices/route.js');
const { GET: getInvoice } = await import('../../src/app/api/v1/billing/invoices/[id]/route.js');
const { POST: finalizeInvoice } =
  await import('../../src/app/api/v1/billing/invoices/[id]/finalize/route.js');
const { POST: voidInvoice } =
  await import('../../src/app/api/v1/billing/invoices/[id]/void/route.js');
const { POST: connectBilling } = await import('../../src/app/api/v1/billing/connect/route.js');
const { GET: returnBillingConnect } =
  await import('../../src/app/api/v1/billing/connect/return/route.js');
const { POST: disconnectBilling } =
  await import('../../src/app/api/v1/billing/disconnect/route.js');
const { GET: getBillingAlertConfig } =
  await import('../../src/app/api/v1/billing/alert-config/route.js');
const { GET: previewBillingPricing } =
  await import('../../src/app/api/v1/billing/pricing/preview/route.js');

function deniedGate(feature: TierFeature = 'webhooks', tier = 'free'): NextResponse {
  return NextResponse.json(
    {
      error: {
        type: 'invalid_request_error',
        code: ErrorCode.FEATURE_NOT_AVAILABLE,
        message: `'${feature}' is not available on the ${tier} tier. Upgrade to access this feature.`,
      },
    },
    { status: 403 },
  );
}

async function expectFeatureUnavailable(
  response: NextResponse,
  feature: TierFeature,
  tier = 'free',
): Promise<void> {
  const body = await response.json();

  expect(response.status).toBe(403);
  expect(body).toEqual({
    error: {
      type: 'invalid_request_error',
      code: ErrorCode.FEATURE_NOT_AVAILABLE,
      message: `'${feature}' is not available on the ${tier} tier. Upgrade to access this feature.`,
    },
  });
}

function request(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(url, init);
}

function jsonRequest(url: string, body: Record<string, unknown>, method = 'POST'): NextRequest {
  return request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const ruleParams = { params: Promise.resolve({ id: 'rule-a' }) };
const ruleChannelParams = { params: Promise.resolve({ id: 'rule-a', channel_id: 'channel-a' }) };
const webhookParams = {
  params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000011' }),
};
const invoiceParams = {
  params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000099' }),
};
const invalidInvoiceParams = { params: Promise.resolve({ id: 'not-a-uuid' }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tableRows = {
    stripe_connect: [
      {
        status: 'connected',
        stripe_account_id: 'acct_123',
      },
    ],
    webhook_configs: [
      {
        id: '00000000-0000-4000-8000-000000000011',
        url: 'https://hooks.example.com/pylva',
        events: ['rule.fired'],
        enabled: true,
        secret: 'whsec_old',
        secret_rotated_at: null,
      },
    ],
  };
  mocks.withRLS.mockImplementation(
    async (_builderId: string, fn: (tx: unknown) => Promise<unknown>) => {
      const updatedWebhook = {
        id: '00000000-0000-4000-8000-000000000011',
        url: 'https://hooks.example.com/pylva',
        events: ['rule.fired'],
        enabled: false,
        secret_rotated_at: new Date('2026-07-02T00:00:00.000Z'),
      };
      const updateResult = Object.assign(Promise.resolve([]), {
        returning: () => Promise.resolve([updatedWebhook]),
      });
      const tx = {
        delete: () => ({
          where: () => ({
            returning: () => Promise.resolve([{ id: 'deleted' }]),
          }),
        }),
        insert: () => ({
          values: () => ({
            onConflictDoUpdate: () => Promise.resolve(undefined),
            returning: () => Promise.resolve([{ id: 'created' }]),
          }),
        }),
        select: () => ({
          from: (table: { __table?: string }) => queryFor(table.__table ?? 'unknown'),
        }),
        update: () => ({
          set: () => ({
            where: () => updateResult,
          }),
        }),
      };
      return fn(tx);
    },
  );
  mocks.getRule.mockResolvedValue({ id: 'rule-a' });
  mocks.addChannel.mockResolvedValue({ id: 'channel-a', channel: 'webhook' });
  mocks.removeChannel.mockResolvedValue(true);
  mocks.stripeAccountsCreate.mockResolvedValue({ id: 'acct_123' });
  mocks.stripeAccountLinksCreate.mockResolvedValue({ url: 'https://stripe.test/onboard' });
  mocks.stripeAccountsUpdate.mockResolvedValue({ id: 'acct_123' });
});

describe('new feature-gated route groups', () => {
  it.each([
    ['webhook config GET', () => getWebhooks(request('http://localhost/api/v1/settings/webhooks'))],
    [
      'webhook config POST',
      () =>
        createWebhook(
          jsonRequest('http://localhost/api/v1/settings/webhooks', {
            url: 'https://hooks.example.com/pylva',
            events: ['rule.fired'],
          }),
        ),
    ],
    [
      'webhook config PATCH',
      () =>
        patchWebhook(
          jsonRequest(
            'http://localhost/api/v1/settings/webhooks/00000000-0000-4000-8000-000000000011',
            { enabled: false },
            'PATCH',
          ),
          webhookParams,
        ),
    ],
    [
      'webhook config rotate',
      () =>
        rotateWebhook(
          request(
            'http://localhost/api/v1/settings/webhooks/00000000-0000-4000-8000-000000000011/rotate',
            { method: 'POST' },
          ),
          webhookParams,
        ),
    ],
    [
      'rule webhook channel POST',
      () =>
        postRuleChannel(
          jsonRequest('http://localhost/api/v1/rules/rule-a/channels', {
            channel: 'webhook',
            webhook_config_id: '00000000-0000-4000-8000-000000000011',
          }),
          ruleParams,
        ),
    ],
  ])('returns 403 FEATURE_NOT_AVAILABLE for Free on %s', async (_name, call) => {
    mocks.checkBuilderFeatureGate.mockImplementation(
      async (_builderId: string, feature: TierFeature) => deniedGate(feature),
    );

    const response = await call();
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe(ErrorCode.FEATURE_NOT_AVAILABLE);
    expect(mocks.checkBuilderFeatureGate).toHaveBeenCalledWith('builder-a', 'webhooks');
  });

  it.each([
    [
      'webhook settings POST',
      'webhooks' as const,
      () =>
        createWebhook(
          jsonRequest('http://localhost/api/v1/settings/webhooks', {
            url: 'https://hooks.example.com/pylva',
            events: ['rule.fired'],
          }),
        ),
    ],
    [
      'webhook secret rotate',
      'webhooks' as const,
      () =>
        rotateWebhook(
          request(
            'http://localhost/api/v1/settings/webhooks/00000000-0000-4000-8000-000000000011/rotate',
            { method: 'POST' },
          ),
          webhookParams,
        ),
    ],
    [
      'rule webhook channel add',
      'webhooks' as const,
      () =>
        postRuleChannel(
          jsonRequest('http://localhost/api/v1/rules/rule-a/channels', {
            channel: 'webhook',
            webhook_config_id: '00000000-0000-4000-8000-000000000011',
          }),
          ruleParams,
        ),
    ],
    [
      'billing invoices GET',
      'billing' as const,
      () => getInvoices(request('http://localhost/api/v1/billing/invoices')),
    ],
  ])('returns the exact free-tier feature envelope for %s', async (_name, feature, call) => {
    mocks.checkBuilderFeatureGate.mockImplementation(
      async (_builderId: string, requestedFeature: TierFeature) => deniedGate(requestedFeature),
    );

    const response = await call();

    await expectFeatureUnavailable(response, feature);
    expect(mocks.checkBuilderFeatureGate).toHaveBeenCalledWith('builder-a', feature);
  });

  it.each([
    ['webhook config GET', () => getWebhooks(request('http://localhost/api/v1/settings/webhooks'))],
    [
      'webhook config POST',
      () =>
        createWebhook(
          jsonRequest('http://localhost/api/v1/settings/webhooks', {
            url: 'https://hooks.example.com/pylva',
            events: ['rule.fired'],
          }),
        ),
    ],
    [
      'webhook config PATCH',
      () =>
        patchWebhook(
          jsonRequest(
            'http://localhost/api/v1/settings/webhooks/00000000-0000-4000-8000-000000000011',
            { enabled: false },
            'PATCH',
          ),
          webhookParams,
        ),
    ],
    [
      'webhook config rotate',
      () =>
        rotateWebhook(
          request(
            'http://localhost/api/v1/settings/webhooks/00000000-0000-4000-8000-000000000011/rotate',
            { method: 'POST' },
          ),
          webhookParams,
        ),
    ],
    [
      'rule webhook channel POST',
      () =>
        postRuleChannel(
          jsonRequest('http://localhost/api/v1/rules/rule-a/channels', {
            channel: 'webhook',
            webhook_config_id: '00000000-0000-4000-8000-000000000011',
          }),
          ruleParams,
        ),
    ],
  ])('continues past the webhook gate for Pro on %s', async (_name, call) => {
    mocks.checkBuilderFeatureGate.mockResolvedValue(null);

    const response = await call();

    expect(response.status).not.toBe(403);
    expect(mocks.checkBuilderFeatureGate).toHaveBeenCalledWith('builder-a', 'webhooks');
  });

  it('does not gate email or Slack rule-channel management on the webhooks feature', async () => {
    mocks.checkBuilderFeatureGate.mockImplementation(async () => deniedGate());

    const response = await postRuleChannel(
      jsonRequest('http://localhost/api/v1/rules/rule-a/channels', {
        channel: 'email',
        email_recipients: ['ops@example.com'],
      }),
      ruleParams,
    );

    expect(response.status).toBe(201);
    expect(mocks.checkBuilderFeatureGate).not.toHaveBeenCalled();
  });

  it('allows webhook config DELETE as cleanup without the webhooks feature gate', async () => {
    mocks.checkBuilderFeatureGate.mockImplementation(async () => deniedGate());

    const response = await deleteWebhook(
      request('http://localhost/api/v1/settings/webhooks/00000000-0000-4000-8000-000000000011', {
        method: 'DELETE',
      }),
      webhookParams,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(mocks.checkBuilderFeatureGate).not.toHaveBeenCalled();
  });

  it('delete stays available after downgrade for rule-channel cleanup', async () => {
    mocks.checkBuilderFeatureGate.mockImplementation(async () => deniedGate('webhooks'));

    const response = await deleteRuleChannel(
      request('http://localhost/api/v1/rules/rule-a/channels/channel-a', { method: 'DELETE' }),
      ruleChannelParams,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(mocks.removeChannel).toHaveBeenCalledWith('builder-a', 'rule-a', 'channel-a');
    expect(mocks.checkBuilderFeatureGate).not.toHaveBeenCalled();
  });

  it.each([
    [
      'billing invoices list',
      () => getInvoices(request('http://localhost/api/v1/billing/invoices')),
    ],
    [
      'billing invoice detail',
      () => getInvoice(request('http://localhost/api/v1/billing/invoices/1'), invoiceParams),
    ],
    [
      'billing invoice finalize',
      () =>
        finalizeInvoice(
          request('http://localhost/api/v1/billing/invoices/1/finalize', { method: 'POST' }),
          invalidInvoiceParams,
        ),
    ],
    [
      'billing invoice void',
      () =>
        voidInvoice(
          request('http://localhost/api/v1/billing/invoices/1/void', { method: 'POST' }),
          invalidInvoiceParams,
        ),
    ],
    [
      'billing connect',
      () =>
        connectBilling(
          jsonRequest('http://localhost/api/v1/billing/connect', { slug: 'workspace-a' }),
        ),
    ],
    [
      'billing connect return',
      () => returnBillingConnect(request('http://localhost/api/v1/billing/connect/return')),
    ],
    [
      'billing disconnect',
      () =>
        disconnectBilling(
          request('http://localhost/api/v1/billing/disconnect', { method: 'POST' }),
        ),
    ],
    [
      'billing alert config',
      () => getBillingAlertConfig(request('http://localhost/api/v1/billing/alert-config')),
    ],
    [
      'billing pricing preview',
      () => previewBillingPricing(request('http://localhost/api/v1/billing/pricing/preview')),
    ],
  ])('returns 403 FEATURE_NOT_AVAILABLE for Free on %s', async (_name, call) => {
    mocks.checkBuilderFeatureGate.mockImplementation(
      async (_builderId: string, feature: TierFeature) => deniedGate(feature),
    );

    const response = await call();
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe(ErrorCode.FEATURE_NOT_AVAILABLE);
    expect(mocks.checkBuilderFeatureGate).toHaveBeenCalledWith('builder-a', 'billing');
  });

  it.each([
    [
      'billing invoices list',
      () => getInvoices(request('http://localhost/api/v1/billing/invoices')),
    ],
    [
      'billing invoice detail',
      () => getInvoice(request('http://localhost/api/v1/billing/invoices/1'), invoiceParams),
    ],
    [
      'billing invoice finalize',
      () =>
        finalizeInvoice(
          request('http://localhost/api/v1/billing/invoices/1/finalize', { method: 'POST' }),
          invalidInvoiceParams,
        ),
    ],
    [
      'billing invoice void',
      () =>
        voidInvoice(
          request('http://localhost/api/v1/billing/invoices/1/void', { method: 'POST' }),
          invalidInvoiceParams,
        ),
    ],
    [
      'billing connect',
      () =>
        connectBilling(
          jsonRequest('http://localhost/api/v1/billing/connect', { slug: 'workspace-a' }),
        ),
    ],
    [
      'billing connect return',
      () => returnBillingConnect(request('http://localhost/api/v1/billing/connect/return')),
    ],
    [
      'billing disconnect',
      () =>
        disconnectBilling(
          request('http://localhost/api/v1/billing/disconnect', { method: 'POST' }),
        ),
    ],
    [
      'billing alert config',
      () => getBillingAlertConfig(request('http://localhost/api/v1/billing/alert-config')),
    ],
    [
      'billing pricing preview',
      () => previewBillingPricing(request('http://localhost/api/v1/billing/pricing/preview')),
    ],
  ])('continues past the billing gate for Pro on %s', async (_name, call) => {
    mocks.checkBuilderFeatureGate.mockResolvedValue(null);

    const response = await call();

    expect(response.status).not.toBe(403);
    expect(mocks.checkBuilderFeatureGate).toHaveBeenCalledWith('builder-a', 'billing');
  });
});
