// Happy-path rendering for /o/[slug]/dashboard/billing/invoices/[id] — the
// line-items table (including Arabic descriptions and zero quantities), the
// empty state, and role/status gating of the Finalize/Void actions.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { ReactNode } from 'react';
import { formatUsd } from '../../src/lib/formatting.js';
import { TableCell, TableContainer } from '../../src/components/ui/table.js';
import { DashboardActionButton } from '../../src/components/dashboard/DashboardActionButton.js';
import { byType, findAll, textContent } from '../_helpers/rsc-tree.js';
import {
  arabicLineItem,
  invoiceRow,
  lineItem,
  zeroQuantityLineItem,
} from '../_helpers/table-fixtures.js';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  withRLS: vi.fn(),
  invoice: null as Record<string, unknown> | null,
  role: 'owner',
  UnpricedBanner: ({ children }: { children: ReactNode }) => children,
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ op: 'and', conditions }),
  eq: (column: string, value: unknown) => ({ op: 'eq', column, value }),
}));

vi.mock('@/lib/dashboard/headers', () => ({
  readDashboardHeaders: async () => ({
    builderId: '00000000-0000-0000-0000-000000000001',
    role: mocks.role,
    userId: 'user-1',
  }),
}));

vi.mock('@/lib/db/schema', () => ({
  invoices: {
    id: 'id',
    builder_id: 'builder_id',
  },
}));

vi.mock('@/lib/db/rls', () => ({
  withRLS: mocks.withRLS,
}));

vi.mock('@/components/billing/UnpricedBanner', () => ({
  UnpricedBanner: mocks.UnpricedBanner,
}));

vi.mock('next/navigation', () => ({
  notFound: mocks.notFound,
}));

const { default: InvoiceDetailPage } =
  await import('../../src/app/o/[slug]/dashboard/billing/invoices/[id]/page.js');

function makeTx() {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => (mocks.invoice ? [mocks.invoice] : []),
  };
  return { select: () => chain };
}

function pageProps(id = 'e2e00000-0000-4000-8000-000000000001') {
  return {
    params: Promise.resolve({ slug: 'pylva-test', id }),
  };
}

describe('/o/[slug]/dashboard/billing/invoices/[id] happy path', () => {
  beforeEach(() => {
    mocks.invoice = null;
    mocks.role = 'owner';
    mocks.notFound.mockClear();
    mocks.withRLS.mockReset();
    mocks.withRLS.mockImplementation(async (_builderId: string, cb: (tx: unknown) => unknown) =>
      cb(makeTx()),
    );
  });

  it('renders padded line-item rows, including Arabic descriptions and zero quantities', async () => {
    const items = [lineItem(), arabicLineItem(), zeroQuantityLineItem()];
    mocks.invoice = invoiceRow({ line_items: items }) as unknown as Record<string, unknown>;

    const element = await InvoiceDetailPage(pageProps());
    const text = textContent(element);

    expect(text).toContain('GPT-4o input tokens');
    expect(text).toContain('تكلفة الاستدعاءات');
    expect(text).toContain(formatUsd(3.125));
    expect(text).toContain(formatUsd(0));

    expect(findAll(element, byType(TableContainer))).toHaveLength(1);
    expect(findAll(element, byType(TableCell))).toHaveLength(items.length * 4);
  });

  it('renders "No line items." (and no table) for an invoice without line items', async () => {
    mocks.invoice = invoiceRow({ line_items: [] }) as unknown as Record<string, unknown>;

    const element = await InvoiceDetailPage(pageProps());

    expect(textContent(element)).toContain('No line items.');
    expect(findAll(element, byType(TableContainer))).toHaveLength(0);
  });

  it('gates Finalize/Void on role and status', async () => {
    mocks.invoice = invoiceRow({ status: 'draft' }) as unknown as Record<string, unknown>;
    let element = await InvoiceDetailPage(pageProps());
    let actions = findAll(element, byType(DashboardActionButton));
    expect(actions.map((action) => action.props.label)).toEqual(['Finalize', 'Void']);

    mocks.role = 'member';
    element = await InvoiceDetailPage(pageProps());
    actions = findAll(element, byType(DashboardActionButton));
    expect(actions).toHaveLength(0);

    mocks.role = 'owner';
    mocks.invoice = invoiceRow({ status: 'paid' }) as unknown as Record<string, unknown>;
    element = await InvoiceDetailPage(pageProps());
    actions = findAll(element, byType(DashboardActionButton));
    expect(actions).toHaveLength(0);
  });

  it('404s for a malformed invoice id without querying', async () => {
    await expect(InvoiceDetailPage(pageProps('not-a-uuid'))).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mocks.withRLS).not.toHaveBeenCalled();
  });
});
