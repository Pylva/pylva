import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getOverviewMock, getTopEndUsersMock, warnMock } = vi.hoisted(() => ({
  getOverviewMock: vi.fn(),
  getTopEndUsersMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock('@/lib/auth/builder-context', () => ({
  readBuilderContextFromDashboard: () => ({ builderId: 'builder-1', userId: 'user-1', role: 'owner' }),
}));

vi.mock('@/lib/clickhouse/dashboard-queries', () => ({
  getOverview: getOverviewMock,
  getTopEndUsers: getTopEndUsersMock,
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    child: () => ({ warn: warnMock }),
  },
}));

const { GET } = await import('../../src/app/api/v1/costs/route.js');

function makeRequest(url = 'http://localhost/api/v1/costs') {
  return new Request(url, { method: 'GET' }) as unknown as import('next/server.js').NextRequest;
}

describe('GET /api/v1/costs', () => {
  beforeEach(() => {
    getOverviewMock.mockReset();
    getTopEndUsersMock.mockReset();
    warnMock.mockClear();
  });

  it('returns overview and top users for a valid dashboard request', async () => {
    getOverviewMock.mockResolvedValue({
      total_spend_usd: 12.34,
      event_count: 56,
      customer_count: 3,
      range: { from: new Date('2026-06-01T00:00:00Z'), to: new Date('2026-06-02T00:00:00Z') },
      demo_only: false,
    });
    getTopEndUsersMock.mockResolvedValue([
      { customer_id: 'cust_1', total_spend_usd: 9.87, event_count: 10 },
    ]);

    const response = await GET(
      makeRequest(
        'http://localhost/api/v1/costs?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z',
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      overview: { total_spend_usd: 12.34, event_count: 56, customer_count: 3 },
      top_end_users: [{ customer_id: 'cust_1', total_spend_usd: 9.87, event_count: 10 }],
      demo_only: false,
    });
    expect(getOverviewMock).toHaveBeenCalledWith(
      'builder-1',
      { from: new Date('2026-06-01T00:00:00Z'), to: new Date('2026-06-02T00:00:00Z') },
      { includeDemo: false },
    );
    expect(getTopEndUsersMock).toHaveBeenCalledWith(
      'builder-1',
      { from: new Date('2026-06-01T00:00:00Z'), to: new Date('2026-06-02T00:00:00Z') },
      5,
      { includeDemo: false },
    );
  });

  it('keeps invalid date validation as a 400', async () => {
    const response = await GET(makeRequest('http://localhost/api/v1/costs?from=not-a-date'));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_ERROR', param: 'from' },
    });
    expect(getOverviewMock).not.toHaveBeenCalled();
    expect(getTopEndUsersMock).not.toHaveBeenCalled();
  });

  it('returns structured 503 when ClickHouse dashboard reads fail', async () => {
    getOverviewMock.mockRejectedValue(new Error('Timeout error.'));
    getTopEndUsersMock.mockResolvedValue([]);

    const response = await GET(makeRequest());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        type: 'api_error',
        code: 'INTERNAL_ERROR',
        message: 'Usage data is temporarily unavailable',
      },
    });
    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        builder_id: 'builder-1',
        error: 'Timeout error.',
      }),
      'cost summary unavailable',
    );
  });
});
