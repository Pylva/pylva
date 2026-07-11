import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertWithRlsCallbacksUseTransactionOnly } from '../_helpers/rls-discipline.js';

const testEnv = vi.hoisted(() => ({
  ENABLE_EVENT_LIMITS: false,
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
}));

const routeMocks = vi.hoisted(() => ({
  ctx: {
    builderId: '00000000-0000-4000-8000-000000000001',
    keyId: 'key-1',
  },
  builderRows: [] as unknown[],
  withRLS: vi.fn(),
  getEventCapUsage: vi.fn(),
}));

vi.mock('@/lib/config', () => ({ env: testEnv }));
vi.mock('../../src/lib/config.js', () => ({ env: testEnv }));

vi.mock('@/lib/auth/builder-context', () => ({
  readBuilderContext: () => ({ ...routeMocks.ctx }),
}));

vi.mock('@/lib/db/rls', () => ({ withRLS: routeMocks.withRLS }));

vi.mock('@/lib/ingest/event-cap', () => ({
  getEventCapUsage: routeMocks.getEventCapUsage,
}));

const { GET } = await import('../../src/app/api/v1/whoami/route.js');

function whoamiRequest() {
  return new Request('http://localhost/api/v1/whoami') as unknown as
    import('next/server.js').NextRequest;
}

function selectTx(rows: unknown[]) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => rows,
        }),
      }),
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  testEnv.ENABLE_EVENT_LIMITS = false;
  routeMocks.builderRows = [
    { slug: 'acme', name: 'Acme Inc', display_name: 'Acme', tier: 'pro' },
  ];
  routeMocks.withRLS.mockImplementation(
    async (_builderId: string, cb: (tx: unknown) => Promise<unknown>) =>
      cb(selectTx(routeMocks.builderRows)),
  );
  routeMocks.getEventCapUsage.mockResolvedValue(null);
});

describe('GET /api/v1/whoami', () => {
  it('returns org, tier, key, limits, usage, and setup URLs when limits are enforced', async () => {
    testEnv.ENABLE_EVENT_LIMITS = true;
    routeMocks.getEventCapUsage.mockResolvedValue({
      monthly_events_used: 1234,
      monthly_events_limit: 1_000_000,
      window_start: new Date('2026-07-01T00:00:00.000Z'),
      window_end: new Date('2026-08-01T00:00:00.000Z'),
      window_source: 'calendar_month',
    });

    const response = await GET(whoamiRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body).toEqual({
      org: { slug: 'acme', name: 'Acme' },
      tier: 'pro',
      key: { id: 'key-1', scope: 'agent_sdk' },
      limits: { monthly_events: 1_000_000, enforced: true },
      usage: {
        monthly_events_used: 1234,
        monthly_events_limit: 1_000_000,
        window_start: '2026-07-01T00:00:00.000Z',
        window_end: '2026-08-01T00:00:00.000Z',
        window_source: 'calendar_month',
      },
      docs_url: 'https://docs.pylva.com',
      agent_setup_url: 'https://docs.pylva.com/setup-with-ai.md',
    });
    expect(routeMocks.withRLS).toHaveBeenCalledWith(
      routeMocks.ctx.builderId,
      expect.any(Function),
    );
  });

  it('reports usage null with enforced false on the self-host default', async () => {
    routeMocks.builderRows = [{ slug: 'acme', name: 'Acme Inc', display_name: null, tier: 'free' }];

    const response = await GET(whoamiRequest());
    const body = await response.json();

    expect(body.usage).toBeNull();
    expect(body.limits).toEqual({ monthly_events: 100_000, enforced: false });
    expect(body.org.name).toBe('Acme Inc');
  });

  it('maps the unlimited enterprise cap to null instead of Infinity', async () => {
    routeMocks.builderRows = [
      { slug: 'bigco', name: 'BigCo', display_name: 'BigCo', tier: 'enterprise' },
    ];

    const body = await (await GET(whoamiRequest())).json();

    expect(body.tier).toBe('enterprise');
    expect(body.limits.monthly_events).toBeNull();
  });

  it('falls back to free-tier limits when the persisted tier is unknown', async () => {
    routeMocks.builderRows = [
      { slug: 'acme', name: 'Acme Inc', display_name: 'Acme', tier: 'mystery' },
    ];

    const body = await (await GET(whoamiRequest())).json();

    expect(body.tier).toBe('free');
    expect(body.limits.monthly_events).toBe(100_000);
  });

  it('falls back through display_name and name to the slug', async () => {
    routeMocks.builderRows = [{ slug: 'acme', name: null, display_name: null, tier: 'free' }];

    const body = await (await GET(whoamiRequest())).json();

    expect(body.org.name).toBe('acme');
  });

  it('returns the 404 envelope when the builder row is missing', async () => {
    routeMocks.builderRows = [];

    const response = await GET(whoamiRequest());
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('never includes key material beyond the key id', async () => {
    const response = await GET(whoamiRequest());
    const serialized = JSON.stringify(await response.json());

    expect(serialized).toContain('"id":"key-1"');
    expect(serialized).not.toContain('pv_live');
    expect(serialized).not.toContain('pv_cli');
  });
});

describe('RLS discipline', () => {
  it('keeps whoami queries inside withRLS callbacks on tx, not global db', () => {
    assertWithRlsCallbacksUseTransactionOnly(
      fileURLToPath(new URL('../../src/app/api/v1/whoami/route.ts', import.meta.url)),
    );
  });
});
