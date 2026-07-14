import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server.js';
import { Role } from '@pylva/shared';

const mocks = vi.hoisted(() => ({
  builderId: '00000000-0000-4000-8000-000000000001',
  userId: '11111111-1111-4111-8111-111111111111',
  customerId: '22222222-2222-4222-8222-222222222222',
  checkOrClaim: vi.fn(),
  commitClaim: vi.fn(),
  releaseClaim: vi.fn(),
  hashBody: vi.fn(),
  generateInvoice: vi.fn(),
}));

vi.mock('@/lib/auth/builder-context', () => ({
  readBuilderContextFromDashboard: () => ({
    builderId: mocks.builderId,
    userId: mocks.userId,
    role: Role.OWNER,
  }),
}));

vi.mock('@/lib/auth/middleware', () => ({
  withRole: () => null,
}));

vi.mock('@/lib/auth/tier-enforcement', () => ({
  checkBuilderFeatureGate: () => Promise.resolve(null),
}));

vi.mock('@/lib/billing/idempotency', () => ({
  checkOrClaim: mocks.checkOrClaim,
  commitClaim: mocks.commitClaim,
  releaseClaim: mocks.releaseClaim,
  hashBody: mocks.hashBody,
}));

vi.mock('@/lib/billing/invoice-generator', () => {
  class BillingError extends Error {
    constructor(
      public code: 'pricing_not_configured' | 'stripe_not_connected' | 'stripe_capabilities_pending',
      message: string,
    ) {
      super(message);
    }
  }
  return {
    BillingError,
    generateInvoice: mocks.generateInvoice,
  };
});

vi.mock('@/lib/db/rls', () => ({
  withRLS: vi.fn(),
}));

vi.mock('@/lib/db/schema', () => ({
  invoices: {
    builder_id: { name: 'builder_id' },
    customer_id: { name: 'customer_id' },
    status: { name: 'status' },
    period_start: { name: 'period_start' },
    period_end: { name: 'period_end' },
    billing_cycle_id: { name: 'billing_cycle_id' },
    created_at: { name: 'created_at' },
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    child: () => ({
      error: () => undefined,
      warn: () => undefined,
    }),
  },
}));

const { POST } = await import('../../src/app/api/v1/billing/invoices/route.js');
const { BillingError } = await import('../../src/lib/billing/invoice-generator.js');
const { StripeConfigurationError } = await import('../../src/lib/stripe/config-error.js');

function makeRequest(key = 'invoice-key-1'): NextRequest {
  return new NextRequest('http://localhost/api/v1/billing/invoices', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify({
      customer_id: mocks.customerId,
      period_start: '2026-06-01T00:00:00.000Z',
      period_end: '2026-07-01T00:00:00.000Z',
    }),
  } as ConstructorParameters<typeof NextRequest>[1]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hashBody.mockImplementation((value: unknown) =>
    typeof value === 'object' && value !== null && 'key' in value
      ? 'stable-draft-key-hash'
      : 'stable-body-hash',
  );
  mocks.releaseClaim.mockResolvedValue(undefined);
  mocks.commitClaim.mockResolvedValue(undefined);
});

describe('POST /api/v1/billing/invoices idempotency', () => {
  it('releases an uncommitted claim after a billing preflight error so the same key can retry', async () => {
    mocks.checkOrClaim.mockResolvedValueOnce({ status: 'new' });
    mocks.generateInvoice.mockRejectedValueOnce(
      new BillingError('stripe_not_connected', 'Builder has no Stripe account connected'),
    );

    const first = await POST(makeRequest());
    const firstBody = await first.json();

    expect(first.status).toBe(400);
    expect(firstBody.error.param).toBe('stripe_not_connected');
    expect(mocks.releaseClaim).toHaveBeenCalledWith({
      builderId: mocks.builderId,
      key: 'invoice-key-1',
      bodyHash: 'stable-body-hash',
    });

    mocks.checkOrClaim.mockResolvedValueOnce({ status: 'new' });
    mocks.generateInvoice.mockResolvedValueOnce([
      {
        invoice_id: '33333333-3333-4333-8333-333333333333',
        stripe_invoice_id: 'in_test_123',
        amount_usd: 59,
        has_unpriced_events: false,
      },
    ]);

    const second = await POST(makeRequest());
    const secondBody = await second.json();

    expect(second.status).toBe(201);
    expect(secondBody.invoices[0].invoice_id).toBe('33333333-3333-4333-8333-333333333333');
    expect(mocks.checkOrClaim).toHaveBeenCalledTimes(2);
    expect(mocks.generateInvoice).toHaveBeenCalledTimes(2);
    expect(mocks.commitClaim).toHaveBeenCalledWith({
      builderId: mocks.builderId,
      key: 'invoice-key-1',
      invoiceId: '33333333-3333-4333-8333-333333333333',
    });
  });

  it('releases the idempotency claim and returns 503 when Stripe server config is missing', async () => {
    mocks.checkOrClaim.mockResolvedValueOnce({ status: 'new' });
    mocks.generateInvoice.mockRejectedValueOnce(new StripeConfigurationError('STRIPE_SECRET_KEY'));

    const res = await POST(makeRequest('missing-stripe-config-key'));
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.error.type).toBe('api_error');
    expect(body.error.param).toBe('stripe');
    expect(body.error.message).toContain('STRIPE_SECRET_KEY');
    expect(mocks.releaseClaim).toHaveBeenCalledWith({
      builderId: mocks.builderId,
      key: 'missing-stripe-config-key',
      bodyHash: 'stable-body-hash',
    });
    expect(mocks.commitClaim).not.toHaveBeenCalled();
  });

  it('resumes an interrupted auto-split request with the same idempotency key', async () => {
    mocks.checkOrClaim.mockResolvedValueOnce({ status: 'replay', invoiceId: null });
    mocks.generateInvoice.mockResolvedValueOnce([
      {
        invoice_id: '33333333-3333-4333-8333-333333333333',
        stripe_invoice_id: 'in_slice_1',
        amount_usd: 10,
        has_unpriced_events: false,
        billing_cycle_id: '55555555-5555-4555-8555-555555555555',
      },
      {
        invoice_id: '44444444-4444-4444-8444-444444444444',
        stripe_invoice_id: 'in_slice_2',
        amount_usd: 20,
        has_unpriced_events: false,
        billing_cycle_id: '55555555-5555-4555-8555-555555555555',
      },
    ]);

    const response = await POST(makeRequest('interrupted-split-key'));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.invoices).toHaveLength(2);
    expect(mocks.generateInvoice).toHaveBeenCalledWith({
      builderId: mocks.builderId,
      customerId: mocks.customerId,
      period: {
        start: new Date('2026-06-01T00:00:00.000Z'),
        end: new Date('2026-07-01T00:00:00.000Z'),
      },
      actorUserId: mocks.userId,
      draftKeyBase: 'oneoff:stable-draft-key-hash',
    });
    expect(mocks.commitClaim).toHaveBeenCalledWith({
      builderId: mocks.builderId,
      key: 'interrupted-split-key',
      invoiceId: '33333333-3333-4333-8333-333333333333',
    });
    expect(mocks.releaseClaim).not.toHaveBeenCalled();
  });
});
