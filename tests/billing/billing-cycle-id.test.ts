// Regression: auto-split billing_cycle_id must be STABLE across re-runs /
// concurrent pods so every slice of one cycle shares a single id (I-T2-10).
//
// Bug: billing_cycle_id was randomUUID() per generateInvoice() invocation.
// The monthly-drafts cron tolerates concurrent pods / same-window re-runs by
// inserting each slice with ON CONFLICT DO NOTHING on (builder_id, draft_key).
// When two invocations each win the INSERT for a DIFFERENT slice of the same
// auto-split cycle, the slices got DIFFERENT billing_cycle_ids — fracturing
// one billing cycle into two and breaking the dashboard grouping +
// `GET /invoices?billing_cycle_id=` filter (a builder can miss the 2nd draft).
//
// We reproduce via the partial-failure re-run, which exercises the exact same
// "slice already persisted by a prior invocation, this invocation inserts the
// other slice" mechanism as the concurrent-pod race.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { billingCycleIdFor } from '../../src/lib/billing/auto-split.js';

const BUILDER_ID = '00000000-0000-0000-0000-000000000001';
const STRIPE_ACCOUNT = 'acct_test_1';

// --- in-memory invoices store -------------------------------------------------
interface InvRow {
  id: string;
  builder_id: string;
  draft_key: string | null;
  stripe_invoice_id: string;
  amount_usd: string;
  billing_cycle_id: string | null;
  has_unpriced_events: boolean;
  [k: string]: unknown;
}
let store: InvRow[] = [];
let idSeq = 0;

// --- drizzle cond mock --------------------------------------------------------
type Cond = { kind: 'eq'; col: string; val: unknown } | { kind: 'and'; conds: Cond[] };
function matches(row: Record<string, unknown>, cond: Cond): boolean {
  if (cond.kind === 'and') return cond.conds.every((c) => matches(row, c));
  return row[cond.col] === cond.val;
}

