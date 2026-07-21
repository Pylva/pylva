import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dbExecute: vi.fn(),
  generateInvoice: vi.fn(),
}));

vi.mock('@/lib/db/client', () => ({
  db: { execute: mocks.dbExecute },
}));

vi.mock('@/lib/billing/invoice-generator', () => {
  class BillingError extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message);
    }
  }

  return { BillingError, generateInvoice: mocks.generateInvoice };
});

vi.mock('@/lib/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn() }),
  },
}));

const { generateMonthlyDrafts } = await import('../../src/lib/billing/monthly-drafts.js');
const { BillingError } = await import('../../src/lib/billing/invoice-generator.js');

const builderId = '00000000-0000-4000-8000-000000000001';
const customerId = '00000000-0000-4000-8000-000000000002';
const junePeriod = {
  builder_id: builderId,
  customer_id: customerId,
  period_start: new Date('2026-06-01T00:00:00.000Z'),
  period_end: new Date('2026-07-01T00:00:00.000Z'),
};
let pendingPeriods = [junePeriod];

function queryText(query: unknown): string {
  return JSON.stringify(query, (_key, value) => (typeof value === 'function' ? undefined : value));
}

beforeEach(() => {
  vi.clearAllMocks();
  pendingPeriods = [junePeriod];
  mocks.dbExecute.mockImplementation((query: unknown) => {
    const text = queryText(query);
    if (text.includes('SELECT builder_id') && text.includes('FROM monthly_invoice_periods')) {
      return Promise.resolve(pendingPeriods);
    }
    if (text.includes('UPDATE monthly_invoice_periods') && text.includes('completed')) {
      pendingPeriods = [];
    }
    return Promise.resolve([]);
  });
});

describe('generateMonthlyDrafts projection retries', () => {
  it('queues a closed monthly period after the customer switches billing periods', async () => {
    mocks.generateInvoice.mockResolvedValueOnce([
      {
        invoice_id: '00000000-0000-4000-8000-000000000003',
        stripe_invoice_id: 'in_123',
        amount_usd: 25,
        has_unpriced_events: false,
      },
    ]);

    await generateMonthlyDrafts({ now: new Date('2026-07-01T04:00:00.000Z') });

    const queries = mocks.dbExecute.mock.calls.map(([query]) => queryText(query));
    const enqueueQuery = queries.find((query) =>
      query.includes('INSERT INTO monthly_invoice_periods'),
    );

    expect(enqueueQuery).toContain('DISTINCT period_pricing.builder_id');
    expect(enqueueQuery).toContain("period_pricing.billing_period = 'monthly'");
    expect(enqueueQuery).toContain('period_pricing.effective_from <');
    expect(enqueueQuery).toContain('period_pricing.effective_to >');
    expect(enqueueQuery).not.toContain('active_pricing.effective_to IS NULL');
  });

  it('keeps retrying a queued period after the next month boundary', async () => {
    mocks.generateInvoice
      .mockRejectedValueOnce(
        new BillingError('projection_pending', 'Authoritative usage is still reconciling'),
      )
      .mockResolvedValueOnce([
        {
          invoice_id: '00000000-0000-4000-8000-000000000003',
          stripe_invoice_id: 'in_123',
          amount_usd: 25,
          has_unpriced_events: false,
        },
      ]);

    const rolloverRun = await generateMonthlyDrafts({
      now: new Date('2026-07-01T04:00:00.000Z'),
    });
    const retryRun = await generateMonthlyDrafts({
      now: new Date('2026-08-15T04:00:00.000Z'),
    });
    await generateMonthlyDrafts({ now: new Date('2026-08-15T05:00:00.000Z') });

    expect(rolloverRun).toMatchObject({ generated: 0, skipped_other: 1 });
    expect(retryRun).toMatchObject({
      scanned_builders: 1,
      generated: 1,
      skipped_other: 0,
      window_start: '2026-07-01T00:00:00.000Z',
      window_end: '2026-08-01T00:00:00.000Z',
    });
    expect(mocks.generateInvoice).toHaveBeenCalledTimes(2);
    expect(mocks.generateInvoice).toHaveBeenLastCalledWith({
      builderId,
      customerId,
      period: {
        start: new Date('2026-06-01T00:00:00.000Z'),
        end: new Date('2026-07-01T00:00:00.000Z'),
      },
      draftKeyBase: `monthly:2026-06-01:${customerId}`,
    });

    const queries = mocks.dbExecute.mock.calls.map(([query]) => queryText(query));
    expect(
      queries.filter((query) => query.includes('INSERT INTO monthly_invoice_periods')),
    ).toHaveLength(3);
    expect(queries.some((query) => query.includes('period_pricing.effective_from'))).toBe(true);
    expect(queries.some((query) => query.includes('ON CONFLICT'))).toBe(true);
    expect(queries.some((query) => query.includes('UPDATE monthly_invoice_periods'))).toBe(true);
    expect(queries.some((query) => query.includes("'completed'"))).toBe(true);
  });
});
