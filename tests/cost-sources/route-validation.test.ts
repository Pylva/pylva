import { beforeEach, describe, expect, it, vi } from 'vitest';

const routeMocks = vi.hoisted(() => ({
  auditLog: vi.fn(),
  ctx: {
    builderId: '00000000-0000-4000-8000-000000000001',
    keyId: 'key-1',
    role: 'owner',
    userId: 'user-1',
  },
  withRLS: vi.fn(),
  withRole: vi.fn(),
}));

vi.mock('@/lib/auth/builder-context', () => ({
  readBuilderContext: () => ({
    builderId: routeMocks.ctx.builderId,
    keyId: routeMocks.ctx.keyId,
  }),
  readBuilderContextFromDashboard: () => ({
    builderId: routeMocks.ctx.builderId,
    role: routeMocks.ctx.role,
    userId: routeMocks.ctx.userId,
  }),
}));

vi.mock('@/lib/auth/middleware', () => ({
  Role: { MEMBER: 'member', OWNER: 'owner' },
  withRole: routeMocks.withRole,
}));

vi.mock('@/lib/auth/audit-log', () => ({
  auditLog: routeMocks.auditLog,
}));

vi.mock('@/lib/db/rls', () => ({
  withRLS: routeMocks.withRLS,
}));

const { PATCH, POST } = await import('../../src/app/api/v1/cost-sources/route.js');

function makeDashboardRequest(
  opts: {
    method?: 'POST' | 'PATCH';
    body?: Record<string, unknown>;
    query?: Record<string, string>;
  } = {},
) {
  const url = new URL('http://localhost/api/v1/cost-sources');
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    url.searchParams.set(key, value);
  }
  return new Request(url, {
    method: opts.method ?? 'POST',
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    headers: opts.body === undefined ? undefined : { 'content-type': 'application/json' },
  }) as unknown as import('next/server.js').NextRequest;
}

function costSourceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    builder_id: routeMocks.ctx.builderId,
    source_type: 'non_llm_manual',
    display_name: 'Search API',
    slug: 'search-api',
    metric: 'search_query',
    unit: 'request',
    price_per_unit: '0.01',
    pricing_tiers: null,
    status: 'healthy',
    tracking_status: 'tracked',
    matchers: ['search-api'],
    default_metric_value: 1,
    last_seen_at: null,
    last_discovered_at: null,
    discovery_count: 0,
    approved_at: new Date('2026-04-18T10:00:00Z'),
    created_at: new Date('2026-04-18T10:00:00Z'),
    ...overrides,
  };
}

function makeTx() {
  return {
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => [
            costSourceRow({
              price_per_unit: values['price_per_unit'] ?? null,
              pricing_tiers: values['pricing_tiers'] ?? null,
              tracking_status: values['tracking_status'] ?? 'tracked',
              matchers: values['matchers'] ?? ['search-api'],
              default_metric_value:
                values['default_metric_value'] === undefined ? 1 : values['default_metric_value'],
            }),
          ],
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [costSourceRow()],
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => [
            costSourceRow({
              ...values,
              price_per_unit:
                values['price_per_unit'] === undefined ? '0.01' : values['price_per_unit'],
              pricing_tiers: values['pricing_tiers'] === undefined ? null : values['pricing_tiers'],
            }),
          ],
        }),
      }),
    }),
  };
}

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    display_name: 'Search API',
    slug: 'search-api',
    source_type: 'non_llm_manual',
    metric: 'search_query',
    unit: 'request',
    price_per_unit: 0.01,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  routeMocks.withRole.mockReturnValue(null);
  routeMocks.withRLS.mockImplementation(
    async (_builderId: string, cb: (tx: unknown) => Promise<unknown>) => cb(makeTx()),
  );
});

