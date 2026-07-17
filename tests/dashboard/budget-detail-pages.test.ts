import { beforeEach, describe, expect, it, vi } from 'vitest';
import { byType, findAll, textContent } from '../_helpers/rsc-tree.js';
import {
  budgetAccountState,
  budgetActivity,
  budgetActivityPage,
  BUDGET_FIXTURE_IDS,
} from '../_helpers/budget-activity-fixtures.js';

const mocks = vi.hoisted(() => ({
  getTraceTree: vi.fn(),
  getCustomerDetail: vi.fn(),
  listBudgetActivity: vi.fn(),
  getBudgetAccountState: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  TraceTree: function TraceTreeMock() {
    return null;
  },
  BudgetActivityPanel: function BudgetActivityPanelMock() {
    return null;
  },
}));

vi.mock('@/lib/dashboard/headers', () => ({
  readDashboardHeaders: async () => ({
    builderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    role: 'owner',
    userId: 'user-1',
  }),
}));
vi.mock('@/lib/clickhouse/dashboard-queries', () => ({
  getTraceTree: mocks.getTraceTree,
  getCustomerDetail: mocks.getCustomerDetail,
}));
vi.mock('@/lib/budget-activity/read-model', () => ({
  listBudgetActivity: mocks.listBudgetActivity,
  getBudgetAccountState: mocks.getBudgetAccountState,
}));
vi.mock('@/components/dashboard/TraceTree', () => ({ TraceTree: mocks.TraceTree }));
vi.mock('@/components/budget-activity/BudgetActivityPanel', () => ({
  BudgetActivityPanel: mocks.BudgetActivityPanel,
}));
vi.mock('@/components/dashboard/DashboardDownloadLink', () => ({
  DashboardDownloadLink: ({ children }: { children: unknown }) => children,
}));
vi.mock('next/navigation.js', () => ({ notFound: mocks.notFound }));

const { default: TracePage } = await import('../../src/app/o/[slug]/dashboard/traces/[id]/page.js');
const { default: EndUserDetailPage } =
  await import('../../src/app/o/[slug]/dashboard/end-users/[id]/page.js');

function emptyCustomerDetail() {
  return {
    customer_id: 'end_user_42',
    total_spend_usd: 0,
    event_count: 0,
    by_model: [],
    by_step: [],
    daily: [],
  };
}

function traceProps() {
  return {
    params: Promise.resolve({ slug: 'acme', id: BUDGET_FIXTURE_IDS.trace }),
  };
}

function endUserProps(id = 'end_user_42') {
  return {
    params: Promise.resolve({ slug: 'acme', id }),
    searchParams: Promise.resolve({}),
  };
}

describe('authoritative budget control on trace and end-user detail pages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTraceTree.mockResolvedValue({ spans: [], truncated: false, totalSpanCount: 0 });
    mocks.getCustomerDetail.mockResolvedValue(emptyCustomerDetail());
    mocks.listBudgetActivity.mockResolvedValue(budgetActivityPage());
    mocks.getBudgetAccountState.mockResolvedValue([budgetAccountState()]);
  });

  it('renders a blocked-only trace and explicitly states that no cost span was created', async () => {
    const element = await TracePage(traceProps());

    expect(mocks.notFound).not.toHaveBeenCalled();
    expect(textContent(element)).toContain('No cost span was created.');
    expect(textContent(element)).toContain('before provider dispatch');
    const panels = findAll(element, byType(mocks.BudgetActivityPanel));
    expect(panels).toHaveLength(1);
    expect(panels[0]!.props).toMatchObject({
      activities: [expect.objectContaining({ status: 'refused', provider_request: 'not_sent' })],
      accounts: [expect.objectContaining({ committed_usd: '0.74' })],
      title: 'Trace budget control',
    });
  });

  it('decorates one matching charged span and omits its duplicate activity row', async () => {
    const charged = budgetActivity({ status: 'charged' });
    mocks.getTraceTree.mockResolvedValue({
      spans: [
        {
          trace_id: BUDGET_FIXTURE_IDS.trace,
          span_id: BUDGET_FIXTURE_IDS.span,
          parent_span_id: null,
          step_name: 'answer_question',
          provider: 'openai',
          model: 'gpt-4o-mini',
          tokens_in: 10,
          tokens_out: 5,
          cost_usd: 0.0000031,
          latency_ms: 24,
          status: 'success',
          timestamp: '2026-07-14T09:30:00.000Z',
        },
      ],
      truncated: false,
      totalSpanCount: 1,
    });
    mocks.listBudgetActivity.mockResolvedValue(budgetActivityPage([charged]));

    const element = await TracePage(traceProps());
    const trees = findAll(element, byType(mocks.TraceTree));
    const panels = findAll(element, byType(mocks.BudgetActivityPanel));

    expect(trees).toHaveLength(1);
    expect(trees[0]!.props.controlActions).toEqual([charged]);
    expect(panels[0]!.props.activities).toEqual([]);
  });

  it('renders a blocked-only end-user with zero spend and control state', async () => {
    const element = await EndUserDetailPage(endUserProps());

    expect(mocks.notFound).not.toHaveBeenCalled();
    expect(
      findAll(
        element,
        (node) => typeof node.type === 'function' && node.type.name === 'NoSpendBreakdown',
      ),
    ).toHaveLength(3);
    expect(
      findAll(element, (node) => typeof node.type === 'function' && node.type.name === 'Card').map(
        (card) => card.props,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Total spend', value: '$0.00' }),
        expect.objectContaining({ label: 'Events', value: '0' }),
      ]),
    );
    const panels = findAll(element, byType(mocks.BudgetActivityPanel));
    expect(panels[0]!.props).toMatchObject({
      title: 'End-user budget control',
      activities: [expect.objectContaining({ status: 'refused' })],
      accounts: [expect.objectContaining({ available_usd: '0' })],
    });
  });

  it('still returns not found when neither telemetry nor control authority knows the entity', async () => {
    mocks.listBudgetActivity.mockResolvedValue(budgetActivityPage([]));
    mocks.getBudgetAccountState.mockResolvedValue([]);

    await expect(TracePage(traceProps())).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(EndUserDetailPage(endUserProps())).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mocks.notFound).toHaveBeenCalledTimes(2);
  });
});
