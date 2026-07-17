import type postgres from 'postgres';
import type { Sql, TransactionSql } from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type BeginCallback = (transaction: TransactionSql) => unknown;

const mocks = vi.hoisted(() => ({
  begin: vi.fn<(options: string, callback: BeginCallback) => Promise<unknown>>(),
  getReadyBudgetControlSql: vi.fn(),
}));

vi.mock('../../src/lib/db/client.js', () => ({
  sql: { begin: mocks.begin },
}));

vi.mock('../../src/lib/budget-control/runtime-posture.js', () => ({
  getReadyBudgetControlSql: mocks.getReadyBudgetControlSql,
}));

import {
  BUDGET_BUILDER_LOCK_SEED,
  BUDGET_OPERATION_LOCK_SEED,
  BUDGET_TRANSACTION_RETRY_DELAYS_MS,
  MAX_BUDGET_TRANSACTION_MAX_ATTEMPTS,
  acquireBudgetBuilderExclusiveLock,
  acquireBudgetBuilderLock,
  acquireBudgetBuilderSharedLock,
  acquireBudgetOperationLock,
  budgetTransactionRetryDelayMs,
  classifyBudgetTransactionError,
  pgCanonicalDecimalText,
  pgCanonicalJsonbSha256,
  pgCanonicalNowText,
  pgCanonicalTimestampText,
  pgJsonbParameterText,
  withBudgetBuilderTransaction,
  withBudgetControlTransaction,
} from '../../src/lib/budget-control/transaction.js';

const BUILDER_ID = '00000000-0000-4000-8000-000000000001';
const OPERATION_ID = '00000000-0000-4000-8000-000000000002';

interface CapturedQuery {
  text: string;
  values: readonly unknown[];
}

type QueryResponder = (
  query: CapturedQuery,
) => readonly Record<string, unknown>[] | Promise<readonly Record<string, unknown>[]>;

