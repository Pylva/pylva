import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql as drizzleSql } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
  unsafe: vi.fn(),
  rawTransaction: { unsafe: vi.fn() },
  withBudgetControlTransaction: vi.fn(),
}));

vi.mock('../../src/lib/budget-control/transaction.js', () => ({
  withBudgetControlTransaction: mocks.withBudgetControlTransaction,
}));

const { withBudgetControlReadTransaction } =
  await import('../../src/lib/budget-control/read-transaction.js');

describe('withBudgetControlReadTransaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rawTransaction.unsafe = mocks.unsafe;
    mocks.withBudgetControlTransaction.mockImplementation(
      async (_builderId: string, callback: (transaction: unknown) => Promise<unknown>) =>
        callback(mocks.rawTransaction),
    );
  });

  it('keeps Drizzle reads inside the dedicated tenant-scoped transaction', async () => {
    const options = { maxAttempts: 1 as const };
    mocks.unsafe.mockResolvedValue([{ value: 'ok' }]);

    await expect(
      withBudgetControlReadTransaction(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        async (transaction) => transaction.execute(drizzleSql`SELECT 1 AS value`),
        options,
      ),
    ).resolves.toEqual([{ value: 'ok' }]);

    expect(mocks.withBudgetControlTransaction).toHaveBeenCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      expect.any(Function),
      options,
    );
    expect(mocks.unsafe).toHaveBeenCalledWith('SELECT 1 AS value', []);
  });
});
