// Happy-path rendering for /o/[slug]/dashboard/models — per-model rows,
// 4-decimal spend formatting, the "What if?" simulator link (absent for null
// models), the accessible action-column header, and the empty state. Error
// containment lives in models-page-error.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TableCell, TableContainer, TableHead } from '../../src/components/ui/table.js';
import { anchorHrefs, byType, findAll, textContent } from '../_helpers/rsc-tree.js';
import { hugeTokensRow, modelBreakdownRow, nullModelRow } from '../_helpers/table-fixtures.js';

const { getModelBreakdownMock, PageHeaderMock } = vi.hoisted(() => ({
  getModelBreakdownMock: vi.fn(),
  PageHeaderMock: () => null,
}));

vi.mock('@/lib/dashboard/headers', () => ({
  readDashboardHeaders: async () => ({ builderId: 'builder-1', role: 'owner', userId: 'user-1' }),
}));

vi.mock('@/lib/clickhouse/dashboard-queries', () => ({
  getModelBreakdown: getModelBreakdownMock,
}));

vi.mock('@/components/dashboard/PageHeader', () => ({
  PageHeader: PageHeaderMock,
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn() }),
  },
}));

const { default: ModelsPage } = await import('../../src/app/o/[slug]/dashboard/models/page.js');

function pageProps() {
  return {
    params: Promise.resolve({ slug: 'acme' }),
    searchParams: Promise.resolve({}),
  };
}

describe('/o/[slug]/dashboard/models happy path', () => {
  beforeEach(() => {
    getModelBreakdownMock.mockReset();
  });

  it('renders provider/model rows with 4-decimal spend and localized token counts', async () => {
    const rows = [modelBreakdownRow(), hugeTokensRow()];
    getModelBreakdownMock.mockResolvedValue(rows);

    const element = await ModelsPage(pageProps());
    const text = textContent(element);

    expect(text).toContain('openai / gpt-4o');
    expect(text).toContain('$12.3457'); // fmt$ 4-decimal
    expect(text).toContain((1234567).toLocaleString());
    expect(text).toContain((1_234_567_890).toLocaleString());

    expect(findAll(element, byType(TableContainer))).toHaveLength(1);
    expect(findAll(element, byType(TableCell))).toHaveLength(rows.length * 7);
  });

  it('links models to the simulator with encoded params, but not null models', async () => {
    getModelBreakdownMock.mockResolvedValue([modelBreakdownRow(), nullModelRow()]);

    const element = await ModelsPage(pageProps());
    const hrefs = anchorHrefs(element);

    expect(hrefs).toContain('/o/acme/dashboard/simulator?model=gpt-4o&provider=openai');
    // Null-model row renders an em dash and no simulator link.
    expect(hrefs).toHaveLength(1);
    expect(textContent(element)).toContain('other / —');
  });

  it('gives the action column an accessible (sr-only) header, never an empty th', async () => {
    getModelBreakdownMock.mockResolvedValue([modelBreakdownRow()]);

    const element = await ModelsPage(pageProps());
    const heads = findAll(element, byType(TableHead));

    expect(heads).toHaveLength(7);
    for (const head of heads) {
      expect(textContent(head).trim()).not.toBe('');
    }
    expect(textContent(heads[heads.length - 1])).toBe('Simulate');
  });

  it('renders the empty state (and no table) when there are no rows', async () => {
    getModelBreakdownMock.mockResolvedValue([]);

    const element = await ModelsPage(pageProps());

    expect(textContent(element)).toContain('Install the SDK to see your cost data.');
    expect(findAll(element, byType(TableContainer))).toHaveLength(0);
  });
});
