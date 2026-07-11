// Regression tests: dashboard query functions must convert customer_id to/from
// composite form ({builderId}:{externalId}) that ClickHouse stores at ingest time.
//
// Without these conversions:
//   - Filter queries (getRecentTraces) silently return [] because the WHERE clause
//     uses the external id but ClickHouse stores the composite form.
//   - List functions (getTopEndUsers, getCustomerCostSummary) leak internal builder
//     UUIDs in API responses (e.g. "builderA:alice" instead of "alice").

import { NextRequest } from 'next/server.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const BUILDER_ID = 'builderA';
const EXTERNAL_ID = 'alice';
const COMPOSITE_ID = `${BUILDER_ID}:${EXTERNAL_ID}`;
const RANGE = {
  from: new Date('2026-06-01T00:00:00Z'),
  to: new Date('2026-06-07T00:00:00Z'),
};

const queryCostEventsMock = vi.fn();
const routeMocks = vi.hoisted(() => ({
  readBuilderContextFromDashboard: vi.fn(),
  getBuilderTierGate: vi.fn(),
  checkCustomerLimitInTransaction: vi.fn(),
  lockCustomerLimit: vi.fn(),
  tierUsageHeader: vi.fn(),
  withRLS: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../src/lib/clickhouse/client.js', () => ({
  queryCostEvents: queryCostEventsMock,
}));

vi.mock('@/lib/auth/builder-context', () => ({
  readBuilderContextFromDashboard: routeMocks.readBuilderContextFromDashboard,
}));

vi.mock('@/lib/auth/dashboard-feature-gate', () => ({
  getBuilderTierGate: routeMocks.getBuilderTierGate,
}));

vi.mock('@/lib/auth/tier-enforcement', () => ({
  checkCustomerLimitInTransaction: routeMocks.checkCustomerLimitInTransaction,
  lockCustomerLimit: routeMocks.lockCustomerLimit,
  tierUsageHeader: routeMocks.tierUsageHeader,
}));

vi.mock('@/lib/db/rls', () => ({
  withRLS: routeMocks.withRLS,
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    child: () => ({ warn: routeMocks.warn }),
  },
}));

function setBuilderContext(): void {
  routeMocks.readBuilderContextFromDashboard.mockReturnValue({
    builderId: BUILDER_ID,
    userId: 'user-1',
    role: 'owner',
  });
}

describe('getRecentTraces — composite customer_id handling', () => {
  let getRecentTraces: Awaited<
    typeof import('../../src/lib/clickhouse/dashboard-queries.js')
  >['getRecentTraces'];

  beforeEach(async () => {
    vi.clearAllMocks();
    const fakeRow = {
      trace_id: '00000000-0000-4000-8000-000000000001',
      started_at: '2026-06-06 10:00:00',
      customer_id: COMPOSITE_ID,
      span_count: '3',
      total_spend_usd: '0.015',
      total_latency_ms: '420',
    };
    queryCostEventsMock.mockResolvedValue([fakeRow]);
    ({ getRecentTraces } = await import('../../src/lib/clickhouse/dashboard-queries.js'));
  });

  it('converts external customer_id to composite before ClickHouse filter', async () => {
    await getRecentTraces(BUILDER_ID, RANGE, {
      includeDemo: false,
      customerId: EXTERNAL_ID,
    });
    const params = queryCostEventsMock.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(params['customer_id']).toBe(COMPOSITE_ID);
    expect(params['customer_id']).not.toBe(EXTERNAL_ID);
  });

  it('strips composite prefix from returned customer_id', async () => {
    const traces = await getRecentTraces(BUILDER_ID, RANGE, {
      includeDemo: false,
    });
    expect(traces[0]?.customer_id).toBe(EXTERNAL_ID);
  });

  it('omits customer_id param when no filter is requested', async () => {
    await getRecentTraces(BUILDER_ID, RANGE, { includeDemo: false });
    const params = queryCostEventsMock.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(params).not.toHaveProperty('customer_id');
  });
});

describe('getTopEndUsers — strips composite prefix in response', () => {
  let getTopEndUsers: Awaited<
    typeof import('../../src/lib/clickhouse/dashboard-queries.js')
  >['getTopEndUsers'];

  beforeEach(async () => {
    vi.clearAllMocks();
    queryCostEventsMock.mockResolvedValue([
      { customer_id: COMPOSITE_ID, total_spend_usd: '5.00', event_count: '10' },
    ]);
    ({ getTopEndUsers } = await import('../../src/lib/clickhouse/dashboard-queries.js'));
  });

  it('returns external customer_id, not composite', async () => {
    const rows = await getTopEndUsers(BUILDER_ID, RANGE);
    expect(rows[0]?.customer_id).toBe(EXTERNAL_ID);
    expect(rows[0]?.customer_id).not.toContain(':');
  });
});

