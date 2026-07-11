import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  hasAnyRealEventsMock,
  getOverviewMock,
  getTopEndUsersMock,
  warnMock,
  OnboardingChecklistMock,
  PageHeaderMock,
  KpiMock,
  LiveCostFeedMock,
  AnomalyContextPanelMock,
  UsageDataUnavailableMock,
} = vi.hoisted(() => ({
  hasAnyRealEventsMock: vi.fn(),
  getOverviewMock: vi.fn(),
  getTopEndUsersMock: vi.fn(),
  warnMock: vi.fn(),
  OnboardingChecklistMock: () => null,
  PageHeaderMock: () => null,
  KpiMock: () => null,
  LiveCostFeedMock: () => null,
  AnomalyContextPanelMock: () => null,
  UsageDataUnavailableMock: () => null,
}));

vi.mock('@/lib/dashboard/headers', () => ({
  readDashboardHeaders: async () => ({ builderId: 'builder-1', role: 'owner', userId: 'user-1' }),
}));

vi.mock('@/lib/clickhouse/dashboard-queries', () => ({
  hasAnyRealEvents: hasAnyRealEventsMock,
  getOverview: getOverviewMock,
  getTopEndUsers: getTopEndUsersMock,
}));

vi.mock('@/components/dashboard/OnboardingChecklist', () => ({
  OnboardingChecklist: OnboardingChecklistMock,
}));

vi.mock('@/components/dashboard/PageHeader', () => ({
  PageHeader: PageHeaderMock,
}));

vi.mock('@/components/dashboard/Kpi', () => ({
  Kpi: KpiMock,
}));

vi.mock('@/components/dashboard/LiveCostFeed', () => ({
  LiveCostFeed: LiveCostFeedMock,
}));

vi.mock('@/components/anomalies/AnomalyContextPanel', () => ({
  AnomalyContextPanel: AnomalyContextPanelMock,
}));

vi.mock('@/components/dashboard/UsageDataUnavailable', () => ({
  UsageDataUnavailable: UsageDataUnavailableMock,
}));

vi.mock('@/lib/config', () => ({
  env: { ENABLE_SSE_FEED: false },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    child: () => ({ warn: warnMock }),
  },
}));

const { default: OverviewPage } = await import('../../src/app/o/[slug]/dashboard/page.js');

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
    params: Promise.resolve({ slug: 'acme-co' }),
    searchParams: Promise.resolve({}),
  };
}

describe('/o/[slug]/dashboard overview error containment', () => {
  beforeEach(() => {
    hasAnyRealEventsMock.mockReset();
    getOverviewMock.mockReset();
    getTopEndUsersMock.mockReset();
    warnMock.mockClear();
  });

  it('renders unavailable state instead of onboarding when the real-event probe fails', async () => {
    hasAnyRealEventsMock.mockRejectedValue(new Error('Timeout error.'));

    const element = await OverviewPage(pageProps());

    expect(containsElementType(element, UsageDataUnavailableMock)).toBe(true);
    expect(containsElementType(element, OnboardingChecklistMock)).toBe(false);
    expect(getOverviewMock).not.toHaveBeenCalled();
    expect(getTopEndUsersMock).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        builder_id: 'builder-1',
        error: 'Timeout error.',
      }),
      'dashboard overview data unavailable',
    );
  });

  it('renders unavailable state instead of onboarding when overview metrics fail', async () => {
    hasAnyRealEventsMock.mockResolvedValue(true);
    getOverviewMock.mockRejectedValue(new Error('Timeout error.'));
    getTopEndUsersMock.mockResolvedValue([]);

    const element = await OverviewPage(pageProps());

    expect(containsElementType(element, UsageDataUnavailableMock)).toBe(true);
    expect(containsElementType(element, OnboardingChecklistMock)).toBe(false);
    expect(getOverviewMock).toHaveBeenCalledWith(
      'builder-1',
      expect.objectContaining({ from: expect.any(Date), to: expect.any(Date) }),
      { includeDemo: false, hasRealEvents: true },
    );
  });
});
