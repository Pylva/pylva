import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listBudgetActivity: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock('@/lib/dashboard/headers', () => ({
  readDashboardHeaders: async () => ({
    builderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    role: 'owner',
    userId: 'user-1',
  }),
}));
vi.mock('@/lib/budget-activity/query', () => ({
  BudgetActivityQueryError: class BudgetActivityQueryError extends Error {},
  parseBudgetActivityQuery: () => ({
    page: 1,
    page_size: 25,
    status: 'all',
    kind: 'all',
    customer: null,
    source: null,
    trace_id: null,
    rule_key: null,
  }),
}));
vi.mock('@/lib/budget-activity/read-model', () => ({
  listBudgetActivity: mocks.listBudgetActivity,
}));
vi.mock('@/lib/logger', () => ({
  logger: { child: () => ({ warn: mocks.logWarn }) },
}));
vi.mock('@/components/dashboard/PageHeader', () => ({
  PageHeader: function PageHeaderMock() {
    return null;
  },
}));
vi.mock('@/components/budget-activity/BudgetActivityExplorer', () => ({
  BudgetActivityExplorer: function BudgetActivityExplorerMock() {
    return null;
  },
}));

const { default: BudgetActivityPage } =
  await import('../../src/app/o/[slug]/dashboard/budget-activity/page.js');

describe('budget activity dashboard privacy', () => {
  it('logs only an allowlisted code and opaque reference for unexpected failures', async () => {
    const secret = 'postgres://operator:password@internal/authority';
    mocks.listBudgetActivity.mockRejectedValueOnce(new Error(secret));

    const element = await BudgetActivityPage({ searchParams: Promise.resolve({}) });

    expect(element).toBeDefined();
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    const [fields, message] = mocks.logWarn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toMatchObject({
      builder_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      error_code: 'budget_activity_unavailable',
    });
    expect(fields['error_ref']).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/u));
    expect(`${JSON.stringify(fields)} ${message}`).not.toContain(secret);
    expect(fields).not.toHaveProperty('error');
  });
});