describe('getCustomerCostSummary — strips composite prefix in response', () => {
  let getCustomerCostSummary: Awaited<
    typeof import('../../src/lib/clickhouse/dashboard-queries.js')
  >['getCustomerCostSummary'];

  beforeEach(async () => {
    vi.clearAllMocks();
    queryCostEventsMock.mockResolvedValue([
      {
        customer_id: COMPOSITE_ID,
        total_spend_usd: '12.50',
        event_count: '42',
        last_seen_at: '2026-06-06 10:00:00',
      },
    ]);
    ({ getCustomerCostSummary } = await import('../../src/lib/clickhouse/dashboard-queries.js'));
  });

  it('returns external customer_id, not composite', async () => {
    const rows = await getCustomerCostSummary(BUILDER_ID, RANGE);
    expect(rows[0]?.customer_id).toBe(EXTERNAL_ID);
    expect(rows[0]?.customer_id).not.toContain(':');
  });
});

describe('GET /api/v1/export/csv — composite customer_id handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setBuilderContext();
    queryCostEventsMock.mockResolvedValue([
      {
        timestamp: '2026-06-06 10:00:00',
        trace_id: 'trace-1',
        span_id: '00000000-0000-4000-8000-000000000001',
        parent_span_id: null,
        customer_id: COMPOSITE_ID,
        provider: 'openai',
        model: 'gpt-4o-mini',
        operation: 'chat',
        step_name: 'agent.step',
        tokens_in: '10',
        tokens_out: '20',
        cost_usd: '0.003',
        latency_ms: '123',
        status: 'ok',
        is_demo: '0',
      },
    ]);
  });

  it('converts external customer_id to composite before ClickHouse filter', async () => {
    const { GET } = await import('../../src/app/api/v1/export/csv/route.js');

    const response = await GET(
      new NextRequest(
        `http://localhost/api/v1/export/csv?customer_id=${EXTERNAL_ID}&from=2026-06-01&to=2026-06-07`,
      ),
    );
    await response.text();

    const params = queryCostEventsMock.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(params['customer_id']).toBe(COMPOSITE_ID);
  });

  it('streams external customer_id in the CSV output', async () => {
    const { GET } = await import('../../src/app/api/v1/export/csv/route.js');

    const response = await GET(
      new NextRequest(
        `http://localhost/api/v1/export/csv?customer_id=${EXTERNAL_ID}&from=2026-06-01&to=2026-06-07`,
      ),
    );

    const csv = await response.text();
    expect(csv).toContain(`\n2026-06-06 10:00:00,trace-1,`);
    expect(csv).toContain(`,${EXTERNAL_ID},openai,`);
    expect(csv).not.toContain(COMPOSITE_ID);
  });
});

describe('GET /api/v1/customers — summary merge key', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setBuilderContext();
    routeMocks.withRLS.mockResolvedValue([
      {
        id: 'customer-row-1',
        external_id: EXTERNAL_ID,
        name: 'Alice',
        email: 'alice@example.com',
        created_at: new Date('2026-06-01T00:00:00Z'),
      },
    ]);
    queryCostEventsMock.mockResolvedValue([
      {
        customer_id: COMPOSITE_ID,
        total_spend_usd: '12.50',
        event_count: '42',
        last_seen_at: '2026-06-06 10:00:00',
      },
    ]);
  });

  it('merges ClickHouse summaries by external customer id', async () => {
    const { GET } = await import('../../src/app/api/v1/customers/route.js');

    const response = await GET(
      new NextRequest('http://localhost/api/v1/customers?from=2026-06-01&to=2026-06-07'),
    );
    const body = (await response.json()) as {
      customers: Array<{ total_spend_usd: number; event_count: number }>;
    };

    expect(body.customers[0]).toMatchObject({
      total_spend_usd: 12.5,
      event_count: 42,
    });
    expect(body).not.toHaveProperty('usage_data_unavailable');
  });

  it('returns Postgres rows with unavailable marker when ClickHouse summary fails', async () => {
    queryCostEventsMock.mockRejectedValue(new Error('The user aborted a request.'));
    const { GET } = await import('../../src/app/api/v1/customers/route.js');

    const response = await GET(
      new NextRequest('http://localhost/api/v1/customers?from=2026-06-01&to=2026-06-07'),
    );
    const body = (await response.json()) as {
      customers: Array<{
        total_spend_usd: number;
        event_count: number;
        last_seen_at: string | null;
      }>;
      usage_data_unavailable?: true;
    };

    expect(response.status).toBe(200);
    expect(body.usage_data_unavailable).toBe(true);
    expect(body.customers[0]).toMatchObject({
      total_spend_usd: 0,
      event_count: 0,
      last_seen_at: null,
    });
    expect(routeMocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        builder_id: BUILDER_ID,
        error: 'The user aborted a request.',
      }),
      'customer summary unavailable',
    );
  });
});
