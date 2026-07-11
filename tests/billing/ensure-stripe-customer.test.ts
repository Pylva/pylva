import { beforeEach, describe, expect, it, vi } from 'vitest';

const BUILDER_ID = '00000000-0000-4000-8000-000000000001';
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const STRIPE_ACCOUNT_ID = 'acct_test_1';

type Cond =
  | { kind: 'eq'; col: string; val: unknown }
  | { kind: 'and'; conds: Cond[] }
  | { kind: 'isNull'; col: string };

interface PricingRow {
  id: string;
  stripe_customer_id: string | null;
}

interface CustomerRow {
  external_id: string;
  name: string | null;
  email: string | null;
}

let pricingRow: PricingRow | null;
let customerRow: CustomerRow | null;
let dbUpdates: Record<string, unknown>[];
const stripeCreate = vi.fn();
const stripeUpdate = vi.fn();

vi.mock('drizzle-orm', () => ({
  eq: (col: { name: string }, val: unknown) => ({ kind: 'eq', col: col.name, val }),
  and: (...conds: Cond[]) => ({ kind: 'and', conds }),
  isNull: (col: { name: string }) => ({ kind: 'isNull', col: col.name }),
}));

vi.mock('../../src/lib/db/schema.js', () => ({
  customerPricing: {
    __table: 'customer_pricing',
    id: { name: 'id' },
    builder_id: { name: 'builder_id' },
    customer_id: { name: 'customer_id' },
    stripe_customer_id: { name: 'stripe_customer_id' },
    effective_to: { name: 'effective_to' },
    updated_at: { name: 'updated_at' },
  },
  customers: {
    __table: 'customers',
    id: { name: 'id' },
    builder_id: { name: 'builder_id' },
    external_id: { name: 'external_id' },
    name: { name: 'name' },
    email: { name: 'email' },
  },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }),
  },
}));

vi.mock('../../src/lib/stripe/client.js', () => ({
  stripeFor: (accountId?: string) => {
    expect(accountId).toBe(STRIPE_ACCOUNT_ID);
    return {
      customers: {
        create: stripeCreate,
        update: stripeUpdate,
      },
    };
  },
}));

vi.mock('../../src/lib/db/rls.js', () => ({
  withRLS: (_builderId: string, cb: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      select: () => ({
        from: (table: { __table: string }) => ({
          where: () => ({
            limit: () => {
              if (table.__table === 'customer_pricing') {
                return Promise.resolve(pricingRow ? [pricingRow] : []);
              }
              if (table.__table === 'customers') {
                return Promise.resolve(customerRow ? [customerRow] : []);
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

const { ensureStripeCustomer } = await import('../../src/lib/stripe/ensure-customer.js');

beforeEach(() => {
  pricingRow = { id: 'pricing-1', stripe_customer_id: null };
  customerRow = {
    external_id: 'lg_onboarding_audit_cust_1',
    name: 'Onboarding Audit Customer 1',
    email: 'onboarding-cust-1@example.com',
  };
  dbUpdates = [];
  stripeCreate.mockReset().mockResolvedValue({ id: 'cus_new_123' });
  stripeUpdate.mockReset().mockResolvedValue({ id: 'cus_cached_123' });
});

describe('ensureStripeCustomer()', () => {
  it('creates Stripe customers with the local end-customer email, name, and metadata', async () => {
    const result = await ensureStripeCustomer({
      builderId: BUILDER_ID,
      customerId: CUSTOMER_ID,
      stripeAccountId: STRIPE_ACCOUNT_ID,
      metadata: { pylva_pricing_version: '3' },
    });

    expect(result).toEqual({ stripe_customer_id: 'cus_new_123', created: true });
    expect(stripeCreate).toHaveBeenCalledWith({
      email: 'onboarding-cust-1@example.com',
      name: 'Onboarding Audit Customer 1',
      metadata: {
        pylva_customer_id: CUSTOMER_ID,
        pylva_builder_id: BUILDER_ID,
        pylva_customer_external_id: 'lg_onboarding_audit_cust_1',
        pylva_pricing_version: '3',
      },
    });
    expect(dbUpdates[0]).toMatchObject({ stripe_customer_id: 'cus_new_123' });
  });

  it('refreshes cached Stripe customers with the latest local email and name', async () => {
    pricingRow = { id: 'pricing-1', stripe_customer_id: 'cus_cached_123' };

    const result = await ensureStripeCustomer({
      builderId: BUILDER_ID,
      customerId: CUSTOMER_ID,
      stripeAccountId: STRIPE_ACCOUNT_ID,
    });

    expect(result).toEqual({ stripe_customer_id: 'cus_cached_123', created: false });
    expect(stripeCreate).not.toHaveBeenCalled();
    expect(stripeUpdate).toHaveBeenCalledWith('cus_cached_123', {
      email: 'onboarding-cust-1@example.com',
      name: 'Onboarding Audit Customer 1',
    });
    expect(dbUpdates).toHaveLength(0);
  });
});
