import type { TransactionSql } from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const transactionMocks = vi.hoisted(() => ({
  decimal: vi.fn(),
  withBuilder: vi.fn(),
}));
const exactAdapterMocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('../../src/lib/budget-control/transaction.js', () => ({
  pgCanonicalDecimalText: transactionMocks.decimal,
  pgCanonicalJsonbSha256: vi.fn(),
  withBudgetBuilderTransaction: transactionMocks.withBuilder,
}));
vi.mock('../../src/lib/budget-control/exact-backfill-adapter.js', () => ({
  getBudgetExactBackfillAdapter: exactAdapterMocks.get,
}));

const {
  BudgetAccountPeriodNotEligibleError,
  BudgetExactOpeningBalanceUnavailableError,
  createBudgetAccountMaterializer,
  ensureBudgetAccountsMaterialized,
} = await import('../../src/lib/budget-control/accounts.js');
const { BudgetControlNotReadyError } = await import('../../src/lib/budget-control/readiness.js');

const BUILDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RULE_KEY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REVISION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ACCOUNT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CUTOVER_AT = '2026-08-01T00:00:00.000Z';

interface FakeTransactionOptions {
  readiness?: unknown[];
  revisions?: unknown[];
  inserted?: unknown[][];
}

function fakeTransaction(options: FakeTransactionOptions = {}) {
  const statements: string[] = [];
  const inserted = [...(options.inserted ?? [])];
  const transaction = vi.fn(async (strings: TemplateStringsArray) => {
    const statement = strings.join('?');
    statements.push(statement);
    if (statement.includes('FROM public.budget_control_cutovers')) {
      return (
        options.readiness ?? [
          {
            status: 'ready',
            mode: 'next_period',
            cutover_at: CUTOVER_AT,
            reconciled_through: null,
            has_reconciliation_snapshot: false,
            reconciliation_snapshot_hash: null,
            ready_order: '101',
            ready_at: CUTOVER_AT,
          },
        ]
      );
    }
    if (statement.includes('WITH server_clock AS MATERIALIZED')) {
      return options.revisions ?? [];
    }
    if (statement.includes('WITH input AS MATERIALIZED')) return inserted.shift() ?? [];
    return [];
  }) as unknown as TransactionSql;
  transaction.json = ((value: unknown) => value) as TransactionSql['json'];
  return { transaction, statements };
}

function revision(overrides: Record<string, unknown> = {}) {
  return {
    id: REVISION_ID,
    rule_key: RULE_KEY,
    revision: '0',
    active_from: CUTOVER_AT,
    scope: 'per_customer',
    subject_customer_id: 'customer_1',
    period: 'month',
    period_start: '2026-08-01T00:00:00.000Z',
    period_end: '2026-09-01T00:00:00.000Z',
    enforcement: 'hard_stop',
    limit_usd: '100',
    opening_source: 'post_cutover_zero',
    account_id: null,
    evidence_source: null,
    evidence_measured_through: null,
    ...overrides,
  };
}

function runWith(fake: ReturnType<typeof fakeTransaction>) {
  transactionMocks.withBuilder.mockImplementation(async (_builderId, _mode, callback) =>
    callback(fake.transaction),
  );
}

