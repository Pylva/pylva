import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getModelBreakdownMock, warnMock, PageHeaderMock, UsageDataUnavailableMock } = vi.hoisted(
  () => ({
    getModelBreakdownMock: vi.fn(),
    warnMock: vi.fn(),
    PageHeaderMock: () => null,
    UsageDataUnavailableMock: () => null,
  }),
);

vi.mock('@/lib/dashboard/headers', () => ({
  readDashboardHeaders: async () => ({ builderId: 'builder-1', role: 'owner', userId: 'user-1' }),
}));

vi.mock('@/lib/clickhouse/dashboard-queries', () => ({
  getModelBreakdown: getModelBreakdownMock,
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

const { default: ModelsPage } = await import('../../src/app/o/[slug]/dashboard/models/page.js');

function containsElementType(node: unknown, type: unknown): boolean {
  if (node === null || node === undefined || typeof node === 'boolean') return false;
  if (Array.isArray(node)) return node.some((child) => containsElementType(child, type));
  if (typeof node === 'object' && 'props' in node) {
    const element = node as { type?: unknown; props?: { children?: unknown } };
    return element.type === type || containsElementType(element.props?.children, type);
  }
  return false;
}

function pageProps(searchParams: { from?: string; to?: string } = {}) {
  return {
    params: Promise.resolve({ slug: 'acme-co' }),
    searchParams: Promise.resolve(searchParams),
  };
}

describe('/o/[slug]/dashboard/models error containment', () => {
  beforeEach(() => {
    getModelBreakdownMock.mockReset();
    warnMock.mockClear();
  });

  it('renders unavailable state when the model breakdown query aborts', async () => {
    getModelBreakdownMock.mockRejectedValue(new Error('The user aborted a request.'));

    const element = await ModelsPage(pageProps());

    expect(containsElementType(element, UsageDataUnavailableMock)).toBe(true);
    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        builder_id: 'builder-1',
        error: 'The user aborted a request.',
      }),
      'dashboard models data unavailable',
    );
  });

  it('normalizes malformed date params instead of reporting usage data unavailable', async () => {
    getModelBreakdownMock.mockResolvedValue([]);

    const element = await ModelsPage(pageProps({ from: 'not-a-date', to: 'also-bad' }));

    expect(containsElementType(element, UsageDataUnavailableMock)).toBe(false);
    expect(warnMock).not.toHaveBeenCalled();
    expect(getModelBreakdownMock).toHaveBeenCalledTimes(1);

    const [, range, opts] = getModelBreakdownMock.mock.calls[0] as [
      string,
      { from: Date; to: Date },
      { includeDemo: boolean },
    ];
    expect(Number.isFinite(range.from.getTime())).toBe(true);
    expect(Number.isFinite(range.to.getTime())).toBe(true);
    expect(range.to.getTime() - range.from.getTime()).toBe(30 * 86_400_000);
    expect(opts).toEqual({ includeDemo: false });
  });
});
