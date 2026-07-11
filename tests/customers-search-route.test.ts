import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server.js';

const BUILDER_ID = '00000000-0000-4000-8000-000000000001';

type CustomerRow = {
  id: string;
  external_id: string;
  name: string | null;
  email: string | null;
};

const mocks = vi.hoisted(() => ({
  rows: [] as CustomerRow[],
  seenLimit: 0,
  withRLS: vi.fn(),
}));

vi.mock('@/lib/auth/builder-context', () => ({
  readBuilderContextFromDashboard: () => ({
    builderId: BUILDER_ID,
    userId: 'user-1',
    role: 'owner',
  }),
}));

vi.mock('@/lib/db/rls', () => ({
  withRLS: mocks.withRLS,
}));

const { GET } = await import('../src/app/api/v1/customers/search/route.js');

function request(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/v1/customers/search${query}`);
}

function tx() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: (limit: number) => {
              mocks.seenLimit = limit;
              return Promise.resolve(mocks.rows);
            },
          }),
        }),
      }),
    }),
  };
}

function row(overrides: Partial<CustomerRow>): CustomerRow {
  return {
    id: 'customer-1',
    external_id: 'cust_1',
    name: 'Customer 1',
    email: 'customer-1@example.com',
    ...overrides,
  };
}

describe('GET /api/v1/customers/search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rows = [];
    mocks.seenLimit = 0;
    mocks.withRLS.mockImplementation(async (_builderId: string, cb: (txArg: unknown) => unknown) =>
      cb(tx()),
    );
  });

  it('returns blank-query end-user results through builder-scoped RLS', async () => {
    mocks.rows = [row({ id: 'customer-a', external_id: 'alpha', name: 'Alpha Co' })];

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.withRLS).toHaveBeenCalledWith(BUILDER_ID, expect.any(Function));
    expect(body).toEqual({
      customers: [
        {
          id: 'customer-a',
          external_id: 'alpha',
          name: 'Alpha Co',
          email: 'customer-1@example.com',
        },
      ],
      limit: 500,
      has_more: false,
    });
  });

  it.each([
    ['external ID', '?search=acme_123', row({ external_id: 'acme_123', name: 'Acme' })],
    ['name', '?search=Beta', row({ external_id: 'cust_beta', name: 'Beta Labs' })],
    [
      'email',
      '?search=ops%40example.com',
      row({ external_id: 'cust_ops', name: 'Ops Team', email: 'ops@example.com' }),
    ],
  ])('returns matches when searching by %s', async (_label, query, customer) => {
    mocks.rows = [customer];

    const response = await GET(request(query));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.customers).toEqual([customer]);
  });

  it('caps requested limits at 500 and reports has_more', async () => {
    mocks.rows = Array.from({ length: 501 }, (_, i) =>
      row({
        id: `customer-${i}`,
        external_id: `cust_${i}`,
        name: `Customer ${i}`,
      }),
    );

    const response = await GET(request('?limit=999'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.seenLimit).toBe(501);
    expect(body.limit).toBe(500);
    expect(body.customers).toHaveLength(500);
    expect(body.has_more).toBe(true);
  });
});
