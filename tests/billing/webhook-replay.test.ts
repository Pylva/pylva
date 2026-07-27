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
  last_viewed_at?: Date | null;
}

let store: Row[] = [];

type Cond =
  | { kind: 'eq'; col: string; val: unknown }
  | { kind: 'notIn'; col: string; vals: unknown[] }
  | { kind: 'isNull'; col: string }
  | { kind: 'lt'; col: string; val: Date }
  | { kind: 'and'; conds: Cond[] }
  | { kind: 'or'; conds: Cond[] };

function matches(row: Record<string, unknown>, cond: Cond): boolean {
  switch (cond.kind) {
    case 'and':
      return cond.conds.every((c) => matches(row, c));
    case 'or':
      return cond.conds.some((c) => matches(row, c));
    case 'eq':
      return row[cond.col] === cond.val;
    case 'notIn':
      return !cond.vals.includes(row[cond.col]);
    case 'isNull':
      return row[cond.col] == null;
    case 'lt': {
      const raw = row[cond.col];
      return raw instanceof Date && raw.getTime() < cond.val.getTime();
    }
  }
}

const auditLogSpy = vi.fn();

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

vi.mock('../../src/lib/db/schema.js', () => ({
  invoices: {
    id: { name: 'id' },
    builder_id: { name: 'builder_id' },
    stripe_invoice_id: { name: 'stripe_invoice_id' },
    status: { name: 'status' },
    paid_at: { name: 'paid_at' },
    payment_failed_at: { name: 'payment_failed_at' },
    last_viewed_at: { name: 'last_viewed_at' },
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: { name: string }, val: unknown) => ({ kind: 'eq', col: col.name, val }),
  notInArray: (col: { name: string }, vals: unknown[]) => ({
    kind: 'notIn',
    col: col.name,
    vals,
  }),
  isNull: (col: { name: string }) => ({ kind: 'isNull', col: col.name }),
  lt: (col: { name: string }, val: Date) => ({
    kind: 'lt',
    col: col.name,
    val,
  }),
  and: (...conds: Cond[]) => ({ kind: 'and', conds }),
  or: (...conds: Cond[]) => ({ kind: 'or', conds }),
}));

const transaction = {
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
              .filter((r) =>
                matches(r as unknown as Record<string, unknown>, cond),
              )
              .map((r) => ({ id: r.id })),
          ),
      }),
    }),
  }),
};

const { handleInvoicePaid, handleInvoicePaymentFailed, handleInvoiceViewed } =
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

function viewedEvent() {
  return {
    type: 'invoice.viewed',
    data: { object: { id: STRIPE_INVOICE_ID } },
  } as unknown as Parameters<typeof handleInvoiceViewed>[0];
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
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not revert a paid invoice when a stale payment_failed is delivered', async () => {
    const firstEffect = await handleInvoicePaymentFailed(
      paymentFailedEvent(),
      ctx(100, 'evt_failed_a'),
      transaction as never,
    );
    expect(store[0]!.status).toBe('failed');
    expect(firstEffect).toMatchObject({
      builderId: BUILDER_ID,
      payload: { id: 'evt_failed_a', type: 'billing.payment_failed' },
    });

    await handleInvoicePaid(
      paidEvent(),
      ctx(200, 'evt_paid_b'),
      transaction as never,
    );
    expect(store[0]!.status).toBe('paid');

    auditLogSpy.mockClear();
    const replayEffect = await handleInvoicePaymentFailed(
      paymentFailedEvent(),
      ctx(100, 'evt_failed_a'),
      transaction as never,
    );

    expect(store[0]!.status).toBe('paid');
    expect(replayEffect).toBeNull();
    expect(auditLogSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'billing.webhook_replay_ignored',
        resource_id: 'inv-1',
      }),
    );
  });

  it('still alerts for a distinct later payment_failed while the invoice is failed', async () => {
    const firstEffect = await handleInvoicePaymentFailed(
      paymentFailedEvent(),
      ctx(100, 'evt_failed_a'),
      transaction as never,
    );
    expect(store[0]!.status).toBe('failed');
    expect(firstEffect?.payload.id).toBe('evt_failed_a');

    const secondEffect = await handleInvoicePaymentFailed(
      paymentFailedEvent(),
      ctx(300, 'evt_failed_c'),
      transaction as never,
    );
    expect(store[0]!.status).toBe('failed');
    expect(secondEffect?.payload.id).toBe('evt_failed_c');
  });

  it('ignores an older distinct payment_failed event after a newer failure', async () => {
    const newer = await handleInvoicePaymentFailed(
      paymentFailedEvent(),
      ctx(300, 'evt_failed_newer'),
      transaction as never,
    );
    const older = await handleInvoicePaymentFailed(
      paymentFailedEvent(),
      ctx(100, 'evt_failed_older'),
      transaction as never,
    );

    expect(newer?.payload.id).toBe('evt_failed_newer');
    expect(older).toBeNull();
    expect(store[0]!.payment_failed_at?.toISOString()).toBe(
      new Date(300 * 1000).toISOString(),
    );
  });

  it('fires once on the legitimate first failure', async () => {
    const effect = await handleInvoicePaymentFailed(
      paymentFailedEvent(),
      ctx(100, 'evt_failed_a'),
      transaction as never,
    );
    expect(store[0]!.status).toBe('failed');
    expect(effect?.payload.id).toBe('evt_failed_a');
  });

  it('lets a late success settle a previously failed invoice', async () => {
    store[0]!.status = 'failed';
    const effect = await handleInvoicePaid(
      paidEvent(),
      ctx(300, 'evt_paid_b'),
      transaction as never,
    );
    expect(store[0]!.status).toBe('paid');
    expect(effect).toBeNull();
  });

  it.each([
    [100, 300],
    [300, 100],
  ])(
    'converges paid_at to the newest timestamp for delivery order %s then %s',
    async (firstCreated, secondCreated) => {
      await handleInvoicePaid(
        paidEvent(),
        ctx(firstCreated, `evt_paid_${firstCreated}`),
        transaction as never,
      );
      await handleInvoicePaid(
        paidEvent(),
        ctx(secondCreated, `evt_paid_${secondCreated}`),
        transaction as never,
      );

      expect(store[0]!.status).toBe('paid');
      expect(store[0]!.paid_at?.toISOString()).toBe(
        new Date(300 * 1000).toISOString(),
      );
    },
  );

  it('audits an older viewed event as a stale replay, not a missing invoice', async () => {
    await handleInvoiceViewed(
      viewedEvent(),
      ctx(300, 'evt_viewed_newer'),
      transaction as never,
    );
    auditLogSpy.mockClear();

    await handleInvoiceViewed(
      viewedEvent(),
      ctx(100, 'evt_viewed_older'),
      transaction as never,
    );

    expect(auditLogSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'billing.webhook_replay_ignored',
        resource_id: 'inv-1',
      }),
    );
  });

  it.each([
    [100, 300],
    [300, 100],
  ])(
    'converges last_viewed_at to the newest timestamp for delivery order %s then %s',
    async (firstCreated, secondCreated) => {
      await handleInvoiceViewed(
        viewedEvent(),
        ctx(firstCreated, `evt_viewed_${firstCreated}`),
        transaction as never,
      );
      await handleInvoiceViewed(
        viewedEvent(),
        ctx(secondCreated, `evt_viewed_${secondCreated}`),
        transaction as never,
      );

      expect(store[0]!.last_viewed_at?.toISOString()).toBe(
        new Date(300 * 1000).toISOString(),
      );
    },
  );
});
