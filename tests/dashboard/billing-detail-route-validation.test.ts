import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const mocks = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  readDashboardHeaders: vi.fn(),
  withRLS: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  notFound: mocks.notFound,
}));

vi.mock('@/lib/dashboard/headers', () => ({
  readDashboardHeaders: mocks.readDashboardHeaders,
}));

vi.mock('@/lib/db/rls', () => ({
  withRLS: mocks.withRLS,
}));

vi.mock('@/components/billing/UnpricedBanner', () => ({
  UnpricedBanner: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('@/lib/formatting', () => ({
  formatUsd: (value: unknown) => `$${value}`,
}));

const { default: InvoiceDetailPage } =
  await import('../../src/app/o/[slug]/dashboard/billing/invoices/[id]/page.js');
const { default: BillingCyclePage } =
  await import('../../src/app/o/[slug]/dashboard/billing/cycles/[billing_cycle_id]/page.js');

describe('billing detail route UUID validation', () => {
  beforeEach(() => {
    mocks.notFound.mockClear();
    mocks.readDashboardHeaders.mockReset();
    mocks.withRLS.mockReset();
  });

  it('404s malformed invoice ids before reading dashboard headers or the database', async () => {
    await expect(
      InvoiceDetailPage({
        params: Promise.resolve({ slug: 'pylva-test', id: 'xfngg' }),
      }),
    ).rejects.toThrow('NEXT_NOT_FOUND');

    expect(mocks.notFound).toHaveBeenCalledTimes(1);
    expect(mocks.readDashboardHeaders).not.toHaveBeenCalled();
    expect(mocks.withRLS).not.toHaveBeenCalled();
  });

  it('404s malformed billing cycle ids before reading dashboard headers or the database', async () => {
    await expect(
      BillingCyclePage({
        params: Promise.resolve({ slug: 'pylva-test', billing_cycle_id: 'xfngg' }),
      }),
    ).rejects.toThrow('NEXT_NOT_FOUND');

    expect(mocks.notFound).toHaveBeenCalledTimes(1);
    expect(mocks.readDashboardHeaders).not.toHaveBeenCalled();
    expect(mocks.withRLS).not.toHaveBeenCalled();
  });
});
