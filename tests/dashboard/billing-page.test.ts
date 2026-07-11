// Happy-path rendering for /o/[slug]/dashboard/billing — invoice rows,
// detail links, the "excl. usage" badge, split-cycle links, and offset
// pagination. Filter validation lives in billing-page-filter-validation.test.ts
// (whose withRLS/drizzle chain mock this file reuses).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { ReactNode } from 'react';
import { formatUsd } from '../../src/lib/formatting.js';
import { TableCell, TableContainer } from '../../src/components/ui/table.js';
import { anchorHrefs, byType, findAll, textContent } from '../_helpers/rsc-tree.js';
import { invoiceRow } from '../_helpers/table-fixtures.js';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  withRLS: vi.fn(),
  listRows: [] as Array<Record<string, unknown>>,
  countRows: [{ c: 0 }],
  PageHeader: () => null,
  DraftBanner: () => null,
  UnpricedBanner: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ op: 'and', conditions }),
  count: () => ({ op: 'count' }),
  desc: (column: unknown) => ({ op: 'desc', column }),
  eq: (column: string, value: unknown) => ({ op: 'eq', column, value }),
}));

vi.mock('@/lib/dashboard/headers', () => ({
  readDashboardHeaders: async () => ({
    builderId: '00000000-0000-0000-0000-000000000001',
    role: 'owner',
    userId: 'user-1',
  }),
}));

vi.mock('@/lib/db/schema', () => ({
  invoices: {
    id: 'id',
    builder_id: 'builder_id',
    customer_id: 'customer_id',
    billing_cycle_id: 'billing_cycle_id',
    status: 'status',
    has_unpriced_events: 'has_unpriced_events',
    created_at: 'created_at',
    period_start: 'period_start',
  },
}));

vi.mock('@/lib/db/rls', () => ({
  withRLS: mocks.withRLS,
}));

vi.mock('@/components/dashboard/DraftBanner', () => ({
  DraftBanner: mocks.DraftBanner,
}));

vi.mock('@/components/billing/UnpricedBanner', () => ({
  UnpricedBanner: mocks.UnpricedBanner,
}));

vi.mock('@/components/dashboard/PageHeader', () => ({
  PageHeader: mocks.PageHeader,
}));

const { default: BillingListPage } =
  await import('../../src/app/o/[slug]/dashboard/billing/page.js');

function makeTx() {
  return {
    select: (shape?: Record<string, unknown>) => {
      const isCountQuery = Boolean(shape && 'c' in shape);
      const chain = {
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => chain,
        offset: () => Promise.resolve(mocks.listRows),
        then: (
          onFulfilled?: (value: unknown[]) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) =>
          Promise.resolve(isCountQuery ? mocks.countRows : mocks.listRows).then(
            onFulfilled,
            onRejected,
          ),
      };
      return chain;
    },
  };
}

function pageProps(searchParams: Record<string, string | undefined> = {}) {
  return {
    params: Promise.resolve({ slug: 'pylva-test' }),
    searchParams: Promise.resolve(searchParams),
  };
}

describe('/o/[slug]/dashboard/billing happy path', () => {
  beforeEach(() => {
    mocks.listRows = [];
    mocks.countRows = [{ c: 0 }];
    mocks.withRLS.mockReset();
    mocks.withRLS.mockImplementation(async (_builderId: string, cb: (tx: unknown) => unknown) =>
      cb(makeTx()),
    );
  });

  it('renders padded invoice rows with detail links and formatted amounts', async () => {
    const paid = invoiceRow();
    const split = invoiceRow({
      id: 'e2e00000-0000-4000-8000-000000000002',
      billing_cycle_id: 'cycle000-0000-4000-8000-000000000001',
      status: 'draft',
    });
    mocks.listRows = [paid, split] as unknown as Array<Record<string, unknown>>;

    const element = await BillingListPage(pageProps());
    const text = textContent(element);
    const hrefs = anchorHrefs(element);

    expect(text).toContain(new Date(paid.created_at).toLocaleDateString());
    expect(text).toContain(formatUsd('42.50'));
    expect(text).toContain('paid');
    expect(hrefs).toContain(`/o/pylva-test/dashboard/billing/invoices/${paid.id}`);
    // split-cycle link for the row with a billing_cycle_id, em dash for the other
    expect(hrefs).toContain(`/o/pylva-test/dashboard/billing/cycles/${split.billing_cycle_id}`);
    expect(text).toContain('—');

    expect(findAll(element, byType(TableContainer))).toHaveLength(1);
    expect(findAll(element, byType(TableCell))).toHaveLength(2 * 5);
  });

  it('shows the "excl. usage" badge only for invoices with unpriced events', async () => {
    mocks.listRows = [invoiceRow({ has_unpriced_events: true })] as unknown as Array<
      Record<string, unknown>
    >;
    let element = await BillingListPage(pageProps());
    expect(textContent(element)).toContain('excl. usage');

    mocks.listRows = [invoiceRow({ has_unpriced_events: false })] as unknown as Array<
      Record<string, unknown>
    >;
    element = await BillingListPage(pageProps());
    expect(textContent(element)).not.toContain('excl. usage');
  });

  it('renders the next-page link only when the page is full, preserving filters', async () => {
    mocks.listRows = Array.from({ length: 50 }, (_, i) =>
      invoiceRow({ id: `e2e00000-0000-4000-8000-${String(i).padStart(12, '0')}` }),
    ) as unknown as Array<Record<string, unknown>>;

    const element = await BillingListPage(pageProps({ status: 'paid' }));
    expect(anchorHrefs(element)).toContain('?offset=50&status=paid');

    mocks.listRows = [invoiceRow()] as unknown as Array<Record<string, unknown>>;
    const shortPage = await BillingListPage(pageProps({ status: 'paid' }));
    expect(textContent(shortPage)).not.toContain('Next page');
  });
});
