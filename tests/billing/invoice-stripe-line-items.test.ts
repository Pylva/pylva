// Regression: generated Stripe invoices must carry the computed amount without
// leaving billable, untracked Stripe drafts when local persistence fails.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const BUILDER_ID = '00000000-0000-0000-0000-000000000001';
const STRIPE_ACCOUNT = 'acct_test_1';
const PERIOD = { start: new Date('2026-04-01T00:00:00Z'), end: new Date('2026-05-01T00:00:00Z') };

interface InvRow {
  id: string;
  builder_id: string;
  draft_key: string | null;
  stripe_invoice_id: string;
  amount_usd: string;
  billing_cycle_id: string | null;
  has_unpriced_events: boolean;
  line_items?: unknown[];
  [k: string]: unknown;
}
let store: InvRow[] = [];
let idSeq = 0;

type Cond = { kind: 'eq'; col: string; val: unknown } | { kind: 'and'; conds: Cond[] };
function matches(row: Record<string, unknown>, cond: Cond): boolean {
  if (cond.kind === 'and') return cond.conds.every((c) => matches(row, c));
  return row[cond.col] === cond.val;
}

function hasEq(cond: Cond, col: string): boolean {
  if (cond.kind === 'and') return cond.conds.some((c) => hasEq(c, col));
  return cond.col === col;
}

vi.mock('drizzle-orm', () => ({
  eq: (col: { name: string }, val: unknown) => ({ kind: 'eq', col: col.name, val }),
  and: (...conds: Cond[]) => ({ kind: 'and', conds }),
  desc: () => ({}),
  gte: () => ({}),
  isNull: () => ({}),
  lt: () => ({}),
  or: () => ({}),
}));

vi.mock('../../src/lib/db/schema.js', () => ({
  invoices: {
    __table: 'invoices',
    id: { name: 'id' },
    builder_id: { name: 'builder_id' },
    draft_key: { name: 'draft_key' },
    stripe_invoice_id: { name: 'stripe_invoice_id' },
    amount_usd: { name: 'amount_usd' },
    billing_cycle_id: { name: 'billing_cycle_id' },
    has_unpriced_events: { name: 'has_unpriced_events' },
  },
  stripeConnect: {
    __table: 'stripe_connect',
    builder_id: { name: 'builder_id' },
    stripe_account_id: { name: 'stripe_account_id' },
    status: { name: 'status' },
    capabilities_ok: { name: 'capabilities_ok' },
  },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }),
  },
}));

vi.mock('../../src/lib/auth/audit-log.js', () => ({ auditLog: () => Promise.resolve() }));

vi.mock('../../src/lib/clickhouse/customer-id.js', () => ({
  resolveCustomerComposite: () => Promise.resolve(`${BUILDER_ID}:ext-1`),
}));

let usageByMetric: Record<string, number> = {};
vi.mock('../../src/lib/billing/clickhouse-usage.js', () => ({
  getUsageForPeriod: () =>
    Promise.resolve({ by_model: {}, by_metric: usageByMetric, has_unpriced: false }),
}));

vi.mock('../../src/lib/stripe/ensure-customer.js', () => ({
  ensureStripeCustomer: () => Promise.resolve({ stripe_customer_id: 'cus_1', created: false }),
}));

