import type { TransactionSql } from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const transactionMocks = vi.hoisted(() => ({
  hash: vi.fn(),
  withBuilder: vi.fn(),
}));
const exactAdapterMocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('../../src/lib/budget-control/transaction.js', () => ({
  pgCanonicalJsonbSha256: transactionMocks.hash,
  pgJsonbParameterText: (value: unknown) => JSON.stringify(value),
  withBudgetBuilderTransaction: transactionMocks.withBuilder,
}));
vi.mock('../../src/lib/budget-control/exact-backfill-adapter.js', () => ({
  getBudgetExactBackfillAdapter: exactAdapterMocks.get,
}));

const {
  BudgetControlCutoverConflictError,
  BudgetControlNotReadyError,
  BudgetExactBackfillActivationUnavailableError,
  createBudgetControlCutover,
  getBudgetControlReadiness,
  markBudgetControlReady,
  readBudgetControlReadinessInTransaction,
  refreshBudgetControlCutover,
} = await import('../../src/lib/budget-control/readiness.js');

const BUILDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CUTOVER_AT = '2026-08-01T00:00:00.000Z';
const READY_AT = '2026-08-01T00:00:00.001Z';

interface FakeTransaction {
  transaction: TransactionSql;
  statements: string[];
}

function fakeTransaction(reads: unknown[][]): FakeTransaction {
  const statements: string[] = [];
  const transaction = vi.fn(async (strings: TemplateStringsArray) => {
    const statement = strings.join('?');
    statements.push(statement);
    if (statement.includes('FROM public.budget_control_cutovers')) return reads.shift() ?? [];
    return [];
  }) as unknown as TransactionSql;
  transaction.json = ((value: unknown) => value) as TransactionSql['json'];
  return { transaction, statements };
}

function pending(mode: 'next_period' | 'exact_backfill' = 'next_period') {
  return {
    status: 'pending',
    mode,
    cutover_at: CUTOVER_AT,
    reconciled_through: null,
    has_reconciliation_snapshot: false,
    reconciliation_snapshot_hash: null,
    ready_order: null,
    ready_at: null,
  };
}

function ready(mode: 'next_period' | 'exact_backfill' = 'next_period') {
  return {
    status: 'ready',
    mode,
    cutover_at: CUTOVER_AT,
    reconciled_through: mode === 'exact_backfill' ? CUTOVER_AT : null,
    has_reconciliation_snapshot: mode === 'exact_backfill',
    reconciliation_snapshot_hash: mode === 'exact_backfill' ? 'a'.repeat(64) : null,
    ready_order: '101',
    ready_at: READY_AT,
  };
}

