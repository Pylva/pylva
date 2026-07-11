// Regression: POST /api/v1/billing/invoices/[id]/finalize must enforce the
// I-T2-14 capabilities gate, not just the presence of a stripe_account_id.
//
// Trigger scenario (builder/account state machine):
//   1. Builder connects Stripe account acct_A (capabilities active). A draft
//      invoice is generated (the gate passes at generation time).
//   2. Builder hits POST /api/v1/billing/disconnect. Soft-disconnect leaves
//      stripe_account_id=acct_A populated but flips capabilities_ok=false and
//      status='disconnected' (it intentionally does NOT clear the account id).
//   3. Owner opens the still-existing draft and clicks Finalize.
//
// Pre-fix, finalize only asserted `connectRow.stripe_account_id` was non-null,
// so the gate passed and stripe.invoices.finalizeInvoice was called on the
// disconnected account — finalizing is the charge-triggering action, so this
// could charge an end-customer on an account the builder explicitly cut off.
// The disconnect route's own comment promised "new invoice generation will be
// blocked by the capabilities gate (I-T2-14)" — but finalize bypassed it.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server.js';

const BUILDER_ID = '00000000-0000-0000-0000-000000000001';
const INVOICE_ID = '00000000-0000-0000-0000-0000000000aa';
const CUSTOMER_ID = '00000000-0000-0000-0000-0000000000bb';

const sendInvoice = vi.fn();

// Mutable fixtures the mocked db reads from.
let invoiceRow: Record<string, unknown> | null;
let connectRow: Record<string, unknown> | null;
let customerRow: Record<string, unknown> | null;
// Which table each select targets, in call order.
let selectTargets: Array<'invoices' | 'stripe_connect' | 'customers'>;
let updateCalls: Array<{ table: string; set: Record<string, unknown> }>;

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }),
  },
}));

vi.mock('../../src/lib/auth/builder-context.js', () => ({
  readBuilderContextFromDashboard: () => ({ builderId: BUILDER_ID, userId: 'u-1', role: 'owner' }),
}));

vi.mock('../../src/lib/auth/middleware.js', () => ({ withRole: () => null }));
vi.mock('@/lib/auth/tier-enforcement', () => ({
  checkBuilderFeatureGate: () => Promise.resolve(null),
}));
vi.mock('../../src/lib/auth/audit-log.js', () => ({ auditLog: () => Promise.resolve() }));
vi.mock('../../src/lib/audit/actions.js', () => ({
  AuditAction: new Proxy({}, { get: (_t, prop) => String(prop) }),
}));

vi.mock('../../src/lib/errors.js', () => ({
  validationError: (msg: string, field: string) =>
    new Response(JSON.stringify({ error: msg, field }), { status: 400 }),
  notFoundError: (code: string, msg: string) =>
    new Response(JSON.stringify({ code, error: msg }), { status: 404 }),
  apiError: (status: number, _type: string, code: string, msg: string, field: string) =>
    new Response(JSON.stringify({ code, error: msg, field }), { status }),
  internalError: (msg: string) => new Response(JSON.stringify({ error: msg }), { status: 500 }),
}));

vi.mock('../../src/lib/stripe/client.js', () => ({
  stripeFor: () => ({ invoices: { sendInvoice } }),
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: { name: string }, val: unknown) => ({ kind: 'eq', col: col.name, val }),
  and: (...conds: unknown[]) => ({ kind: 'and', conds }),
}));

vi.mock('../../src/lib/db/schema.js', () => ({
  invoices: {
    __table: 'invoices',
    builder_id: { name: 'builder_id' },
    customer_id: { name: 'customer_id' },
    id: { name: 'id' },
  },
  customers: {
    __table: 'customers',
    builder_id: { name: 'builder_id' },
    email: { name: 'email' },
    id: { name: 'id' },
  },
  stripeConnect: {
    __table: 'stripe_connect',
    builder_id: { name: 'builder_id' },
    stripe_account_id: { name: 'stripe_account_id' },
    status: { name: 'status' },
    capabilities_ok: { name: 'capabilities_ok' },
  },
}));

vi.mock('../../src/lib/db/rls.js', () => ({
  withRLS: (_builderId: string, cb: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      select: (_cols?: unknown) => ({
        from: (table: { __table: string }) => {
          selectTargets.push(table.__table as 'invoices' | 'stripe_connect' | 'customers');
          const row =
            table.__table === 'invoices'
              ? invoiceRow
              : table.__table === 'customers'
                ? customerRow
                : connectRow;
          return {
            where: () => ({ limit: () => Promise.resolve(row ? [row] : []) }),
          };
        },
      }),
      update: (table: { __table: string }) => ({
        set: (set: Record<string, unknown>) => ({
          where: () => {
            updateCalls.push({ table: table.__table, set });
            return Promise.resolve([]);
          },
        }),
      }),
    };
    return cb(tx);
  },
}));

const { POST } = await import('../../src/app/api/v1/billing/invoices/[id]/finalize/route.js');

function call() {
  return POST(
    new NextRequest(`http://localhost/api/v1/billing/invoices/${INVOICE_ID}/finalize`, {
      method: 'POST',
    }),
    { params: Promise.resolve({ id: INVOICE_ID }) },
  );
}

describe('POST finalize — capabilities gate on a (soft-)disconnected account', () => {
  beforeEach(() => {
    sendInvoice.mockReset().mockResolvedValue({ id: 'in_AAA', status: 'open' });
    selectTargets = [];
    updateCalls = [];
    invoiceRow = {
      id: INVOICE_ID,
      builder_id: BUILDER_ID,
      customer_id: CUSTOMER_ID,
      status: 'draft',
      stripe_invoice_id: 'in_AAA',
    };
    customerRow = { email: 'customer@example.com' };
  });

  it('409s and does NOT finalize when the account was disconnected (capabilities_ok=false)', async () => {
    connectRow = {
      stripe_account_id: 'acct_A', // retained by soft-disconnect
      status: 'disconnected',
      capabilities_ok: false,
    };

    const res = await call();

    expect(res.status).toBe(409);
    // The charge-triggering Stripe call must never happen.
    expect(sendInvoice).not.toHaveBeenCalled();
    // The local invoice status must stay 'draft' (no DB write).
    expect(updateCalls).toHaveLength(0);
  });

  it('still finalizes normally when the account is connected and chargeable', async () => {
    connectRow = {
      stripe_account_id: 'acct_A',
      status: 'connected',
      capabilities_ok: true,
    };

    const res = await call();

    expect(res.status).toBe(200);
    expect(sendInvoice).toHaveBeenCalledWith('in_AAA');
    const flip = updateCalls.find((c) => c.table === 'invoices');
    expect(flip?.set['status']).toBe('pending');
  });
});
