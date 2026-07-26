import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertWithRlsCallbacksUseTransactionOnly } from '../_helpers/rls-discipline.js';

const testEnv = vi.hoisted(() => ({
  ENABLE_EVENT_LIMITS: false,
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  PYLVA_DEPLOYMENT_MODE: 'self_hosted',
  SELF_HOSTED_MONTHLY_EVENTS_LIMIT: 10_000_000,
  SELF_HOSTED_MAX_CUSTOMERS: 500,
  SELF_HOSTED_TELEMETRY_RETENTION_DAYS: 365,
  SELF_HOSTED_BILLING_RETENTION_DAYS: 365,
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

function whoamiRequest(headers?: HeadersInit) {
  return new Request('http://localhost/api/v1/whoami', {
    headers,
  }) as unknown as import('next/server.js').NextRequest;
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
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  testEnv.ENABLE_EVENT_LIMITS = false;
  testEnv.PYLVA_DEPLOYMENT_MODE = 'self_hosted';
  routeMocks.builderRows = [
    {
      slug: 'acme',
      name: 'Acme Inc',
      display_name: 'Acme',
      tier: 'pro',
      access_state: 'active',
      entitlement_source: 'stripe',
    },
  ];
  routeMocks.withRLS.mockImplementation(
    async (_builderId: string, cb: (tx: unknown) => Promise<unknown>) =>
      cb(selectTx(routeMocks.builderRows)),
  );
  routeMocks.getEventCapUsage.mockResolvedValue(null);
});

describe('GET /api/v1/whoami', () => {
  it('returns plan, access state, deprecated tier alias, limits, and setup URLs when active', async () => {
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
    expect(response.headers.get('x-pylva-contract-version')).toBe('2');
    expect(body).toEqual({
      org: { slug: 'acme', name: 'Acme' },
      plan: 'pro',
      access_state: 'active',
      tier: 'pro',
      key: { id: 'key-1', scope: 'universal' },
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
    expect(routeMocks.withRLS).toHaveBeenCalledWith(routeMocks.ctx.builderId, expect.any(Function));
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('deprecated_tier_alias_consumer'),
    );
  });

  it.each(['2', '3'])(
    'observes canonical contract declaration %s without counting legacy alias usage',
    async (contractVersion) => {
      const response = await GET(
        whoamiRequest({ 'X-Pylva-Contract-Version': contractVersion }),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        plan: 'pro',
        access_state: 'active',
      });
      expect(body).not.toHaveProperty('tier');
      expect(console.warn).not.toHaveBeenCalled();
    },
  );

  it('keeps an older numeric declaration on the measured compatibility path', async () => {
    const response = await GET(whoamiRequest({ 'X-Pylva-Contract-Version': '1' }));
    const body = await response.json();

    expect(body.tier).toBe('pro');
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('contract_version=1'),
    );
  });

  it('bounds malformed legacy contract declarations before logging them', async () => {
    const response = await GET(
      whoamiRequest({ 'X-Pylva-Contract-Version': 'customer@example.com' }),
    );
    const body = await response.json();

    expect(body.tier).toBe('pro');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('contract_version=other'));
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('customer@example.com'));
  });

  it('reports an active no-plan self-hosted workspace without a deprecated tier alias', async () => {
    routeMocks.builderRows = [
      {
        slug: 'acme',
        name: 'Acme Inc',
        display_name: null,
        tier: null,
        access_state: 'active',
        entitlement_source: 'self_hosted',
      },
    ];

    const response = await GET(whoamiRequest());
    const body = await response.json();

    expect(body.plan).toBeNull();
    expect(body.access_state).toBe('active');
    expect(body).not.toHaveProperty('tier');
    expect(body.usage).toBeNull();
    expect(body.limits).toEqual({ monthly_events: 10_000_000, enforced: false });
    expect(body.org.name).toBe('Acme Inc');
  });

  it('never applies self-host policy to a hosted process', async () => {
    testEnv.PYLVA_DEPLOYMENT_MODE = 'hosted';
    routeMocks.builderRows = [
      {
        slug: 'corrupt',
        name: 'Corrupt',
        display_name: null,
        tier: null,
        access_state: 'active',
        entitlement_source: 'self_hosted',
      },
    ];

    const response = await GET(whoamiRequest());

    expect(response.status).toBe(500);
    expect(routeMocks.getEventCapUsage).not.toHaveBeenCalled();
  });

  it('maps the unlimited enterprise cap to null instead of Infinity', async () => {
    routeMocks.builderRows = [
      {
        slug: 'bigco',
        name: 'BigCo',
        display_name: 'BigCo',
        tier: 'enterprise',
        access_state: 'active',
        entitlement_source: 'enterprise_contract',
      },
    ];

    const body = await (await GET(whoamiRequest())).json();

    expect(body.tier).toBe('enterprise');
    expect(body.limits.monthly_events).toBeNull();
  });

  it('fails closed when the persisted plan is unknown', async () => {
    routeMocks.builderRows = [
      {
        slug: 'acme',
        name: 'Acme Inc',
        display_name: 'Acme',
        tier: 'mystery',
        access_state: 'active',
        entitlement_source: 'stripe',
      },
    ];

    const response = await GET(whoamiRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(routeMocks.getEventCapUsage).not.toHaveBeenCalled();
  });

  it('maps only the exact legacy Free tuple to checkout-required with no paid alias', async () => {
    routeMocks.builderRows = [
      {
        slug: 'legacy',
        name: 'Legacy',
        display_name: null,
        tier: 'free',
        access_state: null,
        entitlement_source: null,
      },
    ];

    const response = await GET(whoamiRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      plan: null,
      access_state: 'checkout_required',
      limits: { monthly_events: null, enforced: false },
      usage: null,
    });
    expect(body).not.toHaveProperty('tier');
    expect(routeMocks.getEventCapUsage).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('returns suspended lifecycle state without a paid plan or deprecated alias', async () => {
    routeMocks.builderRows = [
      {
        slug: 'acme',
        name: 'Acme Inc',
        display_name: 'Acme',
        tier: null,
        access_state: 'suspended',
        entitlement_source: 'stripe',
      },
    ];

    const response = await GET(whoamiRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      plan: null,
      access_state: 'suspended',
      limits: { monthly_events: null, enforced: false },
      usage: null,
    });
    expect(body).not.toHaveProperty('tier');
    expect(routeMocks.getEventCapUsage).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('fails closed for a paid plan paired with suspended access', async () => {
    routeMocks.builderRows = [
      {
        slug: 'acme',
        name: 'Acme Inc',
        display_name: 'Acme',
        tier: 'pro',
        access_state: 'suspended',
        entitlement_source: 'stripe',
      },
    ];

    const response = await GET(whoamiRequest());

    expect(response.status).toBe(500);
    expect(routeMocks.getEventCapUsage).not.toHaveBeenCalled();
  });

  it('falls back through display_name and name to the slug', async () => {
    routeMocks.builderRows = [
      {
        slug: 'acme',
        name: null,
        display_name: null,
        tier: null,
        access_state: 'checkout_required',
        entitlement_source: null,
      },
    ];

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
