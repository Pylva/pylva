import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RuleEnforcement, RuleStatus, RuleType } from '@pylva/shared';
import { byType, findAll } from '../_helpers/rsc-tree.js';
import {
  budgetAccountState,
  budgetActivityPage,
  BUDGET_FIXTURE_IDS,
} from '../_helpers/budget-activity-fixtures.js';

const mocks = vi.hoisted(() => ({
  getRule: vi.fn(),
  listChannelsForRule: vi.fn(),
  withRLS: vi.fn(),
  listBudgetActivity: vi.fn(),
  getBudgetAccountState: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
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
vi.mock('@/lib/rules/repository', () => ({
  getRule: mocks.getRule,
  listChannelsForRule: mocks.listChannelsForRule,
}));
vi.mock('@/lib/db/rls', () => ({ withRLS: mocks.withRLS }));
vi.mock('@/lib/budget-activity/read-model', () => ({
  listBudgetActivity: mocks.listBudgetActivity,
  getBudgetAccountState: mocks.getBudgetAccountState,
}));
vi.mock('@/components/budget-activity/BudgetActivityPanel', () => ({
  BudgetActivityPanel: mocks.BudgetActivityPanel,
}));
vi.mock('@/components/rules/RuleToggle', () => ({ RuleToggle: () => null }));
vi.mock('@/components/rules/RuleActivateButton', () => ({ RuleActivateButton: () => null }));
vi.mock('@/components/rules/RuleChannelsManager', () => ({ RuleChannelsManager: () => null }));
vi.mock('next/navigation.js', () => ({ notFound: mocks.notFound }));

const { default: RuleDetailPage } =
  await import('../../src/app/o/[slug]/dashboard/rules/[id]/page.js');

describe('authoritative budget control on the rule detail page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRule.mockResolvedValue({
      id: BUDGET_FIXTURE_IDS.rule,
      builder_id: BUDGET_FIXTURE_IDS.builder,
      type: RuleType.BUDGET_LIMIT,
      enforcement: RuleEnforcement.PRE_CALL,
      name: 'Daily support budget',
      enabled: true,
      config: { limit_usd: 0.75, period: 'day', hard_stop: true, scope: 'per_customer' },
      customer_id: null,
      status: RuleStatus.ACTIVE,
      activated_at: new Date('2026-07-14T00:00:00.000Z'),
      last_triggered_at: null,
      last_error: null,
      created_at: new Date('2026-07-13T00:00:00.000Z'),
      updated_at: new Date('2026-07-14T00:00:00.000Z'),
    });
    mocks.listChannelsForRule.mockResolvedValue([]);
    mocks.withRLS.mockResolvedValue([]);
    mocks.listBudgetActivity.mockResolvedValue(budgetActivityPage());
    mocks.getBudgetAccountState.mockResolvedValue([budgetAccountState()]);
  });

  it('shows recent authoritative actions and current account state for the exact rule UUID', async () => {
    const element = await RuleDetailPage({
      params: Promise.resolve({ slug: 'acme', id: BUDGET_FIXTURE_IDS.rule }),
    });

    expect(mocks.listBudgetActivity).toHaveBeenCalledWith(
      BUDGET_FIXTURE_IDS.builder,
      expect.objectContaining({ rule_key: BUDGET_FIXTURE_IDS.rule, page_size: 10 }),
    );
    expect(mocks.getBudgetAccountState).toHaveBeenCalledWith(BUDGET_FIXTURE_IDS.builder, {
      rule_key: BUDGET_FIXTURE_IDS.rule,
      limit: 8,
    });
    const panels = findAll(element, byType(mocks.BudgetActivityPanel));
    expect(panels).toHaveLength(1);
    expect(panels[0]!.props).toMatchObject({
      title: 'Rule budget control',
      activities: [expect.objectContaining({ status: 'refused' })],
      accounts: [expect.objectContaining({ rule_key: BUDGET_FIXTURE_IDS.rule })],
    });
  });
});
