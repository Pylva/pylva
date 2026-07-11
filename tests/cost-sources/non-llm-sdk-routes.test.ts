import { beforeEach, describe, expect, it, vi } from 'vitest';

const routeMocks = vi.hoisted(() => ({
  ctx: {
    builderId: '00000000-0000-4000-8000-000000000001',
    keyId: 'key-1',
  },
  execute: vi.fn(),
  withRLS: vi.fn(),
}));

vi.mock('@/lib/auth/builder-context', () => ({
  readBuilderContext: () => ({
    builderId: routeMocks.ctx.builderId,
    keyId: routeMocks.ctx.keyId,
  }),
}));

vi.mock('@/lib/db/rls', () => ({
  withRLS: routeMocks.withRLS,
}));

const policyRoute = await import('../../src/app/api/v1/sdk/non-llm-policy/route.js');
const discoveryRoute = await import('../../src/app/api/v1/sdk/non-llm-discoveries/route.js');

function request(url: string, body?: Record<string, unknown>) {
  return new Request(url, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }) as unknown as import('next/server.js').NextRequest;
}

function selectTx(rows: unknown[]) {
  return {
    select: () => ({
      from: () => ({
        where: async () => rows,
      }),
    }),
  };
}

function queryText(callIndex: number): string {
  return JSON.stringify(routeMocks.execute.mock.calls[callIndex]?.[0], (_key, value) =>
    typeof value === 'function' ? undefined : value,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/v1/sdk/non-llm-policy', () => {
  it('returns only policy fields needed by the SDK for tracked and ignored sources', async () => {
    routeMocks.withRLS.mockImplementationOnce(
      async (_builderId: string, cb: (tx: unknown) => Promise<unknown>) =>
        cb(
          selectTx([
            {
              slug: 'tavily',
              display_name: 'Tavily',
              tracking_status: 'tracked',
              matchers: ['tavily_search'],
              metric: 'tavily_requests',
              unit: 'request',
              default_metric_value: 1,
              approved_at: new Date('2026-07-08T00:00:00.000Z'),
              created_at: new Date('2026-07-08T00:00:00.000Z'),
            },
            {
              slug: 'grep',
              display_name: 'Grep',
              tracking_status: 'ignored',
              matchers: ['grep'],
              metric: null,
              unit: null,
              default_metric_value: null,
              approved_at: null,
              created_at: new Date('2026-07-08T00:00:00.000Z'),
            },
          ]),
        ),
    );

    const res = await policyRoute.GET(request('http://localhost/api/v1/sdk/non-llm-policy'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      unknown_behavior: 'discover_only',
      sources: [
        {
          slug: 'tavily',
          status: 'tracked',
          matchers: ['tavily_search'],
          metric: 'tavily_requests',
          unit: 'request',
          default_metric_value: 1,
        },
        {
          slug: 'grep',
          status: 'ignored',
          matchers: ['grep'],
          metric: null,
          unit: null,
          default_metric_value: null,
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain('price_per_unit');
  });
});

describe('POST /api/v1/sdk/non-llm-discoveries', () => {
  it('upserts pending discoveries by normalized matcher without accepting raw payload fields', async () => {
    routeMocks.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    routeMocks.withRLS.mockImplementationOnce(
      async (_builderId: string, cb: (tx: unknown) => Promise<unknown>) =>
        cb({ execute: routeMocks.execute }),
    );

    const res = await discoveryRoute.POST(
      request('http://localhost/api/v1/sdk/non-llm-discoveries', {
        batch_id: 'batch-1',
        discoveries: [
          {
            tool_name: 'Local Lookup',
            matcher: 'Local Lookup !!',
            step_name: 'tools',
            framework: 'langgraph',
            status: 'success',
            raw_input: 'SECRET INPUT MUST NOT BE STORED',
          },
        ],
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ accepted: 1, rejected: 0 });
    expect(routeMocks.execute).toHaveBeenCalledTimes(2);
    expect(queryText(1)).toContain('INSERT INTO cost_sources');
    expect(queryText(1)).toContain('pending');
    expect(queryText(1)).toContain('local-lookup');
    expect(queryText(1)).not.toContain('SECRET INPUT');
  });

  it('updates an existing ignored source instead of creating a new pending row', async () => {
    routeMocks.execute
      .mockResolvedValueOnce([
        {
          id: '11111111-1111-4111-8111-111111111111',
          tracking_status: 'ignored',
        },
      ])
      .mockResolvedValueOnce([]);
    routeMocks.withRLS.mockImplementationOnce(
      async (_builderId: string, cb: (tx: unknown) => Promise<unknown>) =>
        cb({ execute: routeMocks.execute }),
    );

    const res = await discoveryRoute.POST(
      request('http://localhost/api/v1/sdk/non-llm-discoveries', {
        discoveries: [{ tool_name: 'Grep', matcher: 'grep', count: 3 }],
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ accepted: 1, rejected: 0 });
    expect(routeMocks.execute).toHaveBeenCalledTimes(2);
    expect(queryText(1)).toContain('UPDATE cost_sources');
    expect(queryText(1)).not.toContain('INSERT INTO cost_sources');
  });
});
