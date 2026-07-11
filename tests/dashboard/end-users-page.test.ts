// Happy-path rendering for /o/[slug]/dashboard/end-users — table content,
// links (including URL-encoding of non-ASCII ids), formatted values, and the
// empty state. Error containment lives in end-users-page-error.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatUsd } from '../../src/lib/formatting.js';
import { TableCell, TableContainer } from '../../src/components/ui/table.js';
import { anchorHrefs, byType, findAll, textContent } from '../_helpers/rsc-tree.js';
import {
  ARABIC_CUSTOMER_ID,
  LONG_CUSTOMER_ID,
  arabicCustomerRow,
  customerSummaryRow,
  hugeCustomerRow,
  longIdCustomerRow,
  zeroCustomerRow,
} from '../_helpers/table-fixtures.js';

const { getCustomerCostSummaryMock, PageHeaderMock } = vi.hoisted(() => ({
  getCustomerCostSummaryMock: vi.fn(),
  PageHeaderMock: () => null,
}));

vi.mock('@/lib/dashboard/headers', () => ({
  readDashboardHeaders: async () => ({ builderId: 'builder-1', role: 'owner', userId: 'user-1' }),
}));

vi.mock('@/lib/clickhouse/dashboard-queries', () => ({
  getCustomerCostSummary: getCustomerCostSummaryMock,
}));

vi.mock('@/components/dashboard/PageHeader', () => ({
  PageHeader: PageHeaderMock,
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn() }),
  },
}));

const { default: EndUsersPage } =
  await import('../../src/app/o/[slug]/dashboard/end-users/page.js');

function pageProps() {
  return {
    searchParams: Promise.resolve({}),
  };
}

describe('/o/[slug]/dashboard/end-users happy path', () => {
  beforeEach(() => {
    getCustomerCostSummaryMock.mockReset();
  });

  it('renders one padded table row per end-user with formatted values', async () => {
    const rows = [customerSummaryRow(), zeroCustomerRow(), hugeCustomerRow()];
    getCustomerCostSummaryMock.mockResolvedValue(rows);

    const element = await EndUsersPage(pageProps());
    const text = textContent(element);

    expect(text).toContain('acme-corp');
    expect(text).toContain(formatUsd(1234.5678));
    expect(text).toContain((4821).toLocaleString());
    // zero row: $0 spend, 0 events, em dash for never-seen
    expect(text).toContain(formatUsd(0));
    expect(text).toContain('—');
    // huge row survives formatting
    expect(text).toContain(formatUsd(9876543.21));
    expect(text).toContain((12345678).toLocaleString());

    // Composed from the shared primitives: container present, 4 cells per row.
    expect(findAll(element, byType(TableContainer))).toHaveLength(1);
    expect(findAll(element, byType(TableCell))).toHaveLength(rows.length * 4);
  });

  it('links every end-user to its detail page, URL-encoding non-ASCII ids', async () => {
    getCustomerCostSummaryMock.mockResolvedValue([longIdCustomerRow(), arabicCustomerRow()]);

    const element = await EndUsersPage(pageProps());
    const hrefs = anchorHrefs(element);

    expect(hrefs).toContain(`./end-users/${LONG_CUSTOMER_ID}`);
    expect(hrefs).toContain(`./end-users/${encodeURIComponent(ARABIC_CUSTOMER_ID)}`);
    // The Arabic id itself still renders as the visible link text.
    expect(textContent(element)).toContain(ARABIC_CUSTOMER_ID);
  });

  it('renders the empty state (and no table) when there are no rows', async () => {
    getCustomerCostSummaryMock.mockResolvedValue([]);

    const element = await EndUsersPage(pageProps());

    expect(textContent(element)).toContain('Install the SDK');
    expect(findAll(element, byType(TableContainer))).toHaveLength(0);
    expect(findAll(element, byType(TableCell))).toHaveLength(0);
  });
});
