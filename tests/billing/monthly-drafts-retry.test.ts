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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dbExecute.mockResolvedValue([{ builder_id: builderId, customer_id: customerId }]);
});

describe('generateMonthlyDrafts projection retries', () => {
  it('retries a customer on the next daily run after projection was pending at month rollover', async () => {
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
      now: new Date('2026-07-02T04:00:00.000Z'),
    });

    expect(rolloverRun).toMatchObject({ generated: 0, skipped_other: 1 });
    expect(retryRun).toMatchObject({
      scanned_builders: 1,
      generated: 1,
      skipped_other: 0,
      window_start: '2026-06-01T00:00:00.000Z',
      window_end: '2026-07-01T00:00:00.000Z',
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
  });
});
