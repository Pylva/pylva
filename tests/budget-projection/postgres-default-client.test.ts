import type { Sql } from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getReadyBudgetControlSql = vi.fn();

vi.mock('../../src/lib/budget-control/runtime-posture.js', () => ({
  getReadyBudgetControlSql,
}));

const { __budgetProjectionPostgresTesting, createBudgetProjectionPostgresStore } =
  await import('../../src/lib/budget-projection/postgres.js');

const BUILDER_ID = '10000000-0000-4000-8000-000000000001';

describe('projection default dedicated database client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __budgetProjectionPostgresTesting.resetDefaultSql();
  });

  it('clears a rejected readiness promise so a recovered attestation can retry', async () => {
    const transientFailure = new Error('temporary attestation query failure');
    const sql = vi.fn(async () => [{ builder_id_text: BUILDER_ID }]) as unknown as Sql;
    getReadyBudgetControlSql.mockRejectedValueOnce(transientFailure).mockResolvedValueOnce(sql);
    const store = createBudgetProjectionPostgresStore();

    await expect(store.listBuilderPage(null, 1)).rejects.toBe(transientFailure);
    await expect(store.listBuilderPage(null, 1)).resolves.toEqual([BUILDER_ID]);
    expect(getReadyBudgetControlSql).toHaveBeenCalledTimes(2);
  });

  it('shares one successful readiness initialization across concurrent calls', async () => {
    let release!: (sql: Sql) => void;
    const ready = new Promise<Sql>((resolve) => {
      release = resolve;
    });
    const sql = vi.fn(async () => [{ builder_id_text: BUILDER_ID }]) as unknown as Sql;
    getReadyBudgetControlSql.mockReturnValue(ready);
    const store = createBudgetProjectionPostgresStore();

    const pages = Promise.all([store.listBuilderPage(null, 1), store.listBuilderPage(null, 1)]);
    await vi.waitFor(() => expect(getReadyBudgetControlSql).toHaveBeenCalledTimes(1));
    release(sql);
    await expect(pages).resolves.toEqual([[BUILDER_ID], [BUILDER_ID]]);
    expect(getReadyBudgetControlSql).toHaveBeenCalledTimes(1);
  });
});
