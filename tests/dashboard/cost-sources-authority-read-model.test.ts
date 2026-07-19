import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  withBudgetControlReadTransaction: vi.fn(),
}));

vi.mock('../../src/lib/budget-control/read-transaction.js', () => ({
  withBudgetControlReadTransaction: mocks.withBudgetControlReadTransaction,
}));

const { readCostSourceAuthority } =
  await import('../../src/lib/cost-sources/authority-read-model.js');

const BUILDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('Cost Sources authority read model', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withBudgetControlReadTransaction.mockImplementation(
      async (_builderId: string, callback: (transaction: unknown) => Promise<unknown>) =>
        callback({ execute: mocks.execute }),
    );
  });

  it('returns only strict boolean authority facts from the dedicated transaction', async () => {
    mocks.execute.mockResolvedValue([
      { workspace_control_ready: true, has_active_hard_stop_budget: false },
    ]);

    await expect(readCostSourceAuthority(BUILDER_ID)).resolves.toEqual({
      workspaceControlReady: true,
      hasActiveHardStopBudget: false,
    });
    expect(mocks.withBudgetControlReadTransaction).toHaveBeenCalledWith(
      BUILDER_ID,
      expect.any(Function),
    );
  });

  it.each([
    [[]],
    [[{ workspace_control_ready: 1, has_active_hard_stop_budget: false }]],
    [[{ workspace_control_ready: false, has_active_hard_stop_budget: 'false' }]],
    [
      [
        [
          { workspace_control_ready: false, has_active_hard_stop_budget: false },
          { workspace_control_ready: false, has_active_hard_stop_budget: false },
        ],
      ],
    ],
  ])('rejects an invalid authoritative row shape %#', async (rows) => {
    mocks.execute.mockResolvedValue(rows);
    await expect(readCostSourceAuthority(BUILDER_ID)).rejects.toThrow(
      'cost source authority returned an invalid shape',
    );
  });
});
