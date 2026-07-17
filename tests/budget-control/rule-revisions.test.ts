import type { TransactionSql } from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const transactionMocks = vi.hoisted(() => ({ withBuilder: vi.fn() }));

vi.mock('../../src/lib/budget-control/transaction.js', () => ({
  withBudgetBuilderTransaction: transactionMocks.withBuilder,
}));

const {
  BudgetRuleConfigurationError,
  BudgetRuleStructuralChangeError,
  BudgetRuleTerminalError,
  reconcileBudgetRuleRevisionInTransaction,
  terminalizeBudgetRuleDeletionInTransaction,
  withBudgetRuleRevisionMutation,
} = await import('../../src/lib/budget-control/rule-revisions.js');

const BUILDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RULE_KEY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REVISION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SUCCESSOR_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

interface FakeOptions {
  mutable?: unknown[][];
  revisions?: unknown[][];
  retirements?: unknown[][];
  inserts?: unknown[][];
}

function fakeTransaction(options: FakeOptions = {}) {
  const statements: string[] = [];
  const mutable = [...(options.mutable ?? [[]])];
  const revisions = [...(options.revisions ?? [[]])];
  const retirements = [...(options.retirements ?? [])];
  const inserts = [...(options.inserts ?? [])];
  const transaction = vi.fn(async (strings: TemplateStringsArray) => {
    const statement = strings.join('?');
    statements.push(statement);
    if (statement.includes('FROM public.rules rule')) return mutable.shift() ?? [];
    if (
      statement.includes('FROM public.budget_rule_revisions') &&
      statement.includes('ORDER BY revision DESC')
    ) {
      return revisions.shift() ?? [];
    }
    if (statement.includes('UPDATE public.budget_rule_revisions')) {
      return retirements.shift() ?? [];
    }
    if (statement.includes('INSERT INTO public.budget_rule_revisions')) {
      return inserts.shift() ?? [];
    }
    return [];
  }) as unknown as TransactionSql;
  transaction.json = ((value: unknown) => value) as TransactionSql['json'];
  return { transaction, statements };
}

function mutable(overrides: Record<string, unknown> = {}) {
  return {
    id: RULE_KEY,
    builder_id: BUILDER_ID,
    type: 'budget_limit',
    enforcement: 'pre_call',
    enabled: true,
    status: 'active',
    customer_id: null,
    scope: 'pooled',
    period: 'month',
    ledger_enforcement: 'hard_stop',
    limit_usd: '100',
    config_valid: true,
    ...overrides,
  };
}

function revision(overrides: Record<string, unknown> = {}) {
  return {
    id: REVISION_ID,
    revision: '0',
    scope: 'pooled',
    target_customer_id: null,
    period: 'month',
    enforcement: 'hard_stop',
    limit_usd: '100',
    retired_at: null,
    retirement_reason: null,
    ...overrides,
  };
}

