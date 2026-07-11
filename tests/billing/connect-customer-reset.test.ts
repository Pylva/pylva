// Regression: POST /api/v1/billing/connect must clear cached
// customer_pricing.stripe_customer_id rows.
//
// Trigger scenario:
//   1. Builder connects Stripe account acct_A. Invoice generation creates
//      cus_X on acct_A and caches it on customer_pricing (I-T2-9).
//   2. Builder disconnects, then reconnects — the connect route ALWAYS
//      mints a fresh Stripe account, so the builder is now on acct_B.
//   3. Monthly-drafts cron runs: ensureStripeCustomer returns the cached
//      cus_X, and stripe.invoices.create on acct_B fails with
//      "No such customer" for every existing customer → the cron counts
//      a silent skip → missed invoices every month thereafter.
//
// Pre-fix, nothing ever reset the cached id (the ensure-customer header
// comment promised it "must reset" on reconnect, but no code did it).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server.js';

const BUILDER_ID = '00000000-0000-0000-0000-000000000001';

const accountsCreate = vi.fn();
const accountLinksCreate = vi.fn();

interface UpdateCall {
  table: string;
  set: Record<string, unknown>;
  whereCols: string[];
}
let insertCalls: Array<{ table: string; values: Record<string, unknown> }> = [];
let updateCalls: UpdateCall[] = [];

type Cond =
  | { kind: 'eq'; col: string; val: unknown }
  | { kind: 'isNotNull'; col: string }
  | { kind: 'and'; conds: Cond[] };

function condCols(cond: Cond): string[] {
  switch (cond.kind) {
    case 'and':
      return cond.conds.flatMap(condCols);
    default:
      return [cond.col];
  }
}

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    }),
  },
}));

vi.mock('../../src/lib/config.js', () => ({
  env: { PYLVA_BACKEND_URL: 'http://localhost:3000' },
}));

vi.mock('../../src/lib/auth/builder-context.js', () => ({
  readBuilderContextFromDashboard: () => ({
    builderId: BUILDER_ID,
    userId: 'u-1',
    role: 'owner',
  }),
}));

vi.mock('../../src/lib/auth/middleware.js', () => ({
  withRole: () => null,
}));

vi.mock('@/lib/auth/tier-enforcement', () => ({
  checkBuilderFeatureGate: () => Promise.resolve(null),
}));

vi.mock('../../src/lib/auth/audit-log.js', () => ({
  auditLog: () => Promise.resolve(),
}));

vi.mock('../../src/lib/audit/actions.js', () => ({
  AuditAction: new Proxy({}, { get: (_t, prop) => String(prop) }),
}));

vi.mock('../../src/lib/errors.js', () => ({
  apiError: (status: number, _type: string, _code: string, msg: string, param?: string) =>
    new Response(JSON.stringify({ error: { message: msg, param } }), { status }),
  validationError: (msg: string) => new Response(JSON.stringify({ error: msg }), { status: 400 }),
  internalError: (msg: string) => new Response(JSON.stringify({ error: msg }), { status: 500 }),
}));

vi.mock('../../src/lib/stripe/client.js', () => ({
  stripeFor: () => ({
    accounts: { create: accountsCreate },
    accountLinks: { create: accountLinksCreate },
  }),
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: { name: string }, val: unknown) => ({
    kind: 'eq',
    col: col.name,
    val,
  }),
  isNotNull: (col: { name: string }) => ({ kind: 'isNotNull', col: col.name }),
  and: (...conds: Cond[]) => ({ kind: 'and', conds }),
}));

vi.mock('../../src/lib/db/schema.js', () => ({
  stripeConnect: {
    __table: 'stripe_connect',
    builder_id: { name: 'builder_id' },
    stripe_account_id: { name: 'stripe_account_id' },
  },
  customerPricing: {
    __table: 'customer_pricing',
    builder_id: { name: 'builder_id' },
    stripe_customer_id: { name: 'stripe_customer_id' },
  },
}));

vi.mock('../../src/lib/db/rls.js', () => ({
  withRLS: (_builderId: string, cb: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      insert: (table: { __table: string }) => ({
        values: (values: Record<string, unknown>) => {
          insertCalls.push({ table: table.__table, values });
          return { onConflictDoUpdate: () => Promise.resolve() };
        },
      }),
      update: (table: { __table: string }) => ({
        set: (set: Record<string, unknown>) => ({
          where: (cond: Cond) => {
            updateCalls.push({
              table: table.__table,
              set,
              whereCols: condCols(cond),
            });
            return Promise.resolve([]);
          },
        }),
      }),
    };
    return cb(tx);
  },
}));

const { POST } = await import('../../src/app/api/v1/billing/connect/route.js');
const { StripeConfigurationError } = await import('../../src/lib/stripe/config-error.js');

describe('POST /api/v1/billing/connect — stale Stripe customer cache reset', () => {
  beforeEach(() => {
    insertCalls = [];
    updateCalls = [];
    accountsCreate.mockReset().mockResolvedValue({ id: 'acct_B_fresh' });
    accountLinksCreate
      .mockReset()
      .mockResolvedValue({ url: 'https://connect.stripe.test/onboard' });
  });

  it('clears cached customer_pricing.stripe_customer_id when (re)connecting', async () => {
    const res = await POST(
      new NextRequest('http://localhost/api/v1/billing/connect', {
        method: 'POST',
      }),
    );
    expect(res.status).toBe(200);

    // The stripe_connect upsert still happens with the freshly minted account.
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]!.table).toBe('stripe_connect');
    expect(insertCalls[0]!.values['stripe_account_id']).toBe('acct_B_fresh');

    // The cached customer ids from the previous account are invalidated in
    // the same transaction — scoped to this builder + non-null ids only.
    const reset = updateCalls.find((c) => c.table === 'customer_pricing');
    expect(reset).toBeDefined();
    expect(reset!.set['stripe_customer_id']).toBeNull();
    expect(reset!.whereCols).toContain('builder_id');
    expect(reset!.whereCols).toContain('stripe_customer_id');
  });

  it('returns a clear 503 when Stripe server config is missing during onboarding', async () => {
    accountsCreate.mockRejectedValueOnce(new StripeConfigurationError('STRIPE_SECRET_KEY'));

    const res = await POST(
      new NextRequest('http://localhost/api/v1/billing/connect', {
        method: 'POST',
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.error.param).toBe('stripe');
    expect(body.error.message).toContain('STRIPE_SECRET_KEY');
    expect(insertCalls).toHaveLength(0);
    expect(updateCalls).toHaveLength(0);
  });
});