describe('cost-sources route pricing validation', () => {
  it('rejects negative flat prices on create', async () => {
    const res = await POST(
      makeDashboardRequest({
        method: 'POST',
        body: createBody({ price_per_unit: -0.01 }),
      }),
    );

    expect(res.status).toBe(400);
    expect(routeMocks.withRLS).not.toHaveBeenCalled();
  });

  it('rejects negative tier values on create', async () => {
    const res = await POST(
      makeDashboardRequest({
        method: 'POST',
        body: createBody({
          price_per_unit: undefined,
          pricing_tiers: [{ from: 0, to: null, price: -0.01 }],
        }),
      }),
    );

    expect(res.status).toBe(400);
    expect(routeMocks.withRLS).not.toHaveBeenCalled();
  });

  it('accepts zero flat prices on create', async () => {
    const res = await POST(
      makeDashboardRequest({
        method: 'POST',
        body: createBody({ price_per_unit: 0 }),
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.cost_source.price_per_unit).toBe(0);
  });

  it('rejects negative flat prices on patch', async () => {
    const res = await PATCH(
      makeDashboardRequest({
        method: 'PATCH',
        query: { slug: 'search-api' },
        body: { price_per_unit: -1 },
      }),
    );

    expect(res.status).toBe(400);
    expect(routeMocks.withRLS).not.toHaveBeenCalled();
  });

  it('rejects negative tier values on patch', async () => {
    const res = await PATCH(
      makeDashboardRequest({
        method: 'PATCH',
        query: { slug: 'search-api' },
        body: { pricing_tiers: [{ from: -1, to: null, price: 0.01 }] },
      }),
    );

    expect(res.status).toBe(400);
    expect(routeMocks.withRLS).not.toHaveBeenCalled();
  });

  it('accepts null flat-price clears and valid positive tiers on patch', async () => {
    const tiers = [
      { from: 0, to: 1000, price: 0 },
      { from: 1000, to: null, price: 0.01 },
    ];
    const res = await PATCH(
      makeDashboardRequest({
        method: 'PATCH',
        query: { slug: 'search-api' },
        body: { price_per_unit: null, pricing_tiers: tiers },
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.cost_source.price_per_unit).toBeNull();
    expect(body.cost_source.pricing_tiers).toEqual(tiers);
  });

  it('allows pending non-LLM creates without pricing', async () => {
    const res = await POST(
      makeDashboardRequest({
        method: 'POST',
        body: {
          display_name: 'Tavily Search',
          slug: 'tavily-search',
          source_type: 'non_llm_manual',
          tracking_status: 'pending',
          matchers: ['Tavily Search'],
        },
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.cost_source.tracking_status).toBe('pending');
    expect(body.cost_source.default_metric_value).toBeNull();
  });

  it('rejects activating a non-LLM source without pricing', async () => {
    routeMocks.withRLS.mockImplementationOnce(
      async (_builderId: string, cb: (tx: unknown) => Promise<unknown>) =>
        cb({
          ...makeTx(),
          select: () => ({
            from: () => ({
              where: () => ({
                limit: async () => [
                  costSourceRow({
                    metric: null,
                    unit: null,
                    price_per_unit: null,
                    tracking_status: 'pending',
                    default_metric_value: null,
                  }),
                ],
              }),
            }),
          }),
        }),
    );

    const res = await PATCH(
      makeDashboardRequest({
        method: 'PATCH',
        query: { slug: 'search-api' },
        body: {
          tracking_status: 'tracked',
          metric: 'search_query',
          unit: 'request',
          matchers: ['Search API'],
        },
      }),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { message: 'pricing is required to track a non-LLM source' },
    });
  });

  it('activates pending non-LLM sources atomically with matchers, usage default, and price', async () => {
    routeMocks.withRLS.mockImplementationOnce(
      async (_builderId: string, cb: (tx: unknown) => Promise<unknown>) =>
        cb({
          ...makeTx(),
          select: () => ({
            from: () => ({
              where: () => ({
                limit: async () => [
                  costSourceRow({
                    metric: null,
                    unit: null,
                    price_per_unit: null,
                    tracking_status: 'pending',
                    default_metric_value: null,
                  }),
                ],
              }),
            }),
          }),
        }),
    );

    const res = await PATCH(
      makeDashboardRequest({
        method: 'PATCH',
        query: { slug: 'search-api' },
        body: {
          tracking_status: 'tracked',
          metric: 'search_query',
          unit: 'request',
          matchers: ['Search API'],
          default_metric_value: 1,
          price_per_unit: 0.01,
        },
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.cost_source).toMatchObject({
      tracking_status: 'tracked',
      metric: 'search_query',
      unit: 'request',
      matchers: ['search-api'],
      default_metric_value: 1,
      price_per_unit: 0.01,
    });
  });
});