describe('authoritative budget account materialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    exactAdapterMocks.get.mockReturnValue(null);
    transactionMocks.decimal.mockImplementation(async (_tx, value: string) => value);
  });

  it.each([
    [{ builderId: '', customerId: 'customer_1' }, 'builderId must be a UUID'],
    [{ builderId: BUILDER_ID, customerId: '' }, 'customerId'],
    [{ builderId: BUILDER_ID, customerId: 'contains space' }, 'customerId'],
    [{ builderId: BUILDER_ID, customerId: 'x'.repeat(256) }, 'customerId'],
  ])('rejects unsafe materialization identity %#', async (input, message) => {
    await expect(ensureBudgetAccountsMaterialized(input)).rejects.toThrow(message);
    expect(transactionMocks.withBuilder).not.toHaveBeenCalled();
  });

  it('requires typed ready authority before reading rules or accounts', async () => {
    const fake = fakeTransaction({
      readiness: [
        {
          status: 'pending',
          mode: 'next_period',
          cutover_at: CUTOVER_AT,
          reconciled_through: null,
          has_reconciliation_snapshot: false,
          reconciliation_snapshot_hash: null,
          ready_order: null,
          ready_at: null,
        },
      ],
    });
    runWith(fake);

    await expect(
      ensureBudgetAccountsMaterialized({ builderId: BUILDER_ID, customerId: 'customer_1' }),
    ).rejects.toBeInstanceOf(BudgetControlNotReadyError);
    expect(fake.statements.some((statement) => statement.includes('WITH server_clock'))).toBe(
      false,
    );
  });

  it('returns an empty deterministic result when no rule applies', async () => {
    const fake = fakeTransaction();
    runWith(fake);
    await expect(
      ensureBudgetAccountsMaterialized({ builderId: BUILDER_ID, customerId: 'customer_1' }),
    ).resolves.toEqual({
      builder_id: BUILDER_ID,
      customer_id: 'customer_1',
      existing: 0,
      materialized: 0,
      account_ids: [],
    });
    expect(transactionMocks.withBuilder.mock.calls[0]?.[1]).toBe('exclusive');
  });

  it('derives safe-zero eligibility from the stable revision-zero authority order', async () => {
    const fake = fakeTransaction();
    runWith(fake);
    await ensureBudgetAccountsMaterialized({
      builderId: BUILDER_ID,
      customerId: 'customer_1',
    });
    const query = fake.statements.find((statement) => statement.includes('WITH server_clock'));
    expect(query).toContain('origin.revision = 0');
    expect(query).toContain('bounded.rule_origin_authority_order >');
    expect(query).not.toContain('bounded.rule_origin_active_from');
    expect(query).not.toContain('bounded.revision = 0');
  });

  it('retains a stable existing account only when immutable opening evidence exists', async () => {
    const fake = fakeTransaction({
      revisions: [
        revision({
          account_id: ACCOUNT_ID,
          evidence_source: 'post_cutover_zero',
          evidence_measured_through: CUTOVER_AT,
        }),
      ],
    });
    runWith(fake);
    await expect(
      ensureBudgetAccountsMaterialized({ builderId: BUILDER_ID, customerId: 'customer_1' }),
    ).resolves.toMatchObject({ existing: 1, materialized: 0, account_ids: [ACCOUNT_ID] });
    expect(fake.statements.filter((statement) => statement.includes('WITH input'))).toHaveLength(0);
  });

  it('fails closed if an account exists without its evidence closure', async () => {
    const fake = fakeTransaction({
      revisions: [revision({ account_id: ACCOUNT_ID })],
    });
    runWith(fake);
    await expect(
      ensureBudgetAccountsMaterialized({ builderId: BUILDER_ID, customerId: 'customer_1' }),
    ).rejects.toThrow('incomplete opening evidence');
  });

  it.each([
    [
      {
        evidence_source: 'post_cutover_zero',
        evidence_measured_through: '2026-08-01T00:00:00.001Z',
      },
    ],
    [{ evidence_source: 'unknown', evidence_measured_through: CUTOVER_AT }],
  ])('fails closed on malformed existing opening evidence %#', async (overrides) => {
    const fake = fakeTransaction({
      revisions: [
        revision({
          account_id: ACCOUNT_ID,
          ...overrides,
        }),
      ],
    });
    runWith(fake);
    await expect(
      ensureBudgetAccountsMaterialized({ builderId: BUILDER_ID, customerId: 'customer_1' }),
    ).rejects.toThrow(/invalid applicable revision|opening evidence/);
  });

  it('trusts immutable evidence closure when a successor revision no longer derives its source', async () => {
    const fake = fakeTransaction({
      revisions: [
        revision({
          revision: '1',
          opening_source: 'unavailable',
          account_id: ACCOUNT_ID,
          evidence_source: 'post_cutover_zero',
          evidence_measured_through: CUTOVER_AT,
        }),
      ],
    });
    runWith(fake);
    await expect(
      ensureBudgetAccountsMaterialized({ builderId: BUILDER_ID, customerId: 'customer_1' }),
    ).resolves.toMatchObject({ existing: 1, materialized: 0, account_ids: [ACCOUNT_ID] });
  });

  it('atomically creates a post-cutover account and explicit zero evidence', async () => {
    const fake = fakeTransaction({
      revisions: [revision()],
      inserted: [[{ account_id: ACCOUNT_ID, source: 'post_cutover_zero' }]],
    });
    runWith(fake);
    await expect(
      ensureBudgetAccountsMaterialized({ builderId: BUILDER_ID, customerId: 'customer_1' }),
    ).resolves.toMatchObject({ existing: 0, materialized: 1, account_ids: [ACCOUNT_ID] });
    const insert = fake.statements.find((statement) => statement.includes('WITH input'));
    expect(insert).toContain('INSERT INTO public.budget_accounts');
    expect(insert).toContain('INSERT INTO public.budget_account_opening_evidence');
  });

  it('rejects a current-period account that has neither safe-zero nor exact evidence', async () => {
    const fake = fakeTransaction({ revisions: [revision({ opening_source: 'unavailable' })] });
    runWith(fake);
    await expect(
      ensureBudgetAccountsMaterialized({ builderId: BUILDER_ID, customerId: 'customer_1' }),
    ).rejects.toBeInstanceOf(BudgetAccountPeriodNotEligibleError);
  });

  it('requires an explicit exact opening resolver and never guesses zero', async () => {
    const fake = fakeTransaction({
      readiness: [
        {
          status: 'ready',
          mode: 'exact_backfill',
          cutover_at: CUTOVER_AT,
          reconciled_through: CUTOVER_AT,
          has_reconciliation_snapshot: true,
          reconciliation_snapshot_hash: 'a'.repeat(64),
          ready_order: '101',
          ready_at: CUTOVER_AT,
        },
      ],
      revisions: [revision({ opening_source: 'exact_backfill' })],
    });
    runWith(fake);
    await expect(
      ensureBudgetAccountsMaterialized({ builderId: BUILDER_ID, customerId: 'customer_1' }),
    ).rejects.toBeInstanceOf(BudgetExactOpeningBalanceUnavailableError);
  });

  it('uses the process-configured exact adapter for production materialization', async () => {
    const fake = fakeTransaction({
      readiness: [
        {
          status: 'ready',
          mode: 'exact_backfill',
          cutover_at: CUTOVER_AT,
          reconciled_through: CUTOVER_AT,
          has_reconciliation_snapshot: true,
          reconciliation_snapshot_hash: 'a'.repeat(64),
          ready_order: '101',
          ready_at: CUTOVER_AT,
        },
      ],
      revisions: [revision({ opening_source: 'exact_backfill' })],
      inserted: [[{ account_id: ACCOUNT_ID, source: 'exact_backfill' }]],
    });
    runWith(fake);
    const resolveOpening = vi.fn(async () => '7.25');
    exactAdapterMocks.get.mockReturnValue({ activate: vi.fn(), resolveOpening });

    await expect(
      ensureBudgetAccountsMaterialized({ builderId: BUILDER_ID, customerId: 'customer_1' }),
    ).resolves.toMatchObject({ materialized: 1 });
    expect(resolveOpening).toHaveBeenCalledWith(
      expect.objectContaining({
        tx: fake.transaction,
        builderId: BUILDER_ID,
        subjectCustomerId: 'customer_1',
        measuredThrough: CUTOVER_AT,
      }),
    );
    expect(transactionMocks.decimal).toHaveBeenCalledWith(fake.transaction, '7.25');
  });

  it('canonicalizes exact opening evidence and passes the immutable period identity', async () => {
    const fake = fakeTransaction({
      readiness: [
        {
          status: 'ready',
          mode: 'exact_backfill',
          cutover_at: CUTOVER_AT,
          reconciled_through: CUTOVER_AT,
          has_reconciliation_snapshot: true,
          reconciliation_snapshot_hash: 'a'.repeat(64),
          ready_order: '101',
          ready_at: CUTOVER_AT,
        },
      ],
      revisions: [revision({ opening_source: 'exact_backfill' })],
      inserted: [[{ account_id: ACCOUNT_ID, source: 'exact_backfill' }]],
    });
    runWith(fake);
    transactionMocks.decimal.mockResolvedValue('12.34');
    const resolveExactOpeningBalance = vi.fn(async () => '12.3400');

    await expect(
      ensureBudgetAccountsMaterialized(
        { builderId: BUILDER_ID, customerId: 'customer_1' },
        { resolveExactOpeningBalance },
      ),
    ).resolves.toMatchObject({ materialized: 1 });
    expect(resolveExactOpeningBalance).toHaveBeenCalledWith(
      expect.objectContaining({
        tx: fake.transaction,
        builderId: BUILDER_ID,
        ruleKey: RULE_KEY,
        ruleRevisionId: REVISION_ID,
        subjectCustomerId: 'customer_1',
        measuredThrough: CUTOVER_AT,
      }),
    );
    expect(transactionMocks.decimal).toHaveBeenCalledWith(fake.transaction, '12.3400');
  });

  it.each([['-1'], ['1e3'], ['100000000000000000000']])(
    'rejects noncanonical or out-of-range exact opening %s',
    async (canonical) => {
      const fake = fakeTransaction({
        readiness: [
          {
            status: 'ready',
            mode: 'exact_backfill',
            cutover_at: CUTOVER_AT,
            reconciled_through: CUTOVER_AT,
            has_reconciliation_snapshot: true,
            reconciliation_snapshot_hash: 'a'.repeat(64),
            ready_order: '101',
            ready_at: CUTOVER_AT,
          },
        ],
        revisions: [revision({ opening_source: 'exact_backfill' })],
      });
      runWith(fake);
      transactionMocks.decimal.mockResolvedValue(canonical);
      await expect(
        ensureBudgetAccountsMaterialized(
          { builderId: BUILDER_ID, customerId: 'customer_1' },
          { resolveExactOpeningBalance: async () => canonical },
        ),
      ).rejects.toThrow('NUMERIC(38,18)');
    },
  );

  it('rejects malformed database rows before inserting authority', async () => {
    const fake = fakeTransaction({ revisions: [revision({ limit_usd: 100 })] });
    runWith(fake);
    await expect(
      ensureBudgetAccountsMaterialized({ builderId: BUILDER_ID, customerId: 'customer_1' }),
    ).rejects.toThrow('invalid applicable revision');
  });

  it.each([
    [{ active_from: '2026-08-01T00:00:00Z' }],
    [{ period_start: '2026-08-01T00:00:00Z' }],
    [{ period_end: '2026-07-01T00:00:00.000Z' }],
    [{ revision: '9223372036854775807' }],
    [{ subject_customer_id: 'different_customer' }],
  ])('rejects malformed or contradictory applicable revision facts %#', async (overrides) => {
    const fake = fakeTransaction({ revisions: [revision(overrides)] });
    runWith(fake);
    await expect(
      ensureBudgetAccountsMaterialized({ builderId: BUILDER_ID, customerId: 'customer_1' }),
    ).rejects.toThrow();
    expect(fake.statements.some((statement) => statement.includes('WITH input'))).toBe(false);
  });

  it('rejects duplicate active rule identities before inserting any account', async () => {
    const fake = fakeTransaction({
      revisions: [revision(), revision({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' })],
    });
    runWith(fake);
    await expect(
      ensureBudgetAccountsMaterialized({ builderId: BUILDER_ID, customerId: 'customer_1' }),
    ).rejects.toThrow('duplicate active rule identities');
    expect(fake.statements.some((statement) => statement.includes('WITH input'))).toBe(false);
  });

  it('provides the reservation-shaped void adapter', async () => {
    const fake = fakeTransaction();
    runWith(fake);
    const materialize = createBudgetAccountMaterializer();
    await expect(
      materialize({ builderId: BUILDER_ID, customerId: 'customer_1' }),
    ).resolves.toBeUndefined();
  });
});