describe('authoritative budget rule revisions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ignores a new non-budget rule but rejects changing an authoritative identity type', async () => {
    const nonBudget = mutable({ type: 'model_routing' });
    await expect(
      reconcileBudgetRuleRevisionInTransaction(
        fakeTransaction({ mutable: [[nonBudget]], revisions: [[]] }).transaction,
        BUILDER_ID,
        RULE_KEY,
      ),
    ).resolves.toEqual({
      action: 'not_applicable',
      rule_key: RULE_KEY,
      revision_id: null,
      revision: null,
    });

    await expect(
      reconcileBudgetRuleRevisionInTransaction(
        fakeTransaction({ mutable: [[nonBudget]], revisions: [[revision()]] }).transaction,
        BUILDER_ID,
        RULE_KEY,
      ),
    ).rejects.toBeInstanceOf(BudgetRuleStructuralChangeError);
  });

  it('creates the first immutable revision for an eligible mutable rule', async () => {
    const fake = fakeTransaction({
      mutable: [[mutable()]],
      revisions: [[]],
      inserts: [[{ id: REVISION_ID, revision: '0' }]],
    });
    await expect(
      reconcileBudgetRuleRevisionInTransaction(fake.transaction, BUILDER_ID, RULE_KEY),
    ).resolves.toEqual({
      action: 'created',
      rule_key: RULE_KEY,
      revision_id: REVISION_ID,
      revision: '0',
    });
    const mutableRead = fake.statements.findIndex((statement) =>
      statement.includes('FROM public.rules rule'),
    );
    const revisionRead = fake.statements.findIndex((statement) =>
      statement.includes('ORDER BY revision DESC'),
    );
    expect(mutableRead).toBeLessThan(revisionRead);
  });

  it('returns unchanged without writing when policy values are identical', async () => {
    const fake = fakeTransaction({ mutable: [[mutable()]], revisions: [[revision()]] });
    await expect(
      reconcileBudgetRuleRevisionInTransaction(fake.transaction, BUILDER_ID, RULE_KEY),
    ).resolves.toMatchObject({ action: 'unchanged', revision_id: REVISION_ID });
    expect(fake.statements.some((statement) => statement.startsWith('\n    UPDATE'))).toBe(false);
  });

  it('retires and creates an immediate successor when limit or enforcement changes', async () => {
    const fake = fakeTransaction({
      mutable: [[mutable({ limit_usd: '125', ledger_enforcement: 'advisory' })]],
      revisions: [[revision()]],
      retirements: [[{ id: REVISION_ID }]],
      inserts: [[{ id: SUCCESSOR_ID, revision: '1' }]],
    });
    await expect(
      reconcileBudgetRuleRevisionInTransaction(fake.transaction, BUILDER_ID, RULE_KEY),
    ).resolves.toEqual({
      action: 'superseded',
      rule_key: RULE_KEY,
      revision_id: SUCCESSOR_ID,
      revision: '1',
    });
    expect(fake.statements.find((statement) => statement.includes('UPDATE public'))).toContain(
      'retirement_reason = ?',
    );
    expect(fake.statements.some((statement) => statement.includes('INSERT INTO public'))).toBe(
      true,
    );
  });

  it('retires an active revision when the mutable rule is disabled or demoted', async () => {
    const fake = fakeTransaction({
      mutable: [[mutable({ enabled: false })]],
      revisions: [[revision()]],
      retirements: [[{ id: REVISION_ID }]],
    });
    await expect(
      reconcileBudgetRuleRevisionInTransaction(fake.transaction, BUILDER_ID, RULE_KEY),
    ).resolves.toMatchObject({ action: 'disabled', revision_id: REVISION_ID });
  });

  it('does not create authority for an ineligible draft and leaves a retired disable unchanged', async () => {
    const draft = fakeTransaction({
      mutable: [[mutable({ status: 'draft' })]],
      revisions: [[]],
    });
    await expect(
      reconcileBudgetRuleRevisionInTransaction(draft.transaction, BUILDER_ID, RULE_KEY),
    ).resolves.toEqual({
      action: 'not_applicable',
      rule_key: RULE_KEY,
      revision_id: null,
      revision: null,
    });
    expect(draft.statements.some((statement) => statement.includes('INSERT INTO public'))).toBe(
      false,
    );

    const disabled = fakeTransaction({
      mutable: [[mutable({ enabled: false })]],
      revisions: [
        [
          revision({
            retired_at: '2026-07-14T00:00:00.000Z',
            retirement_reason: 'disabled',
          }),
        ],
      ],
    });
    await expect(
      reconcileBudgetRuleRevisionInTransaction(disabled.transaction, BUILDER_ID, RULE_KEY),
    ).resolves.toMatchObject({ action: 'not_applicable', revision_id: REVISION_ID });
    expect(disabled.statements.some((statement) => statement.includes('UPDATE public'))).toBe(
      false,
    );
  });

  it('creates a successor when a disabled identity is re-enabled', async () => {
    const fake = fakeTransaction({
      mutable: [[mutable()]],
      revisions: [
        [
          revision({
            retired_at: '2026-07-14T00:00:00.000Z',
            retirement_reason: 'disabled',
          }),
        ],
      ],
      inserts: [[{ id: SUCCESSOR_ID, revision: '1' }]],
    });
    await expect(
      reconcileBudgetRuleRevisionInTransaction(fake.transaction, BUILDER_ID, RULE_KEY),
    ).resolves.toMatchObject({ action: 'reenabled', revision_id: SUCCESSOR_ID, revision: '1' });
  });

  it.each([
    ['scope', { scope: 'per_customer', customer_id: 'customer_1' }],
    ['target customer', { scope: 'per_customer', customer_id: 'customer_2' }],
    ['period', { period: 'day' }],
  ])('rejects a structural %s edit instead of resetting spend', async (_name, overrides) => {
    const baseRevision =
      'scope' in overrides && overrides.scope === 'per_customer'
        ? revision({ scope: 'per_customer', target_customer_id: null })
        : revision();
    const fake = fakeTransaction({ mutable: [[mutable(overrides)]], revisions: [[baseRevision]] });
    await expect(
      reconcileBudgetRuleRevisionInTransaction(fake.transaction, BUILDER_ID, RULE_KEY),
    ).rejects.toBeInstanceOf(BudgetRuleStructuralChangeError);
  });

  it('rejects malformed config before it can enter immutable authority', async () => {
    const fake = fakeTransaction({
      mutable: [[mutable({ config_valid: false, limit_usd: null })]],
      revisions: [[]],
    });
    await expect(
      reconcileBudgetRuleRevisionInTransaction(fake.transaction, BUILDER_ID, RULE_KEY),
    ).rejects.toBeInstanceOf(BudgetRuleConfigurationError);
  });

  it('rejects a missing mutable source when immutable authority already exists', async () => {
    const fake = fakeTransaction({ mutable: [[]], revisions: [[revision()]] });
    await expect(
      reconcileBudgetRuleRevisionInTransaction(fake.transaction, BUILDER_ID, RULE_KEY),
    ).rejects.toMatchObject({
      name: 'BudgetRuleConfigurationError',
      message: expect.stringContaining('mutable rule is missing'),
    });
  });

  it('rejects contradictory revision lifecycle evidence and a lost retirement update', async () => {
    const contradictory = fakeTransaction({
      mutable: [[mutable()]],
      revisions: [[revision({ retired_at: '2026-07-14T00:00:00.000Z' })]],
    });
    await expect(
      reconcileBudgetRuleRevisionInTransaction(contradictory.transaction, BUILDER_ID, RULE_KEY),
    ).rejects.toThrow('invalid lifecycle row');

    const lostRetirement = fakeTransaction({
      mutable: [[mutable({ enabled: false })]],
      revisions: [[revision()]],
      retirements: [[]],
    });
    await expect(
      reconcileBudgetRuleRevisionInTransaction(lostRetirement.transaction, BUILDER_ID, RULE_KEY),
    ).rejects.toThrow('active rule revision changed');
  });

  it('never reactivates a terminally deleted rule identity', async () => {
    const fake = fakeTransaction({
      mutable: [[mutable()]],
      revisions: [
        [
          revision({
            retired_at: '2026-07-14T00:00:00.000Z',
            retirement_reason: 'deleted',
          }),
        ],
      ],
    });
    await expect(
      reconcileBudgetRuleRevisionInTransaction(fake.transaction, BUILDER_ID, RULE_KEY),
    ).rejects.toBeInstanceOf(BudgetRuleTerminalError);
  });

  it('terminalizes an active revision exactly once', async () => {
    const fake = fakeTransaction({
      revisions: [[revision()]],
      retirements: [[{ id: REVISION_ID }]],
    });
    await expect(
      terminalizeBudgetRuleDeletionInTransaction(fake.transaction, BUILDER_ID, RULE_KEY),
    ).resolves.toMatchObject({ action: 'deleted', revision_id: REVISION_ID });
  });

  it('replays an already terminal deletion without another write', async () => {
    const fake = fakeTransaction({
      revisions: [
        [
          revision({
            retired_at: '2026-07-14T00:00:00.000Z',
            retirement_reason: 'deleted',
          }),
        ],
      ],
    });
    await expect(
      terminalizeBudgetRuleDeletionInTransaction(fake.transaction, BUILDER_ID, RULE_KEY),
    ).resolves.toMatchObject({ action: 'deleted', revision_id: REVISION_ID, revision: '0' });
    expect(fake.statements.some((statement) => statement.includes('UPDATE public'))).toBe(false);
    expect(fake.statements.some((statement) => statement.includes('INSERT INTO public'))).toBe(
      false,
    );
  });

  it('creates an immediately deleted tombstone after a disabled revision', async () => {
    const fake = fakeTransaction({
      revisions: [
        [
          revision({
            retired_at: '2026-07-14T00:00:00.000Z',
            retirement_reason: 'disabled',
          }),
        ],
      ],
      inserts: [[{ id: SUCCESSOR_ID, revision: '1' }]],
      retirements: [[{ id: SUCCESSOR_ID }]],
    });
    await expect(
      terminalizeBudgetRuleDeletionInTransaction(fake.transaction, BUILDER_ID, RULE_KEY),
    ).resolves.toEqual({
      action: 'deleted',
      rule_key: RULE_KEY,
      revision_id: SUCCESSOR_ID,
      revision: '1',
    });
  });

  it('runs mutable mutation and immutable reconciliation in one exclusive transaction', async () => {
    const fake = fakeTransaction({
      mutable: [[mutable()]],
      revisions: [[]],
      inserts: [[{ id: REVISION_ID, revision: '0' }]],
    });
    transactionMocks.withBuilder.mockImplementation(async (_builderId, _mode, callback) =>
      callback(fake.transaction),
    );
    const mutation = vi.fn(async () => ({ kind: 'upsert' as const, value: 'saved' }));

    await expect(withBudgetRuleRevisionMutation(BUILDER_ID, RULE_KEY, mutation)).resolves.toEqual({
      value: 'saved',
      revision: {
        action: 'created',
        rule_key: RULE_KEY,
        revision_id: REVISION_ID,
        revision: '0',
      },
    });
    expect(transactionMocks.withBuilder.mock.calls[0]?.[1]).toBe('exclusive');
    expect(mutation).toHaveBeenCalledWith(fake.transaction);
  });

  it('forwards bounded retry hooks to the exclusive transaction wrapper', async () => {
    const fake = fakeTransaction({
      mutable: [[mutable({ type: 'cost_threshold' })]],
      revisions: [[]],
    });
    transactionMocks.withBuilder.mockImplementation(async (_builderId, _mode, callback) =>
      callback(fake.transaction),
    );
    const sleep = vi.fn(async () => undefined);
    const onRetry = vi.fn();

    await withBudgetRuleRevisionMutation(
      BUILDER_ID,
      RULE_KEY,
      async () => ({ kind: 'upsert', value: 'saved' }),
      { maxAttempts: 2, sleep, onRetry },
    );

    expect(transactionMocks.withBuilder).toHaveBeenCalledWith(
      BUILDER_ID,
      'exclusive',
      expect.any(Function),
      { maxAttempts: 2, sleep, onRetry },
    );
  });

  it('rejects invalid builder and rule identities before opening a transaction', async () => {
    expect(() =>
      withBudgetRuleRevisionMutation('not-a-uuid', RULE_KEY, async () => ({
        kind: 'upsert',
        value: null,
      })),
    ).toThrow('builderId must be a UUID');
    await expect(
      reconcileBudgetRuleRevisionInTransaction(
        fakeTransaction().transaction,
        BUILDER_ID,
        'not-a-uuid',
      ),
    ).rejects.toThrow('ruleKey must be a UUID');
    expect(transactionMocks.withBuilder).not.toHaveBeenCalled();
  });

  it('rejects an undeclared mutation outcome without reconciling', async () => {
    const fake = fakeTransaction();
    transactionMocks.withBuilder.mockImplementation(async (_builderId, _mode, callback) =>
      callback(fake.transaction),
    );
    await expect(
      withBudgetRuleRevisionMutation(BUILDER_ID, RULE_KEY, async () => ({
        kind: 'invalid' as never,
        value: null,
      })),
    ).rejects.toThrow('must declare upsert or delete');
    expect(fake.statements).toEqual([]);
  });
});
