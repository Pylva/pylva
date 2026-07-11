// Happy-path rendering for /o/[slug]/dashboard/end-users/[id]/pricing — the
// version-history table (open-ended versions render an em dash) and its
// absence when there is no history.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { TableCell, TableContainer } from '../../src/components/ui/table.js';
import { byType, findAll, textContent } from '../_helpers/rsc-tree.js';
import { openEndedPricingVersionRow, pricingVersionRow } from '../_helpers/table-fixtures.js';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  withRLS: vi.fn(),
  customer: { id: 'c0ffee00-0000-4000-8000-000000000001' } as Record<string, unknown> | null,
  getActiveVersion: vi.fn(),
  getAllVersions: vi.fn(),
  PricingEditor: () => null,
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
    role: 'owner',
    userId: 'user-1',
  }),
}));

vi.mock('@/lib/db/schema', () => ({
  customers: {
    id: 'id',
    builder_id: 'builder_id',
    external_id: 'external_id',
  },
}));

vi.mock('@/lib/db/rls', () => ({
  withRLS: mocks.withRLS,
}));

vi.mock('@/lib/billing/pricing-versioning', () => ({
  getActiveVersion: mocks.getActiveVersion,
  getAllVersions: mocks.getAllVersions,
}));

vi.mock('@/components/billing/PricingEditor', () => ({
  PricingEditor: mocks.PricingEditor,
}));

vi.mock('next/navigation', () => ({
  notFound: mocks.notFound,
}));

const { default: CustomerPricingPage } =
  await import('../../src/app/o/[slug]/dashboard/end-users/[id]/pricing/page.js');

function makeTx() {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => (mocks.customer ? [mocks.customer] : []),
  };
  return { select: () => chain };
}

function pageProps(id = 'acme-corp') {
  return {
    params: Promise.resolve({ slug: 'pylva-test', id }),
  };
}

describe('/o/[slug]/dashboard/end-users/[id]/pricing happy path', () => {
  beforeEach(() => {
    mocks.customer = { id: 'c0ffee00-0000-4000-8000-000000000001' };
    mocks.notFound.mockClear();
    mocks.getActiveVersion.mockReset().mockResolvedValue(null);
    mocks.getAllVersions.mockReset().mockResolvedValue([]);
    mocks.withRLS.mockReset();
    mocks.withRLS.mockImplementation(async (_builderId: string, cb: (tx: unknown) => unknown) =>
      cb(makeTx()),
    );
  });

  it('renders padded version-history rows; open-ended versions show an em dash', async () => {
    const closed = pricingVersionRow();
    const open = openEndedPricingVersionRow();
    mocks.getAllVersions.mockResolvedValue([open, closed]);

    const element = await CustomerPricingPage(pageProps());
    const text = textContent(element);

    expect(text).toContain('Version history');
    expect(text).toContain('v1');
    expect(text).toContain('v2');
    expect(text).toContain('flat_rate');
    expect(text).toContain(new Date(closed.effective_from).toLocaleString());
    expect(text).toContain(new Date(closed.effective_to!).toLocaleString());
    expect(text).toContain('—'); // open-ended effective_to

    expect(findAll(element, byType(TableContainer))).toHaveLength(1);
    expect(findAll(element, byType(TableCell))).toHaveLength(2 * 4);
  });

  it('omits the whole history section when there are no versions', async () => {
    mocks.getAllVersions.mockResolvedValue([]);

    const element = await CustomerPricingPage(pageProps());

    expect(textContent(element)).not.toContain('Version history');
    expect(findAll(element, byType(TableContainer))).toHaveLength(0);
  });

  it('404s when the customer external id does not resolve', async () => {
    mocks.customer = null;

    await expect(CustomerPricingPage(pageProps('missing-customer'))).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );
  });
});