describe('authoritative budget-control readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    exactAdapterMocks.get.mockReturnValue(null);
    transactionMocks.hash.mockResolvedValue('a'.repeat(64));
  });

  it('parses missing, pending, and ready tenant authority without guessing', async () => {
    await expect(
      readBudgetControlReadinessInTransaction(fakeTransaction([[]]).transaction, BUILDER_ID),
    ).resolves.toEqual({ ready: false, reason: 'missing', mode: null, cutover_at: null });
    await expect(
      readBudgetControlReadinessInTransaction(
        fakeTransaction([[pending()]]).transaction,
        BUILDER_ID,
      ),
    ).resolves.toEqual({
      ready: false,
      reason: 'pending',
      mode: 'next_period',
      cutover_at: CUTOVER_AT,
    });
    await expect(
      readBudgetControlReadinessInTransaction(
        fakeTransaction([[ready('exact_backfill')]]).transaction,
        BUILDER_ID,
      ),
    ).resolves.toEqual({
      ready: true,
      mode: 'exact_backfill',
      cutover_at: CUTOVER_AT,
      ready_order: '101',
      ready_at: READY_AT,
    });
  });

  it('accepts the PostgreSQL authority sequence maximum and rejects bigint max', async () => {
    const sequenceMaximum = '9223372036854775806';

    await expect(
      readBudgetControlReadinessInTransaction(
        fakeTransaction([[{ ...ready(), ready_order: sequenceMaximum }]]).transaction,
        BUILDER_ID,
      ),
    ).resolves.toMatchObject({
      ready: true,
      ready_order: sequenceMaximum,
    });

    await expect(
      readBudgetControlReadinessInTransaction(
        fakeTransaction([[{ ...ready(), ready_order: '9223372036854775807' }]]).transaction,
        BUILDER_ID,
      ),
    ).rejects.toThrow('budget-control readiness row has an invalid lifecycle state');
  });

  it.each([
    [[pending(), pending()]],
    [[{ ...pending(), mode: 'unknown' }]],
    [[{ ...pending(), cutover_at: new Date() }]],
    [[{ ...pending(), ready_at: READY_AT }]],
    [[{ ...ready(), ready_at: null }]],
    [[{ ...ready(), ready_at: '2026-07-31T23:59:59.999Z' }]],
    [[{ ...ready('exact_backfill'), reconciled_through: null }]],
    [[{ ...ready('exact_backfill'), has_reconciliation_snapshot: false }]],
    [[{ ...ready('exact_backfill'), reconciliation_snapshot_hash: 'not-a-hash' }]],
    [[{ ...ready(), reconciled_through: CUTOVER_AT }]],
    [[{ ...ready(), ready_order: null }]],
    [[{ ...ready(), ready_order: '0' }]],
    [[{ ...ready(), ready_order: '9223372036854775807' }]],
    [[{ ...ready(), ready_order: '9223372036854775808' }]],
  ])('rejects contradictory or malformed readiness rows %#', async (rows) => {
    await expect(
      readBudgetControlReadinessInTransaction(fakeTransaction([rows]).transaction, BUILDER_ID),
    ).rejects.toThrow();
  });

  it('uses a shared builder lock for capability reads', async () => {
    const fake = fakeTransaction([[ready()]]);
    transactionMocks.withBuilder.mockImplementation(async (_builderId, _mode, callback) =>
      callback(fake.transaction),
    );

    await expect(getBudgetControlReadiness(BUILDER_ID, { maxAttempts: 4 })).resolves.toMatchObject({
      ready: true,
    });
    expect(transactionMocks.withBuilder).toHaveBeenCalledWith(
      BUILDER_ID,
      'shared',
      expect.any(Function),
      expect.objectContaining({ maxAttempts: 4 }),
    );
  });

  it.each([
    () => getBudgetControlReadiness('not-a-uuid'),
    () => createBudgetControlCutover('not-a-uuid', 'next_period'),
    () => refreshBudgetControlCutover('not-a-uuid'),
    () => markBudgetControlReady('not-a-uuid'),
  ])('rejects malformed builder identities before opening a transaction', (call) => {
    expect(call).toThrow('builderId must be a UUID');
    expect(transactionMocks.withBuilder).not.toHaveBeenCalled();
  });

  it('creates a pending cutover idempotently under the exclusive lock', async () => {
    const fake = fakeTransaction([[pending()]]);
    transactionMocks.withBuilder.mockImplementation(async (_builderId, _mode, callback) =>
      callback(fake.transaction),
    );

    await expect(createBudgetControlCutover(BUILDER_ID, 'next_period')).resolves.toMatchObject({
      ready: false,
      reason: 'pending',
    });
    expect(transactionMocks.withBuilder.mock.calls[0]?.[1]).toBe('exclusive');
    expect(fake.statements[0]).toContain('INSERT INTO public.budget_control_cutovers');
  });

  it('rejects an attempt to replace the immutable cutover mode', async () => {
    const fake = fakeTransaction([[pending('exact_backfill')]]);
    transactionMocks.withBuilder.mockImplementation(async (_builderId, _mode, callback) =>
      callback(fake.transaction),
    );

    await expect(createBudgetControlCutover(BUILDER_ID, 'next_period')).rejects.toBeInstanceOf(
      BudgetControlCutoverConflictError,
    );
  });

  it('refreshes only through the database-owned monotonic boundary guard', async () => {
    const fake = fakeTransaction([[pending()]]);
    transactionMocks.withBuilder.mockImplementation(async (_builderId, _mode, callback) =>
      callback(fake.transaction),
    );

    await refreshBudgetControlCutover(BUILDER_ID);
    expect(fake.statements[0]).toContain('SET cutover_at = cutover_at');
    expect(fake.statements[0]).toContain("status = 'pending'");
  });

  it('moves next-period readiness one way and re-reads database-owned timestamps', async () => {
    const fake = fakeTransaction([[pending()], [ready()]]);
    transactionMocks.withBuilder.mockImplementation(async (_builderId, _mode, callback) =>
      callback(fake.transaction),
    );

    await expect(markBudgetControlReady(BUILDER_ID)).resolves.toEqual({
      ready: true,
      mode: 'next_period',
      cutover_at: CUTOVER_AT,
      ready_order: '101',
      ready_at: READY_AT,
    });
    expect(fake.statements.some((statement) => statement.includes("SET status = 'ready'"))).toBe(
      true,
    );
  });

  it('fails closed when exact backfill has no reconciliation/fencing adapter', async () => {
    const fake = fakeTransaction([[pending('exact_backfill')]]);
    transactionMocks.withBuilder.mockImplementation(async (_builderId, _mode, callback) =>
      callback(fake.transaction),
    );

    await expect(markBudgetControlReady(BUILDER_ID)).rejects.toBeInstanceOf(
      BudgetExactBackfillActivationUnavailableError,
    );
    expect(transactionMocks.hash).not.toHaveBeenCalled();
    expect(fake.statements.some((statement) => statement.includes("SET status = 'ready'"))).toBe(
      false,
    );
  });

  it('runs exact reconciliation under the exclusive transaction before durable readiness', async () => {
    const fake = fakeTransaction([[pending('exact_backfill')], [ready('exact_backfill')]]);
    transactionMocks.withBuilder.mockImplementation(async (_builderId, _mode, callback) =>
      callback(fake.transaction),
    );
    const activateExactBackfill = vi.fn(async () => undefined);

    await expect(
      markBudgetControlReady(BUILDER_ID, { activateExactBackfill }),
    ).resolves.toMatchObject({ ready: true, mode: 'exact_backfill' });
    expect(activateExactBackfill).toHaveBeenCalledWith({
      transaction: fake.transaction,
      builderId: BUILDER_ID,
      cutoverAt: CUTOVER_AT,
    });
    expect(transactionMocks.hash).toHaveBeenCalledWith(fake.transaction, {
      schema_version: '1.0',
      builder_id: BUILDER_ID,
      mode: 'exact_backfill',
      cutover_at: CUTOVER_AT,
      reconciled_through: CUTOVER_AT,
    });
  });

  it('uses the process-configured exact adapter for production activation', async () => {
    const fake = fakeTransaction([[pending('exact_backfill')], [ready('exact_backfill')]]);
    transactionMocks.withBuilder.mockImplementation(async (_builderId, _mode, callback) =>
      callback(fake.transaction),
    );
    const activate = vi.fn(async () => undefined);
    exactAdapterMocks.get.mockReturnValue({ activate, resolveOpening: vi.fn() });

    await expect(markBudgetControlReady(BUILDER_ID)).resolves.toMatchObject({
      ready: true,
      mode: 'exact_backfill',
    });
    expect(activate).toHaveBeenCalledWith({
      transaction: fake.transaction,
      builderId: BUILDER_ID,
      cutoverAt: CUTOVER_AT,
    });
  });

  it('does not publish readiness when the configured activation adapter fails', async () => {
    const fake = fakeTransaction([[pending('exact_backfill')]]);
    transactionMocks.withBuilder.mockImplementation(async (_builderId, _mode, callback) =>
      callback(fake.transaction),
    );
    exactAdapterMocks.get.mockReturnValue({
      activate: vi.fn(async () => {
        throw new Error('durable reconciliation unavailable');
      }),
      resolveOpening: vi.fn(),
    });

    await expect(markBudgetControlReady(BUILDER_ID)).rejects.toThrow(
      'durable reconciliation unavailable',
    );
    expect(transactionMocks.hash).not.toHaveBeenCalled();
    expect(fake.statements.some((statement) => statement.includes("SET status = 'ready'"))).toBe(
      false,
    );
  });

  it('never reruns activation for an already-ready cutover', async () => {
    const fake = fakeTransaction([[ready('exact_backfill')]]);
    transactionMocks.withBuilder.mockImplementation(async (_builderId, _mode, callback) =>
      callback(fake.transaction),
    );
    const activateExactBackfill = vi.fn();

    await markBudgetControlReady(BUILDER_ID, { activateExactBackfill });
    expect(activateExactBackfill).not.toHaveBeenCalled();
    expect(transactionMocks.hash).not.toHaveBeenCalled();
  });

  it('requires an existing cutover before readiness activation', async () => {
    const fake = fakeTransaction([[]]);
    transactionMocks.withBuilder.mockImplementation(async (_builderId, _mode, callback) =>
      callback(fake.transaction),
    );
    await expect(markBudgetControlReady(BUILDER_ID)).rejects.toBeInstanceOf(
      BudgetControlNotReadyError,
    );
  });
});