vi.mock('drizzle-orm', () => ({
  eq: (col: { name: string }, val: unknown) => ({ kind: 'eq', col: col.name, val }),
  and: (...conds: Cond[]) => ({ kind: 'and', conds }),
  // stubs so other loaded modules' top-level imports resolve.
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

let usageCalls = 0;
let failUsageAt: number | null = null;
vi.mock('../../src/lib/billing/clickhouse-usage.js', () => ({
  BillingPeriodOpenError: class BillingPeriodOpenError extends Error {},
  BudgetProjectionPendingError: class BudgetProjectionPendingError extends Error {},
  BudgetUsageAggregateError: class BudgetUsageAggregateError extends Error {},
  assertAuthoritativeProjectionReady: () => Promise.resolve(),
  getUsageForPeriod: () => {
    usageCalls += 1;
    if (failUsageAt === usageCalls) {
      return Promise.reject(new Error('usage preflight failure (simulated)'));
    }
    return Promise.resolve({ by_model: {}, by_metric: {}, has_unpriced: false });
  },
}));

vi.mock('../../src/lib/stripe/ensure-customer.js', () => ({
  ensureStripeCustomer: () => Promise.resolve({ stripe_customer_id: 'cus_1', created: false }),
}));

let stripeCreateCalls = 0;
let failOnCreateCall: number | null = null;
vi.mock('../../src/lib/stripe/client.js', () => ({
  stripeFor: () => ({
    invoices: {
      create: () => {
        stripeCreateCalls += 1;
        if (failOnCreateCall === stripeCreateCalls) {
          return Promise.reject(new Error('stripe transient failure (simulated)'));
        }
        return Promise.resolve({ id: `in_${stripeCreateCalls}` });
      },
    },
    invoiceItems: {
      create: () => Promise.resolve({ id: `ii_${stripeCreateCalls}` }),
    },
  }),
}));

// Two versions whose effective windows split the April period in two.
function mkVersion(n: number, from: string, to: string | null) {
  return {
    id: `v-${n}`,
    builder_id: BUILDER_ID,
    customer_id: 'cust-1',
    pricing_model: 'flat',
    version: n,
    effective_from: new Date(from),
    effective_to: to ? new Date(to) : null,
    flat_rate_usd: '10.00',
    per_unit_rates: null,
    pack_price_usd: null,
    included_credits: null,
    overage_rate_usd: null,
    markup_pct: null,
    base_fee_usd: null,
    billing_period: 'monthly',
    stripe_customer_id: null,
  };
}
vi.mock('../../src/lib/billing/pricing-versioning.js', () => ({
  getVersionsInPeriod: () =>
    Promise.resolve([
      mkVersion(1, '2026-03-15T00:00:00Z', '2026-04-15T00:00:00Z'),
      mkVersion(2, '2026-04-15T00:00:00Z', null),
    ]),
  rowToCustomerPricing: (row: {
    pricing_model: string;
    flat_rate_usd: string;
    version: number;
  }) => ({
    pricing_model: row.pricing_model,
    flat_rate_usd: Number(row.flat_rate_usd),
    version: row.version,
  }),
}));

// withRLS: route reads/writes through an in-memory store.
vi.mock('../../src/lib/db/rls.js', () => ({
  withRLS: (_b: string, cb: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      select: (_proj?: unknown) => ({
        from: (table: { __table: string }) => ({
          where: (cond: Cond) => ({
            limit: () => {
              if (table.__table === 'stripe_connect') {
                return Promise.resolve([
                  { stripe_account_id: STRIPE_ACCOUNT, status: 'connected', capabilities_ok: true },
                ]);
              }
              return Promise.resolve(
                store.filter((r) => matches(r as unknown as Record<string, unknown>, cond)),
              );
            },
          }),
        }),
      }),
      insert: (_table: unknown) => ({
        values: (vals: Partial<InvRow>) => ({
          onConflictDoNothing: () => ({
            returning: () => {
              const dupe = store.find(
                (r) => r.builder_id === vals.builder_id && r.draft_key === vals.draft_key,
              );
              if (dupe) return Promise.resolve([]); // ON CONFLICT DO NOTHING
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

const PERIOD = { start: new Date('2026-04-01T00:00:00Z'), end: new Date('2026-05-01T00:00:00Z') };
const DRAFT_KEY_BASE = 'monthly:2026-04-01:cust-1';

beforeEach(() => {
  store = [];
  idSeq = 0;
  stripeCreateCalls = 0;
  failOnCreateCall = null;
  usageCalls = 0;
  failUsageAt = null;
});

describe('billingCycleIdFor()', () => {
  it('is deterministic and a valid UUID', () => {
    const a = billingCycleIdFor('seed-x');
    const b = billingCycleIdFor('seed-x');
    expect(a).toBe(b);
    expect(a).toBe('08449eb9-670e-58f7-8dcb-ff0ad7f9e1e5');
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('differs across distinct seeds (builder / period / customer)', () => {
    expect(billingCycleIdFor('b1:monthly:2026-04-01:cust-1')).not.toBe(
      billingCycleIdFor('b1:monthly:2026-04-01:cust-2'),
    );
    expect(billingCycleIdFor('b1:monthly:2026-04-01:cust-1')).not.toBe(
      billingCycleIdFor('b2:monthly:2026-04-01:cust-1'),
    );
  });
});

describe('generateInvoice — auto-split billing_cycle_id stability', () => {
  it('keeps a single billing_cycle_id across a partial-failure re-run', async () => {
    // Invocation 1: slice 0 persists, slice 1's Stripe call fails (2nd create).
    failOnCreateCall = 2;
    await expect(
      generateInvoice({
        builderId: BUILDER_ID,
        customerId: 'cust-1',
        period: PERIOD,
        draftKeyBase: DRAFT_KEY_BASE,
      }),
    ).rejects.toThrow(/simulated/);
    expect(store).toHaveLength(1);

    // Invocation 2 (re-run): slice 0 dedupes, slice 1 inserts fresh.
    failOnCreateCall = null;
    const results = await generateInvoice({
      builderId: BUILDER_ID,
      customerId: 'cust-1',
      period: PERIOD,
      draftKeyBase: DRAFT_KEY_BASE,
    });
    expect(results).toHaveLength(2);
    expect(store).toHaveLength(2);

    const cycleIds = store.map((r) => r.billing_cycle_id);
    expect(cycleIds[0]).toBeTruthy();
    // The regression: the second invocation must NOT mint a fresh cycle id for
    // the slice it inserts — both slices belong to one cycle.
    expect(cycleIds[0]).toBe(cycleIds[1]);
    expect(store[0]!.billing_cycle_id).toBe(billingCycleIdFor(`${BUILDER_ID}:${DRAFT_KEY_BASE}`));
  });

  it('a clean single run already shares one id across both slices', async () => {
    const results = await generateInvoice({
      builderId: BUILDER_ID,
      customerId: 'cust-1',
      period: PERIOD,
      draftKeyBase: DRAFT_KEY_BASE,
    });
    expect(results).toHaveLength(2);
    expect(store[0]!.billing_cycle_id).toBe(store[1]!.billing_cycle_id);
  });

  it('preflights every slice before creating any Stripe draft or invoice row', async () => {
    failUsageAt = 2;

    await expect(
      generateInvoice({
        builderId: BUILDER_ID,
        customerId: 'cust-1',
        period: PERIOD,
        draftKeyBase: DRAFT_KEY_BASE,
      }),
    ).rejects.toThrow(/usage preflight failure/);

    expect(usageCalls).toBe(2);
    expect(stripeCreateCalls).toBe(0);
    expect(store).toHaveLength(0);
  });
});
