import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server.js';

const BUILDER_ID = '00000000-0000-4000-8000-000000000001';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const STRIPE_ACCOUNT_ID = 'acct_test_1';

type Cond = { kind: 'eq'; col: string; val: unknown } | { kind: 'and'; conds: Cond[] };

let updateCalls: Record<string, unknown>[];
const accountsRetrieve = vi.fn();

vi.mock('@/lib/config', () => ({
  env: {
    OAUTH_REDIRECT_BASE_URL: 'https://app.pylva.test',
    PYLVA_BACKEND_URL: 'https://backend.pylva.test',
  },
}));

vi.mock('@/lib/auth/builder-context', () => ({
  readBuilderContextFromDashboard: () => ({
    builderId: BUILDER_ID,
    userId: USER_ID,
    role: 'owner',
  }),
}));

vi.mock('@/lib/auth/tier-enforcement', () => ({
  checkBuilderFeatureGate: () => Promise.resolve(null),
}));

vi.mock('@/lib/auth/audit-log', () => ({
  auditLog: () => Promise.resolve(),
}));

vi.mock('@/lib/audit/actions', () => ({
  AuditAction: new Proxy({}, { get: (_t, prop) => String(prop) }),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    child: () => ({
      error: () => undefined,
    }),
  },
}));

vi.mock('@/lib/stripe/client', () => ({
  stripeFor: () => ({
    accounts: { retrieve: accountsRetrieve },
  }),
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: { name: string }, val: unknown) => ({ kind: 'eq', col: col.name, val }),
  and: (...conds: Cond[]) => ({ kind: 'and', conds }),
}));

vi.mock('@/lib/db/schema', () => ({
  stripeConnect: {
    __table: 'stripe_connect',
    id: { name: 'id' },
    builder_id: { name: 'builder_id' },
    stripe_account_id: { name: 'stripe_account_id' },
  },
}));

vi.mock('@/lib/db/rls', () => ({
  withRLS: (_builderId: string, cb: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve([{ id: 'stripe-connect-row', stripe_account_id: STRIPE_ACCOUNT_ID }]),
          }),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            updateCalls.push(values);
            return Promise.resolve([]);
          },
        }),
      }),
    };
    return cb(tx);
  },
}));

vi.mock('@/lib/errors', () => ({
  apiError: (status: number, _type: string, _code: string, msg: string, param?: string) =>
    new Response(JSON.stringify({ error: { message: msg, param } }), { status }),
  validationError: (msg: string) => new Response(JSON.stringify({ error: msg }), { status: 400 }),
  internalError: (msg: string) => new Response(JSON.stringify({ error: msg }), { status: 500 }),
}));

const { GET } = await import('../../src/app/api/v1/billing/connect/return/route.js');

describe('GET /api/v1/billing/connect/return redirect origin', () => {
  beforeEach(() => {
    updateCalls = [];
    accountsRetrieve.mockReset().mockResolvedValue({
      capabilities: { card_payments: 'active' },
      payouts_enabled: true,
    });
  });

  it('ignores attacker-controlled Referer when building the dashboard redirect', async () => {
    const response = await GET(
      new NextRequest(
        `http://localhost/api/v1/billing/connect/return?account=${STRIPE_ACCOUNT_ID}`,
        {
          headers: {
            referer: 'https://evil.example/phish',
            'x-pylva-org': 'acme',
          },
        },
      ),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://app.pylva.test/o/acme/dashboard/settings/billing?stripe=connected',
    );
    expect(accountsRetrieve).toHaveBeenCalledWith(STRIPE_ACCOUNT_ID);
    expect(updateCalls[0]).toEqual(
      expect.objectContaining({
        status: 'connected',
        capabilities_ok: true,
      }),
    );
  });
});