function createTransaction(responder: QueryResponder = () => []): {
  transaction: TransactionSql;
  queries: CapturedQuery[];
  json: ReturnType<typeof vi.fn>;
} {
  const queries: CapturedQuery[] = [];
  const json = vi.fn((value: postgres.JSONValue) => ({ type: 'json', value }));
  const tag = (
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<readonly Record<string, unknown>[]> => {
    const query = {
      text: strings.join('?').replace(/\s+/g, ' ').trim(),
      values,
    };
    queries.push(query);
    return Promise.resolve(responder(query));
  };
  const transaction = Object.assign(tag, { json }) as unknown as TransactionSql;
  return { transaction, queries, json };
}

function pgError(code: string, message = 'database failure'): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function useMockClient(): Sql {
  return { begin: mocks.begin } as unknown as Sql;
}

beforeEach(() => {
  mocks.begin.mockReset();
  mocks.getReadyBudgetControlSql.mockReset();
  mocks.getReadyBudgetControlSql.mockResolvedValue({ begin: mocks.begin } as unknown as Sql);
});

describe('budget transaction retry classification', () => {
  it.each([
    ['40001', 'serialization_failure'],
    ['40P01', 'deadlock_detected'],
  ] as const)('retries SQLSTATE %s as %s', (code, reason) => {
    expect(classifyBudgetTransactionError(pgError(code))).toEqual({
      retryable: true,
      reason,
      code,
    });
  });

  it.each([
    'reserved lifecycle requires matching allocation settlement',
    'denial requires exactly one matching deciding allocation',
    'shadow decision requires matching shadow allocations',
    'no_applicable_budget requires an empty applicable global rule revision set',
  ])('retries only the documented stale closure: %s', (message) => {
    expect(classifyBudgetTransactionError(pgError('23514', message))).toEqual({
      retryable: true,
      reason: 'stale_allocation_closure',
      code: '23514',
    });
  });

  it('finds the PostgreSQL code and exact closure message on a wrapped cause', () => {
    const cause = pgError('23514', 'reserved lifecycle requires matching allocation settlement');
    const wrapped = new Error('transaction failed', { cause });

    expect(classifyBudgetTransactionError(wrapped)).toEqual({
      retryable: true,
      reason: 'stale_allocation_closure',
      code: '23514',
    });
  });

  it('never combines a direct SQLSTATE with a different cause-layer message', () => {
    const staleMessage = 'reserved lifecycle requires matching allocation settlement';
    const outerCodeOnly = Object.assign(new Error('another check failed'), {
      code: '23514',
      cause: new Error(staleMessage),
    });
    const outerMessageOnly = new Error(staleMessage, {
      cause: pgError('23514', 'another check failed'),
    });

    expect(classifyBudgetTransactionError(outerCodeOnly)).toEqual({
      retryable: false,
      reason: null,
      code: '23514',
    });
    expect(classifyBudgetTransactionError(outerMessageOnly)).toEqual({
      retryable: false,
      reason: null,
      code: '23514',
    });
  });

  it('does not blanket-retry constraint violations or message lookalikes', () => {
    expect(classifyBudgetTransactionError(pgError('23514', 'another check failed'))).toEqual({
      retryable: false,
      reason: null,
      code: '23514',
    });
    expect(
      classifyBudgetTransactionError(
        pgError('23514', 'reserved lifecycle requires matching allocation settlement (extra)'),
      ),
    ).toEqual({ retryable: false, reason: null, code: '23514' });
    expect(
      classifyBudgetTransactionError(
        pgError('23503', 'reserved lifecycle requires matching allocation settlement'),
      ),
    ).toEqual({ retryable: false, reason: null, code: '23503' });
  });

  it('retries the exact lease-expired closure but not generic query cancellation', () => {
    expect(
      classifyBudgetTransactionError(
        pgError('57014', 'reservation lease expired before authorization could commit'),
      ),
    ).toEqual({
      retryable: true,
      reason: 'authorization_lease_expired',
      code: '57014',
    });
    expect(classifyBudgetTransactionError(pgError('57014', 'canceling statement'))).toEqual({
      retryable: false,
      reason: null,
      code: '57014',
    });
  });

  it('treats errors without a PostgreSQL code as terminal', () => {
    expect(classifyBudgetTransactionError(new Error('application bug'))).toEqual({
      retryable: false,
      reason: null,
      code: null,
    });
  });
});

describe('withBudgetControlTransaction', () => {
  it('uses explicit READ COMMITTED, sets local tenant context, and returns the callback value', async () => {
    const fake = createTransaction();
    mocks.begin.mockImplementation(async (_options, callback) => callback(fake.transaction));
    const observations: string[] = [];

    const value = await withBudgetControlTransaction(
      BUILDER_ID,
      (_transaction, context) => {
        observations.push('callback');
        expect(context).toEqual({ attempt: 1, maxAttempts: 3 });
        expect(fake.queries).toHaveLength(1);
        return { ok: true };
      },
      { client: useMockClient() },
    );

    expect(value).toEqual({ ok: true });
    expect(observations).toEqual(['callback']);
    expect(mocks.begin).toHaveBeenCalledTimes(1);
    expect(mocks.begin.mock.calls[0]?.[0]).toBe('isolation level read committed');
    expect(fake.queries[0]?.text).toContain('pg_catalog.set_config');
    expect(fake.queries[0]?.text).toContain("'app.builder_id', ?::UUID::TEXT, TRUE");
    expect(fake.queries[0]?.values).toEqual([BUILDER_ID]);
  });

  it('uses the attested dedicated raw client by default', async () => {
    const fake = createTransaction();
    mocks.begin.mockImplementation(async (_options, callback) => callback(fake.transaction));

    await expect(withBudgetControlTransaction(BUILDER_ID, () => 'default-client')).resolves.toBe(
      'default-client',
    );
    expect(mocks.getReadyBudgetControlSql).toHaveBeenCalledTimes(1);
    expect(mocks.begin).toHaveBeenCalledTimes(1);
  });

  it('replays the complete body after commit-time serialization and deadlock failures', async () => {
    const transactions = [createTransaction(), createTransaction(), createTransaction()];
    const failures = [pgError('40001'), pgError('40P01')];
    const bodyAttempts: number[] = [];
    const sleep = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue(undefined);
    const onRetry = vi.fn();
    let beginAttempt = 0;
    mocks.begin.mockImplementation(async (_options, callback) => {
      const index = beginAttempt;
      beginAttempt += 1;
      const result = await callback(transactions[index]!.transaction);
      const failure = failures[index];
      if (failure) throw failure;
      return result;
    });

    await expect(
      withBudgetControlTransaction(
        BUILDER_ID,
        (_transaction, context) => {
          bodyAttempts.push(context.attempt);
          return 'committed';
        },
        { client: useMockClient(), sleep, onRetry },
      ),
    ).resolves.toBe('committed');

    expect(bodyAttempts).toEqual([1, 2, 3]);
    expect(transactions.map(({ queries }) => queries.length)).toEqual([1, 1, 1]);
    expect(sleep.mock.calls).toEqual([[5], [20]]);
    expect(onRetry.mock.calls.map(([event]) => event)).toEqual([
      {
        attempt: 1,
        nextAttempt: 2,
        maxAttempts: 3,
        delayMs: 5,
        code: '40001',
        reason: 'serialization_failure',
      },
      {
        attempt: 2,
        nextAttempt: 3,
        maxAttempts: 3,
        delayMs: 20,
        code: '40P01',
        reason: 'deadlock_detected',
      },
    ]);
  });

  it('retries an exact stale closure raised when the transaction commits', async () => {
    const fake = createTransaction();
    const stale = pgError('23514', 'reserved lifecycle requires matching allocation settlement');
    const sleep = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue(undefined);
    let attempt = 0;
    mocks.begin.mockImplementation(async (_options, callback) => {
      const result = await callback(fake.transaction);
      attempt += 1;
      if (attempt === 1) throw stale;
      return result;
    });

    await expect(
      withBudgetControlTransaction(BUILDER_ID, () => 'fresh', {
        client: useMockClient(),
        sleep,
      }),
    ).resolves.toBe('fresh');
    expect(mocks.begin).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(5);
  });

  it('never retries an unrelated check constraint', async () => {
    const failure = pgError('23514', 'allocation amount does not match reservation request');
    const sleep = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue(undefined);
    mocks.begin.mockRejectedValue(failure);

    await expect(
      withBudgetControlTransaction(BUILDER_ID, () => 'unreachable', {
        client: useMockClient(),
        sleep,
      }),
    ).rejects.toBe(failure);
    expect(mocks.begin).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('stops at the configured cap and rethrows the original database error', async () => {
    const failure = pgError('40001');
    const sleep = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue(undefined);
    mocks.begin.mockRejectedValue(failure);

    await expect(
      withBudgetControlTransaction(BUILDER_ID, () => 'unreachable', {
        client: useMockClient(),
        maxAttempts: 3,
        sleep,
      }),
    ).rejects.toBe(failure);
    expect(mocks.begin).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[5], [20]]);
  });

  it('does not sleep when the cap is one attempt', async () => {
    const failure = pgError('40P01');
    const sleep = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue(undefined);
    mocks.begin.mockRejectedValue(failure);

    await expect(
      withBudgetControlTransaction(BUILDER_ID, () => 'unreachable', {
        client: useMockClient(),
        maxAttempts: 1,
        sleep,
      }),
    ).rejects.toBe(failure);
    expect(mocks.begin).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([0, 1.5, 6, Number.NaN])(
    'rejects invalid maxAttempts=%s before opening a transaction',
    async (maxAttempts) => {
      await expect(
        withBudgetControlTransaction(BUILDER_ID, () => undefined, {
          client: useMockClient(),
          maxAttempts,
        }),
      ).rejects.toThrow(/maxAttempts must be an integer between 1 and 5/);
      expect(mocks.begin).not.toHaveBeenCalled();
    },
  );

  it('rejects a blank tenant before opening a transaction', async () => {
    await expect(
      withBudgetControlTransaction('  ', () => undefined, { client: useMockClient() }),
    ).rejects.toThrow(/builderId must not be blank/);
    expect(mocks.begin).not.toHaveBeenCalled();
  });
});

describe('deterministic retry delays', () => {
  it('maps every possible failed attempt to the fixed schedule', () => {
    expect(
      Array.from({ length: MAX_BUDGET_TRANSACTION_MAX_ATTEMPTS - 1 }, (_, index) =>
        budgetTransactionRetryDelayMs(index + 1),
      ),
    ).toEqual([...BUDGET_TRANSACTION_RETRY_DELAYS_MS]);
  });

  it.each([0, 1.5, 5, Number.NaN])('rejects invalid failedAttempt=%s', (attempt) => {
    expect(() => budgetTransactionRetryDelayMs(attempt)).toThrow(
      /failedAttempt must be an integer between 1 and 4/,
    );
  });
});

describe('budget advisory locks', () => {
  it('uses the frozen migration seed for the shared builder lock', async () => {
    const fake = createTransaction();
    await acquireBudgetBuilderSharedLock(fake.transaction, BUILDER_ID);

    expect(fake.queries[0]?.text).toContain('pg_advisory_xact_lock_shared');
    expect(fake.queries[0]?.text).toContain('pg_catalog.hashtextextended');
    expect(fake.queries[0]?.text).toContain('?::UUID::TEXT');
    expect(fake.queries[0]?.values).toEqual([BUILDER_ID, BUDGET_BUILDER_LOCK_SEED]);
    expect(BUDGET_BUILDER_LOCK_SEED).toBe(50_620_260_714);
  });

  it('uses the same migration seed for the exclusive builder lock', async () => {
    const fake = createTransaction();
    await acquireBudgetBuilderExclusiveLock(fake.transaction, BUILDER_ID);

    expect(fake.queries[0]?.text).toContain('pg_advisory_xact_lock(');
    expect(fake.queries[0]?.text).not.toContain('pg_advisory_xact_lock_shared');
    expect(fake.queries[0]?.values).toEqual([BUILDER_ID, BUDGET_BUILDER_LOCK_SEED]);
  });

  it('dispatches the explicit builder lock mode', async () => {
    const shared = createTransaction();
    const exclusive = createTransaction();

    await acquireBudgetBuilderLock(shared.transaction, BUILDER_ID, 'shared');
    await acquireBudgetBuilderLock(exclusive.transaction, BUILDER_ID, 'exclusive');

    expect(shared.queries[0]?.text).toContain('pg_advisory_xact_lock_shared');
    expect(exclusive.queries[0]?.text).toContain('pg_advisory_xact_lock(');
  });

  it('rejects an unsupported builder lock mode without silently taking a lock', async () => {
    const fake = createTransaction();

    await expect(
      acquireBudgetBuilderLock(fake.transaction, BUILDER_ID, 'invalid' as never),
    ).rejects.toThrow(/unsupported budget builder lock mode/);
    expect(fake.queries).toEqual([]);
  });

  it('sets tenant context and acquires the lock before invoking a locked callback', async () => {
    const fake = createTransaction();
    mocks.begin.mockImplementation(async (_options, callback) => callback(fake.transaction));

    await withBudgetBuilderTransaction(
      BUILDER_ID,
      'shared',
      () => {
        expect(fake.queries).toHaveLength(2);
        return 'locked';
      },
      { client: useMockClient() },
    );

    expect(fake.queries[0]?.text).toContain('set_config');
    expect(fake.queries[1]?.text).toContain('pg_advisory_xact_lock_shared');
  });

  it('uses a builder-scoped, domain-separated operation lock', async () => {
    const fake = createTransaction();
    await acquireBudgetOperationLock(fake.transaction, BUILDER_ID, OPERATION_ID);

    expect(fake.queries[0]?.text).toContain("'pylva-budget-operation:'");
    expect(fake.queries[0]?.text).toContain('pg_catalog.concat');
    expect(fake.queries[0]?.text).toContain('pg_advisory_xact_lock(');
    expect(fake.queries[0]?.values).toEqual([BUILDER_ID, OPERATION_ID, BUDGET_OPERATION_LOCK_SEED]);
    expect(BUDGET_OPERATION_LOCK_SEED).not.toBe(BUDGET_BUILDER_LOCK_SEED);
  });

  it('rejects blank lock identities without issuing SQL', async () => {
    const fake = createTransaction();

    await expect(acquireBudgetBuilderSharedLock(fake.transaction, ' ')).rejects.toThrow(
      /builderId must not be blank/,
    );
    await expect(acquireBudgetOperationLock(fake.transaction, BUILDER_ID, '')).rejects.toThrow(
      /operationId must not be blank/,
    );
    expect(fake.queries).toEqual([]);
  });
});

describe('PostgreSQL canonical value helpers', () => {
  it('binds strict JSON text independently of mutable postgres.js JSON serializers', async () => {
    const hash = 'a'.repeat(64);
    const fake = createTransaction(() => [{ value: hash }]);
    const value = { z: 1, a: ['x', true] };

    await expect(pgCanonicalJsonbSha256(fake.transaction, value)).resolves.toBe(hash);
    expect(fake.json).not.toHaveBeenCalled();
    expect(fake.queries[0]?.text).toContain('public.pylva_budget_jsonb_sha256');
    expect(fake.queries[0]?.text).toContain('?::TEXT::JSONB');
    expect(fake.queries[0]?.values[0]).toBe('{"z":1,"a":["x",true]}');
  });

  it('serializes null-prototype objects and dense arrays as strict JSON text', () => {
    const value = Object.assign(Object.create(null) as Record<string, unknown>, {
      nested: [null, false, 1.25, 'value'],
    });

    expect(pgJsonbParameterText(value as postgres.JSONValue)).toBe(
      '{"nested":[null,false,1.25,"value"]}',
    );
  });

  it.each([
    ['undefined', undefined],
    ['BigInt', 1n],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['function', () => undefined],
    ['symbol', Symbol('not-json')],
    ['non-plain object', new Date('2026-07-14T00:00:00.000Z')],
  ])('rejects unsupported strict JSON value %s', (_label, value) => {
    expect(() => pgJsonbParameterText(value as postgres.JSONValue)).toThrow(TypeError);
  });

  it('rejects cyclic, sparse, accessor, and symbol-keyed structures', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const sparse = new Array<unknown>(1);
    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => 'secret',
    });
    const symbolKeyed = { value: 'safe', [Symbol('hidden')]: 'not-json' };

    for (const value of [cyclic, sparse, accessor, symbolKeyed]) {
      expect(() => pgJsonbParameterText(value as postgres.JSONValue)).toThrow(TypeError);
    }
  });

  it('passes decimal text directly to PostgreSQL NUMERIC canonicalization', async () => {
    const fake = createTransaction(() => [{ value: '12345678901234567890.1234' }]);

    await expect(
      pgCanonicalDecimalText(fake.transaction, '12345678901234567890.123400'),
    ).resolves.toBe('12345678901234567890.1234');
    expect(fake.queries[0]?.text).toContain('public.pylva_budget_decimal_text');
    expect(fake.queries[0]?.text).toContain('?::NUMERIC');
    expect(fake.queries[0]?.values).toEqual(['12345678901234567890.123400']);
  });

  it.each([
    ['2026-07-14T09:08:07.654321Z', '2026-07-14T09:08:07.654Z'],
    [new Date('2026-07-14T09:08:07.654Z'), '2026-07-14T09:08:07.654Z'],
  ])('canonicalizes timestamp input %s in PostgreSQL', async (input, canonical) => {
    const fake = createTransaction(() => [{ value: canonical }]);

    await expect(pgCanonicalTimestampText(fake.transaction, input)).resolves.toBe(canonical);
    expect(fake.queries[0]?.text).toContain('public.pylva_budget_timestamp_text');
    expect(fake.queries[0]?.text).toContain('?::TIMESTAMPTZ');
    expect(fake.queries[0]?.values).toEqual([input]);
  });

  it('samples the server clock once and canonicalizes it in PostgreSQL', async () => {
    const canonical = '2026-07-14T09:08:07.654Z';
    const fake = createTransaction(() => [{ value: canonical }]);

    await expect(pgCanonicalNowText(fake.transaction)).resolves.toBe(canonical);
    expect(fake.queries[0]?.text).toContain('pg_catalog.date_trunc');
    expect(fake.queries[0]?.text).toContain('pg_catalog.clock_timestamp()');
    expect(fake.queries[0]?.values).toEqual([]);
  });

  it('fails closed when a canonical PostgreSQL helper returns no text row', async () => {
    const fake = createTransaction(() => []);

    await expect(pgCanonicalDecimalText(fake.transaction, '1')).rejects.toThrow(
      /pylva_budget_decimal_text returned no canonical text value/,
    );
  });

  it('propagates PostgreSQL canonicalization failures unchanged', async () => {
    const failure = pgError('22P02', 'invalid input syntax for type numeric');
    const fake = createTransaction(() => Promise.reject(failure));

    await expect(pgCanonicalDecimalText(fake.transaction, 'not-a-decimal')).rejects.toBe(failure);
  });
});
