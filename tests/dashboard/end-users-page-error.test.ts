import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getCustomerCostSummaryMock, warnMock, PageHeaderMock, UsageDataUnavailableMock } =
  vi.hoisted(() => ({
    getCustomerCostSummaryMock: vi.fn(),
    warnMock: vi.fn(),
    PageHeaderMock: () => null,
    UsageDataUnavailableMock: () => null,
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

vi.mock('@/components/dashboard/UsageDataUnavailable', () => ({
  UsageDataUnavailable: UsageDataUnavailableMock,
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    child: () => ({ warn: warnMock }),
  },
}));

const { default: EndUsersPage } =
  await import('../../src/app/o/[slug]/dashboard/end-users/page.js');

function containsElementType(node: unknown, type: unknown): boolean {
  if (node === null || node === undefined || typeof node === 'boolean') return false;
  if (Array.isArray(node)) return node.some((child) => containsElementType(child, type));
  if (typeof node === 'object' && 'props' in node) {
    const element = node as { type?: unknown; props?: { children?: unknown } };
    return element.type === type || containsElementType(element.props?.children, type);
  }
  return false;
}

function pageProps() {
  return {
    searchParams: Promise.resolve({}),
  };
}

describe('/o/[slug]/dashboard/end-users error containment', () => {
  beforeEach(() => {
    getCustomerCostSummaryMock.mockReset();
    warnMock.mockClear();
  });

  it('renders unavailable state when the customer summary query aborts', async () => {
    getCustomerCostSummaryMock.mockRejectedValue(new Error('The user aborted a request.'));

    const element = await EndUsersPage(pageProps());

    expect(containsElementType(element, UsageDataUnavailableMock)).toBe(true);
    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        builder_id: 'builder-1',
        error: 'The user aborted a request.',
      }),
      'dashboard end-users data unavailable',
    );
  });
});
