import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  BUDGET_FIXTURE_IDS,
  budgetActivity,
  budgetAccountState,
} from '../_helpers/budget-activity-fixtures.js';

const mocks = vi.hoisted(() => ({ withBudgetControlReadTransaction: vi.fn() }));

vi.mock('../../src/lib/budget-control/read-transaction.js', () => ({
  withBudgetControlReadTransaction: mocks.withBudgetControlReadTransaction,
}));

const { getBudgetAccountState, listBudgetActivity } =
  await import('../../src/lib/budget-activity/read-model.js');
const { parseBudgetActivityQuery } = await import('../../src/lib/budget-activity/query.js');

function databaseActivityRow() {
  const activity = budgetActivity();
  return { ...activity, allocations: activity.allocations };
}

function executeWith(...results: unknown[]) {
  const execute = vi.fn();
  for (const result of results) execute.mockResolvedValueOnce(result);
  mocks.withBudgetControlReadTransaction.mockImplementation(
    async (_builderId: string, callback: (tx: unknown) => unknown) => callback({ execute }),
  );
  return execute;
}

describe('authoritative budget activity read model', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads one tenant-scoped PostgreSQL action with every allocation proof field', async () => {
    const execute = executeWith([{ total: '1' }], [databaseActivityRow()]);
    const query = parseBudgetActivityQuery(
      new URLSearchParams({ status: 'refused', customer: 'end_user_42' }),
    );

    await expect(listBudgetActivity(BUDGET_FIXTURE_IDS.builder, query)).resolves.toMatchObject({
      authority: 'postgresql',
      pagination: { total: 1, total_pages: 1 },
      activities: [
        {
          status: 'refused',
          provider_request: 'not_sent',
          cost_event_id: null,
          allocations: [
            {
              rule_key: BUDGET_FIXTURE_IDS.rule,
              committed_before_usd: '0.74',
              reserved_before_usd: '0.01',
              unresolved_before_usd: '0',
              requested_usd: '0.0000042',
              remaining_usd: '0',
            },
          ],
        },
      ],
    });
    expect(mocks.withBudgetControlReadTransaction).toHaveBeenCalledWith(
      BUDGET_FIXTURE_IDS.builder,
      expect.any(Function),
    );

    const dialect = new PgDialect();
    const pageSql = dialect.sqlToQuery(execute.mock.calls[1]![0] as SQL).sql;
    expect(pageSql).toContain('FROM public.budget_reservations');
    expect(pageSql).toContain('LEFT JOIN public.budget_usage_ledger');
    expect(pageSql).not.toContain('cost_events');
  });

  it('does not invent a total when a requested page is empty', async () => {
    executeWith([{ total: '53' }], []);
    const query = parseBudgetActivityQuery(new URLSearchParams({ page: '99', page_size: '10' }));
    const result = await listBudgetActivity(BUDGET_FIXTURE_IDS.builder, query);
    expect(result.activities).toEqual([]);
    expect(result.pagination).toEqual({ page: 99, page_size: 10, total: 53, total_pages: 6 });
  });

  it('fails visibly on corrupt allocation or unsupported dashboard counts', async () => {
    executeWith([{ total: '1' }], [{ ...databaseActivityRow(), allocations: [{}] }]);
    await expect(
      listBudgetActivity(
        BUDGET_FIXTURE_IDS.builder,
        parseBudgetActivityQuery(new URLSearchParams()),
      ),
    ).rejects.toThrow('allocation has an invalid authoritative shape');

    vi.clearAllMocks();
    executeWith([{ total: '9007199254740992' }]);
    await expect(
      listBudgetActivity(
        BUDGET_FIXTURE_IDS.builder,
        parseBudgetActivityQuery(new URLSearchParams()),
      ),
    ).rejects.toThrow('outside the supported dashboard range');
  });

  it('reads relevant current and historical account state from PostgreSQL', async () => {
    executeWith([budgetAccountState()]);
    await expect(
      getBudgetAccountState(BUDGET_FIXTURE_IDS.builder, {
        customer_id: 'end_user_42',
        limit: 8,
      }),
    ).resolves.toEqual([budgetAccountState()]);
  });

  it('requires a bounded, valid state scope before opening an RLS transaction', async () => {
    await expect(getBudgetAccountState(BUDGET_FIXTURE_IDS.builder, {})).rejects.toThrow(
      'requires customer_id, trace_id, or rule_key',
    );
    await expect(
      getBudgetAccountState(BUDGET_FIXTURE_IDS.builder, { trace_id: 'bad' }),
    ).rejects.toThrow('trace_id must be a UUID');
    await expect(
      getBudgetAccountState(BUDGET_FIXTURE_IDS.builder, {
        rule_key: BUDGET_FIXTURE_IDS.rule,
        limit: 51,
      }),
    ).rejects.toThrow('limit must be between 1 and 50');
    expect(mocks.withBudgetControlReadTransaction).not.toHaveBeenCalled();
  });
});