interface ItemCall {
  customer: string;
  invoice: string;
  amount: number;
  currency: string;
  description: string;
}
interface InvoiceCreateCall {
  customer: string;
  collection_method?: string;
  days_until_due?: number;
  auto_advance?: boolean;
  metadata?: Record<string, string>;
}
let invoiceCreateSeq = 0;
let invoiceCreateCalls: InvoiceCreateCall[] = [];
let invoiceItemCalls: ItemCall[] = [];
let deletedInvoiceIds: string[] = [];
let failInvoiceItemAt: number | null = null;
let failInvoiceDelete = false;
vi.mock('../../src/lib/stripe/client.js', () => ({
  stripeFor: () => ({
    invoices: {
      create: (args: InvoiceCreateCall) => {
        invoiceCreateCalls.push(args);
        return Promise.resolve({ id: `in_${++invoiceCreateSeq}` });
      },
      del: (invoiceId: string) => {
        deletedInvoiceIds.push(invoiceId);
        if (failInvoiceDelete) {
          return Promise.reject(new Error('stripe draft delete failed'));
        }
        return Promise.resolve({ id: invoiceId, deleted: true });
      },
    },
    invoiceItems: {
      create: (args: ItemCall) => {
        invoiceItemCalls.push(args);
        if (failInvoiceItemAt === invoiceItemCalls.length) {
          return Promise.reject(new Error('stripe invoice item create failed'));
        }
        return Promise.resolve({ id: `ii_${invoiceItemCalls.length}` });
      },
    },
  }),
}));

let perUnitRates: Record<string, number> = {};
let markupPct = 0;
vi.mock('../../src/lib/billing/pricing-versioning.js', () => ({
  getVersionsInPeriod: () =>
    Promise.resolve([
      {
        id: 'v-1',
        builder_id: BUILDER_ID,
        customer_id: 'cust-1',
        pricing_model: 'pay_as_you_go',
        version: 1,
        effective_from: new Date('2026-03-01T00:00:00Z'),
        effective_to: null,
        billing_period: 'monthly',
        stripe_customer_id: 'cus_1',
      },
    ]),
  rowToCustomerPricing: () => ({
    pricing_model: 'pay_as_you_go',
    per_unit_rates: perUnitRates,
    markup_pct: markupPct,
    version: 1,
  }),
}));

let failInsert = false;
let hideNextDraftKeySelect = false;
vi.mock('../../src/lib/db/rls.js', () => ({
  withRLS: (_b: string, cb: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      select: () => ({
        from: (table: { __table: string }) => ({
          where: (cond: Cond) => ({
            limit: () => {
              if (table.__table === 'stripe_connect') {
                return Promise.resolve([
                  { stripe_account_id: STRIPE_ACCOUNT, status: 'connected', capabilities_ok: true },
                ]);
              }
              if (hideNextDraftKeySelect && hasEq(cond, 'draft_key')) {
                hideNextDraftKeySelect = false;
                return Promise.resolve([]);
              }
              return Promise.resolve(
                store.filter((r) => matches(r as unknown as Record<string, unknown>, cond)),
              );
            },
          }),
        }),
      }),
      insert: () => ({
        values: (vals: Partial<InvRow>) => ({
          onConflictDoNothing: () => ({
            returning: () => {
              if (failInsert) return Promise.reject(new Error('db insert failed'));
              const dupe =
                vals.draft_key == null
                  ? null
                  : store.find(
                      (r) => r.builder_id === vals.builder_id && r.draft_key === vals.draft_key,
                    );
              if (dupe) return Promise.resolve([]);
              const row: InvRow = {
                ...(vals as InvRow),
                id: `inv-${++idSeq}`,
                billing_cycle_id: vals.billing_cycle_id ?? null,
                has_unpriced_events: vals.has_unpriced_events ?? false,
              };
              store.push(row);
              return Promise.resolve([row]);
            },
          }),
        }),
      }),
    };
    return cb(tx);
  },
}));

const { generateInvoice } = await import('../../src/lib/billing/invoice-generator.js');

function setMetricCount(count: number): void {
  usageByMetric = {};
  perUnitRates = {};
  for (let i = 0; i < count; i++) {
    const metric = `metric_${String(i + 1).padStart(3, '0')}`;
    usageByMetric[metric] = 1;
    perUnitRates[metric] = 1;
  }
}

function stripeTotalCents(): number {
  return invoiceItemCalls.reduce((sum, call) => sum + call.amount, 0);
}

