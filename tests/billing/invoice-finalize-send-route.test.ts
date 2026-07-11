import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server.js';
import { Role } from '@pylva/shared';

const BUILDER_ID = '00000000-0000-4000-8000-000000000001';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const INVOICE_ID = '22222222-2222-4222-8222-222222222222';
const STRIPE_INVOICE_ID = 'in_test_123';
const STRIPE_ACCOUNT_ID = 'acct_test_1';

type Cond = { kind: 'eq'; col: string; val: unknown } | { kind: 'and'; conds: Cond[] };

interface InvoiceRow {
  id: string;
  builder_id: string;
  customer_id: string;
  status: string;
  stripe_invoice_id: string | null;
}

let invoiceRow: InvoiceRow | null;
let connectRow: { stripe_account_id: string | null; status: string; capabilities_ok: boolean } | null;
let customerRow: { email: string | null } | null;
let dbUpdates: Record<string, unknown>[];
const sendInvoice = vi.fn();
const finalizeInvoice = vi.fn();
const stripeFor = vi.fn();
const auditLog = vi.fn();

vi.mock('@/lib/auth/builder-context', () => ({
  readBuilderContextFromDashboard: () => ({
    builderId: BUILDER_ID,
    userId: USER_ID,
    role: Role.OWNER,
  }),
}));

vi.mock('@/lib/auth/middleware', () => ({
  withRole: () => null,
}));

vi.mock('@/lib/auth/tier-enforcement', () => ({
  checkBuilderFeatureGate: () => Promise.resolve(null),
}));

vi.mock('@/lib/auth/audit-log', () => ({
  auditLog: (...args: unknown[]) => {
    auditLog(...args);
    return Promise.resolve();
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    child: () => ({ error: () => undefined }),
  },
}));

vi.mock('@/lib/stripe/client', () => ({
  stripeFor,
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: { name: string }, val: unknown) => ({ kind: 'eq', col: col.name, val }),
  and: (...conds: Cond[]) => ({ kind: 'and', conds }),
  desc: () => ({}),
  gte: () => ({}),
  lt: () => ({}),
}));

vi.mock('@/lib/db/schema', () => ({
  invoices: {
    __table: 'invoices',
    id: { name: 'id' },
    builder_id: { name: 'builder_id' },
    customer_id: { name: 'customer_id' },
    status: { name: 'status' },
    stripe_invoice_id: { name: 'stripe_invoice_id' },
  },
  customers: {
    __table: 'customers',
    id: { name: 'id' },
    builder_id: { name: 'builder_id' },
    email: { name: 'email' },
  },
  stripeConnect: {
    __table: 'stripe_connect',
    builder_id: { name: 'builder_id' },
    stripe_account_id: { name: 'stripe_account_id' },
    status: { name: 'status' },
    capabilities_ok: { name: 'capabilities_ok' },
  },
}));

vi.mock('@/lib/db/rls', () => ({
  withRLS: (_builderId: string, cb: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      select: () => ({
        from: (table: { __table: string }) => ({
          where: () => ({
            limit: () => {
              if (table.__table === 'invoices') return Promise.resolve(invoiceRow ? [invoiceRow] : []);
              if (table.__table === 'customers') {
                return Promise.resolve(customerRow ? [customerRow] : []);
              }
              if (table.__table === 'stripe_connect') {
                return Promise.resolve(connectRow ? [connectRow] : []);
              }
              return Promise.resolve([]);
            },
          }),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            dbUpdates.push(values);
            return Promise.resolve([]);
          },
        }),
      }),
    };
    return cb(tx);
  },
}));

const { POST } = await import('../../src/app/api/v1/billing/invoices/[id]/finalize/route.js');
const { StripeConfigurationError } = await import('../../src/lib/stripe/config-error.js');

beforeEach(() => {
  invoiceRow = {
    id: INVOICE_ID,
    builder_id: BUILDER_ID,
    customer_id: '33333333-3333-4333-8333-333333333333',
    status: 'draft',
    stripe_invoice_id: STRIPE_INVOICE_ID,
  };
  connectRow = { stripe_account_id: STRIPE_ACCOUNT_ID, status: 'connected', capabilities_ok: true };
  customerRow = { email: 'customer@example.com' };
  dbUpdates = [];
  stripeFor.mockReset().mockImplementation((accountId?: string) => {
    expect(accountId).toBe(STRIPE_ACCOUNT_ID);
    return {
      invoices: {
        sendInvoice,
        finalizeInvoice,
      },
    };
  });
  sendInvoice.mockReset().mockResolvedValue({ id: STRIPE_INVOICE_ID, status: 'open' });
  finalizeInvoice.mockReset().mockResolvedValue({ id: STRIPE_INVOICE_ID, status: 'open' });
  auditLog.mockReset();
});

describe('POST /api/v1/billing/invoices/[id]/finalize', () => {
  it('sends the Stripe invoice, which finalizes draft invoices before emailing', async () => {
    const res = await POST(new NextRequest(`http://localhost/api/v1/billing/invoices/${INVOICE_ID}/finalize`), {
      params: Promise.resolve({ id: INVOICE_ID }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ id: INVOICE_ID, status: 'pending' });
    expect(sendInvoice).toHaveBeenCalledWith(STRIPE_INVOICE_ID);
    expect(finalizeInvoice).not.toHaveBeenCalled();
    expect(dbUpdates[0]).toEqual({ status: 'pending' });
    expect(auditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'billing.invoice_finalized',
        resource_id: INVOICE_ID,
      }),
    );
  });

  it('returns a clear validation error when the end-customer has no email', async () => {
    customerRow = { email: null };

    const res = await POST(new NextRequest(`http://localhost/api/v1/billing/invoices/${INVOICE_ID}/finalize`), {
      params: Promise.resolve({ id: INVOICE_ID }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.param).toBe('customer_email');
    expect(body.error.message).toBe('Customer email is required before sending invoice');
    expect(sendInvoice).not.toHaveBeenCalled();
    expect(dbUpdates).toHaveLength(0);
  });

  it('returns a clear 503 when Stripe server config is missing', async () => {
    stripeFor.mockImplementationOnce(() => {
      throw new StripeConfigurationError('STRIPE_API_VERSION');
    });

    const res = await POST(new NextRequest(`http://localhost/api/v1/billing/invoices/${INVOICE_ID}/finalize`), {
      params: Promise.resolve({ id: INVOICE_ID }),
    });
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.error.type).toBe('api_error');
    expect(body.error.param).toBe('stripe');
    expect(body.error.message).toContain('STRIPE_API_VERSION');
    expect(sendInvoice).not.toHaveBeenCalled();
    expect(dbUpdates).toHaveLength(0);
  });
});
