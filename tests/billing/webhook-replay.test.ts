import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const BUILDER_ID = '00000000-0000-0000-0000-000000000001';
const STRIPE_INVOICE_ID = 'in_test_123';

interface Row {
  id: string;
  builder_id: string;
  stripe_invoice_id: string;
  status: string;
  paid_at?: Date | null;
  payment_failed_at?: Date | null;
}

let store: Row[] = [];

type Cond =
  | { kind: 'eq'; col: string; val: unknown }
  | { kind: 'notIn'; col: string; vals: unknown[] }
  | { kind: 'and'; conds: Cond[] };

function matches(row: Record<string, unknown>, cond: Cond): boolean {
  switch (cond.kind) {
    case 'and':
      return cond.conds.every((c) => matches(row, c));
    case 'eq':
      return row[cond.col] === cond.val;
    case 'notIn':
      return !cond.vals.includes(row[cond.col]);
  }
}

const auditLogSpy = vi.fn();
const deliverBuilderAlertSpy = vi.fn();

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    }),
  },
}));

vi.mock('../../src/lib/auth/audit-log.js', () => ({
  auditLog: (...args: unknown[]) => {
    auditLogSpy(...args);
    return Promise.resolve();
  },
}));

vi.mock('../../src/lib/alerts/builder-alert.js', () => ({
  deliverBuilderAlert: (...args: unknown[]) => {
    deliverBuilderAlertSpy(...args);
    return Promise.resolve();
  },
}));

vi.mock('../../src/lib/db/schema.js', () => ({
  invoices: {
    id: { name: 'id' },
    builder_id: { name: 'builder_id' },
    stripe_invoice_id: { name: 'stripe_invoice_id' },
    status: { name: 'status' },
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: { name: string }, val: unknown) => ({ kind: 'eq', col: col.name, val }),
  notInArray: (col: { name: string }, vals: unknown[]) => ({
    kind: 'notIn',
    col: col.name,
    vals,
  }),
  and: (...conds: Cond[]) => ({ kind: 'and', conds }),
}));

vi.mock('../../src/lib/db/rls.js', () => ({
  withRLS: (_builderId: string, cb: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      update: () => ({
        set: (vals: Partial<Row>) => ({
          where: (cond: Cond) => ({
            returning: () => {
              const hit = store.filter((r) =>
                matches(r as unknown as Record<string, unknown>, cond),
              );
              for (const r of hit) Object.assign(r, vals);
              return Promise.resolve(hit.map((r) => ({ id: r.id })));
            },
          }),
        }),
      }),
      select: () => ({
        from: () => ({
          where: (cond: Cond) => ({
            limit: () =>
              Promise.resolve(
                store
                  .filter((r) => matches(r as unknown as Record<string, unknown>, cond))
                  .map((r) => ({ id: r.id })),
              ),
          }),
        }),
      }),
    };
    return cb(tx);
  },
}));

const { handleInvoicePaid, handleInvoicePaymentFailed } =
  await import('../../src/lib/stripe/webhook-handlers.js');

function paymentFailedEvent() {
  return {
    type: 'invoice.payment_failed',
    data: {
      object: {
        id: STRIPE_INVOICE_ID,
        amount_due: 5000,
        metadata: { pylva_customer_id: 'cus-1' },
      },
    },
  } as unknown as Parameters<typeof handleInvoicePaymentFailed>[0];
}

function paidEvent() {
  return {
    type: 'invoice.paid',
    data: { object: { id: STRIPE_INVOICE_ID, amount_paid: 5000 } },
  } as unknown as Parameters<typeof handleInvoicePaid>[0];
}

const ctx = (eventCreated: number, eventId: string) => ({
  builderId: BUILDER_ID,
  eventId,
  eventCreated,
});

describe('connect invoice webhook status guards', () => {
  beforeEach(() => {
    store = [
      {
        id: 'inv-1',
        builder_id: BUILDER_ID,
        stripe_invoice_id: STRIPE_INVOICE_ID,
        status: 'pending',
      },
    ];
    auditLogSpy.mockReset();
    deliverBuilderAlertSpy.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not revert a paid invoice when a stale payment_failed is delivered', async () => {
    await handleInvoicePaymentFailed(paymentFailedEvent(), ctx(100, 'evt_failed_a'));
    expect(store[0]!.status).toBe('failed');
    expect(deliverBuilderAlertSpy).toHaveBeenCalledTimes(1);

    await handleInvoicePaid(paidEvent(), ctx(200, 'evt_paid_b'));
    expect(store[0]!.status).toBe('paid');

    deliverBuilderAlertSpy.mockClear();
    auditLogSpy.mockClear();
    await handleInvoicePaymentFailed(paymentFailedEvent(), ctx(100, 'evt_failed_a'));

    expect(store[0]!.status).toBe('paid');
    expect(deliverBuilderAlertSpy).not.toHaveBeenCalled();
    expect(auditLogSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'billing.webhook_replay_ignored',
        resource_id: 'inv-1',
      }),
    );
  });

  it('still alerts for a distinct later payment_failed while the invoice is failed', async () => {
    await handleInvoicePaymentFailed(paymentFailedEvent(), ctx(100, 'evt_failed_a'));
    expect(store[0]!.status).toBe('failed');
    expect(deliverBuilderAlertSpy).toHaveBeenCalledTimes(1);

    await handleInvoicePaymentFailed(paymentFailedEvent(), ctx(300, 'evt_failed_c'));
    expect(store[0]!.status).toBe('failed');
    expect(deliverBuilderAlertSpy).toHaveBeenCalledTimes(2);
  });

  it('fires once on the legitimate first failure', async () => {
    await handleInvoicePaymentFailed(paymentFailedEvent(), ctx(100, 'evt_failed_a'));
    expect(store[0]!.status).toBe('failed');
    expect(deliverBuilderAlertSpy).toHaveBeenCalledTimes(1);
  });

  it('lets a late success settle a previously failed invoice', async () => {
    store[0]!.status = 'failed';
    await handleInvoicePaid(paidEvent(), ctx(300, 'evt_paid_b'));
    expect(store[0]!.status).toBe('paid');
  });
});