beforeEach(() => {
  store = [];
  idSeq = 0;
  invoiceCreateSeq = 0;
  invoiceCreateCalls = [];
  invoiceItemCalls = [];
  deletedInvoiceIds = [];
  failInvoiceItemAt = null;
  failInvoiceDelete = false;
  failInsert = false;
  hideNextDraftKeySelect = false;
  markupPct = 10;
  usageByMetric = { credits: 10_000 };
  perUnitRates = { credits: 0.01 };
});

describe('generateInvoice — pushes computed line items onto the Stripe invoice', () => {
  it('attaches one Stripe invoice item per formula line, in USD cents', async () => {
    const results = await generateInvoice({
      builderId: BUILDER_ID,
      customerId: 'cust-1',
      period: PERIOD,
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.amount_usd).toBe(110);
    expect(invoiceItemCalls).toHaveLength(2);
    for (const call of invoiceItemCalls) {
      expect(call.invoice).toBe('in_1');
      expect(call.currency).toBe('usd');
      expect(call.customer).toBe('cus_1');
    }
    const amounts = invoiceItemCalls.map((c) => c.amount).sort((a, b) => a - b);
    expect(amounts).toEqual([1_000, 10_000]);
    expect(stripeTotalCents() / 100).toBe(results[0]!.amount_usd);
    expect(store[0]!.line_items).toHaveLength(2);
  });

  it('creates Stripe drafts as manual-send invoices with 30-day payment terms', async () => {
    await generateInvoice({ builderId: BUILDER_ID, customerId: 'cust-1', period: PERIOD });

    expect(invoiceCreateCalls).toHaveLength(1);
    expect(invoiceCreateCalls[0]).toMatchObject({
      customer: 'cus_1',
      collection_method: 'send_invoice',
      days_until_due: 30,
      auto_advance: false,
    });
  });

  it('never leaves the Stripe invoice empty (regression: $0 finalize)', async () => {
    await generateInvoice({ builderId: BUILDER_ID, customerId: 'cust-1', period: PERIOD });
    expect(invoiceItemCalls.length).toBeGreaterThan(0);
  });

  it('deletes the Stripe draft if invoice item creation fails', async () => {
    failInvoiceItemAt = 2;

    await expect(
      generateInvoice({ builderId: BUILDER_ID, customerId: 'cust-1', period: PERIOD }),
    ).rejects.toThrow(/stripe invoice item create failed/);

    expect(deletedInvoiceIds).toEqual(['in_1']);
    expect(store).toHaveLength(0);
  });

  it('deletes the Stripe draft if the DB insert fails after item creation', async () => {
    failInsert = true;

    await expect(
      generateInvoice({ builderId: BUILDER_ID, customerId: 'cust-1', period: PERIOD }),
    ).rejects.toThrow(/db insert failed/);

    expect(invoiceItemCalls).toHaveLength(2);
    expect(deletedInvoiceIds).toEqual(['in_1']);
    expect(store).toHaveLength(0);
  });

  it('preserves the DB insert root cause when cleanup deletion also fails', async () => {
    failInsert = true;
    failInvoiceDelete = true;

    await expect(
      generateInvoice({ builderId: BUILDER_ID, customerId: 'cust-1', period: PERIOD }),
    ).rejects.toThrow(
      /db insert failed; additionally failed to delete Stripe draft invoice in_1: stripe draft delete failed/,
    );

    expect(deletedInvoiceIds).toEqual(['in_1']);
    expect(store).toHaveLength(0);
  });

  it('preserves the invoice-item root cause when cleanup deletion also fails', async () => {
    failInvoiceItemAt = 2;
    failInvoiceDelete = true;

    await expect(
      generateInvoice({ builderId: BUILDER_ID, customerId: 'cust-1', period: PERIOD }),
    ).rejects.toThrow(
      /stripe invoice item create failed; additionally failed to delete Stripe draft invoice in_1: stripe draft delete failed/,
    );

    expect(deletedInvoiceIds).toEqual(['in_1']);
    expect(store).toHaveLength(0);
  });

  it('deletes the loser Stripe draft when the draft_key insert loses a race', async () => {
    const draftKeyBase = 'monthly:2026-04-01:cust-1';
    store.push({
      id: 'inv-winner',
      builder_id: BUILDER_ID,
      draft_key: `${draftKeyBase}:v1:s0`,
      stripe_invoice_id: 'in_winner',
      amount_usd: '110',
      billing_cycle_id: null,
      has_unpriced_events: false,
    });
    hideNextDraftKeySelect = true;

    const results = await generateInvoice({
      builderId: BUILDER_ID,
      customerId: 'cust-1',
      period: PERIOD,
      draftKeyBase,
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.invoice_id).toBe('inv-winner');
    expect(results[0]!.stripe_invoice_id).toBe('in_winner');
    expect(deletedInvoiceIds).toEqual(['in_1']);
    expect(store).toHaveLength(1);
  });

  it('rejects when conflict-loser cleanup cannot delete the loser Stripe draft', async () => {
    const draftKeyBase = 'monthly:2026-04-01:cust-1';
    store.push({
      id: 'inv-winner',
      builder_id: BUILDER_ID,
      draft_key: `${draftKeyBase}:v1:s0`,
      stripe_invoice_id: 'in_winner',
      amount_usd: '110',
      billing_cycle_id: null,
      has_unpriced_events: false,
    });
    hideNextDraftKeySelect = true;
    failInvoiceDelete = true;

    await expect(
      generateInvoice({
        builderId: BUILDER_ID,
        customerId: 'cust-1',
        period: PERIOD,
        draftKeyBase,
      }),
    ).rejects.toThrow(/failed to delete Stripe draft invoice in_1: stripe draft delete failed/);

    expect(deletedInvoiceIds).toEqual(['in_1']);
    expect(store).toHaveLength(1);
  });

  it('sends exactly 50 Stripe items without summarizing', async () => {
    markupPct = 0;
    setMetricCount(50);

    const results = await generateInvoice({
      builderId: BUILDER_ID,
      customerId: 'cust-1',
      period: PERIOD,
    });

    expect(results[0]!.amount_usd).toBe(50);
    expect(invoiceItemCalls).toHaveLength(50);
    expect(invoiceItemCalls.some((call) => call.description.startsWith('Other usage'))).toBe(false);
    expect(stripeTotalCents()).toBe(5_000);
    expect(store[0]!.line_items).toHaveLength(50);
  });

  it('summarizes 51 Stripe items to stay within the readability limit', async () => {
    markupPct = 0;
    setMetricCount(51);

    const results = await generateInvoice({
      builderId: BUILDER_ID,
      customerId: 'cust-1',
      period: PERIOD,
    });

    const other = invoiceItemCalls.find((call) => call.description === 'Other usage (2 metrics)');
    expect(results[0]!.amount_usd).toBe(51);
    expect(invoiceItemCalls).toHaveLength(50);
    expect(other?.amount).toBe(200);
    expect(stripeTotalCents()).toBe(5_100);
    expect(store[0]!.line_items).toHaveLength(51);
  });

  it('preserves markup as its own Stripe line while summarizing large metric sets', async () => {
    markupPct = 10;
    setMetricCount(60);

    const results = await generateInvoice({
      builderId: BUILDER_ID,
      customerId: 'cust-1',
      period: PERIOD,
    });

    const other = invoiceItemCalls.find((call) => call.description === 'Other usage (12 metrics)');
    const markup = invoiceItemCalls.find((call) => call.description === 'Markup (10%)');
    expect(results[0]!.amount_usd).toBe(66);
    expect(invoiceItemCalls).toHaveLength(50);
    expect(other?.amount).toBe(1_200);
    expect(markup?.amount).toBe(600);
    expect(stripeTotalCents()).toBe(6_600);
    expect(store[0]!.line_items).toHaveLength(61);
  });
});
