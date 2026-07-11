import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryCostEvents: vi.fn(),
  resolveCustomerComposite: vi.fn(),
}));

vi.mock('../../src/lib/db/client.js', () => ({
  db: {},
}));

vi.mock('../../src/lib/clickhouse/client.js', () => ({
  queryCostEvents: mocks.queryCostEvents,
}));

vi.mock('../../src/lib/clickhouse/customer-id.js', () => ({
  resolveCustomerComposite: mocks.resolveCustomerComposite,
}));

const { getPortalOverview } = await import('../../src/lib/portal/data.js');

describe('portal data loaders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveCustomerComposite.mockResolvedValue('builder-1:customer-1');
    mocks.queryCostEvents.mockResolvedValue([{ total_cost_usd: '12.34', event_count: '3' }]);
  });

  it('formats ClickHouse DateTime params without milliseconds', async () => {
    const result = await getPortalOverview('builder-1', 'customer-uuid', {
      from: new Date('2026-06-01T00:00:00.000Z'),
      to: new Date('2026-06-24T04:56:08.702Z'),
      source: 'billing_period',
    });

    expect(result).toEqual({ total_cost_usd: 12.34, event_count: 3 });
    expect(mocks.queryCostEvents).toHaveBeenCalledWith(
      'builder-1',
      expect.any(String),
      expect.objectContaining({
        customer_id: 'builder-1:customer-1',
        from: '2026-06-01 00:00:00',
        to: '2026-06-24 04:56:08',
      }),
    );
  });
});
