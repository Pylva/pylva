import { createHash, randomUUID } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Every exercised path injects the real scratch postgres.js client. Isolate the
// application singleton so this focused test does not load unrelated AWS
// credential modules in sparse CI/worktree dependency installations.
vi.mock('../../src/lib/db/client.js', () => ({ sql: {} }));

import {
  acquireBudgetBuilderExclusiveLock,
  acquireBudgetBuilderSharedLock,
  acquireBudgetOperationLock,
  pgCanonicalDecimalText,
  pgCanonicalJsonbSha256,
  pgCanonicalNowText,
  pgCanonicalTimestampText,
  withBudgetControlTransaction,
} from '../../src/lib/budget-control/transaction.js';
import { applyMigrationsThrough, createScratchDb, type ScratchDb } from '../helpers/scratch-db.js';

const MIGRATION_FILENAME = '050_authoritative_budget_control_ledger.sql';
const WAIT_PROBE_MS = 100;

let scratch: ScratchDb | undefined;
let firstClient: Sql | undefined;
let secondClient: Sql | undefined;

function db(): ScratchDb {
  if (!scratch) throw new Error('authoritative budget transaction scratch database is not ready');
  return scratch;
}

function first(): Sql {
  if (!firstClient) throw new Error('first lock client is not ready');
  return firstClient;
}

function second(): Sql {
  if (!secondClient) throw new Error('second lock client is not ready');
  return secondClient;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function expectStillWaiting(promise: Promise<unknown>): Promise<void> {
  const outcome = await Promise.race([
    promise.then(
      () => 'settled' as const,
      () => 'settled' as const,
    ),
    new Promise<'waiting'>((resolve) => {
      setTimeout(() => resolve('waiting'), WAIT_PROBE_MS);
    }),
  ]);
  expect(outcome).toBe('waiting');
}

async function migratedScratch(): Promise<ScratchDb> {
  const candidate = await createScratchDb({ prefix: 'authoritative_budget_transaction' });
  try {
    await applyMigrationsThrough(candidate, MIGRATION_FILENAME);
    return candidate;
  } catch (error) {
    await candidate.drop();
    throw error;
  }
}

beforeAll(async () => {
  scratch = await migratedScratch();
  firstClient = postgres(scratch.url, { max: 1, onnotice: () => undefined });
  secondClient = postgres(scratch.url, { max: 1, onnotice: () => undefined });
});

afterAll(async () => {
  await Promise.allSettled([firstClient?.end(), secondClient?.end()].filter(Boolean));
  await scratch?.drop();
});

describe('authoritative budget transaction foundation against PostgreSQL', () => {
  it('uses READ COMMITTED and resets the transaction-local builder context', async () => {
    const builderId = randomUUID();

    const inside = await withBudgetControlTransaction(
      builderId,
      async (transaction) => {
        const [row] = await transaction<{ builder_id: string; isolation: string }[]>`
          SELECT current_setting('app.builder_id') AS builder_id,
                 current_setting('transaction_isolation') AS isolation
        `;
        return row!;
      },
      { client: db().sql, maxAttempts: 1 },
    );

    expect(inside).toEqual({ builder_id: builderId, isolation: 'read committed' });
    const [outside] = await db().sql<{ builder_id: string | null }[]>`
      SELECT current_setting('app.builder_id', TRUE) AS builder_id
    `;
    expect(outside?.builder_id ?? '').toBe('');
  });

  it('allows concurrent shared builder locks while an exclusive lock waits for release', async () => {
    const builderId = randomUUID();
    const holderAcquired = deferred();
    const releaseHolder = deferred();
    const exclusiveAttempted = deferred();
    let holder: Promise<unknown> | undefined;
    let exclusive: Promise<unknown> | undefined;

    try {
      holder = withBudgetControlTransaction(
        builderId,
        async (transaction) => {
          await acquireBudgetBuilderSharedLock(transaction, builderId);
          holderAcquired.resolve();
          await releaseHolder.promise;
        },
        { client: first(), maxAttempts: 1 },
      );
      await holderAcquired.promise;

      await expect(
        withBudgetControlTransaction(
          builderId,
          async (transaction) => {
            await acquireBudgetBuilderSharedLock(transaction, builderId);
            return 'shared-compatible';
          },
          { client: second(), maxAttempts: 1 },
        ),
      ).resolves.toBe('shared-compatible');

      exclusive = withBudgetControlTransaction(
        builderId,
        async (transaction) => {
          exclusiveAttempted.resolve();
          await acquireBudgetBuilderExclusiveLock(transaction, builderId);
          return 'exclusive-acquired';
        },
        { client: second(), maxAttempts: 1 },
      );
      await exclusiveAttempted.promise;
      await expectStillWaiting(exclusive);

      releaseHolder.resolve();
      await expect(exclusive).resolves.toBe('exclusive-acquired');
      await expect(holder).resolves.toBeUndefined();
    } finally {
      releaseHolder.resolve();
      await Promise.allSettled([holder, exclusive].filter(Boolean) as Promise<unknown>[]);
    }
  });

  it('serializes the same builder operation but not a different operation', async () => {
    const builderId = randomUUID();
    const operationId = randomUUID();
    const differentOperationId = randomUUID();
    const holderAcquired = deferred();
    const releaseHolder = deferred();
    const waiterAttempted = deferred();
    let holder: Promise<unknown> | undefined;
    let waiter: Promise<unknown> | undefined;

    try {
      holder = withBudgetControlTransaction(
        builderId,
        async (transaction) => {
          await acquireBudgetOperationLock(transaction, builderId, operationId);
          holderAcquired.resolve();
          await releaseHolder.promise;
        },
        { client: first(), maxAttempts: 1 },
      );
      await holderAcquired.promise;

      await expect(
        withBudgetControlTransaction(
          builderId,
          async (transaction) => {
            await acquireBudgetOperationLock(transaction, builderId, differentOperationId);
            return 'different-operation';
          },
          { client: db().sql, maxAttempts: 1 },
        ),
      ).resolves.toBe('different-operation');

      waiter = withBudgetControlTransaction(
        builderId,
        async (transaction) => {
          waiterAttempted.resolve();
          await acquireBudgetOperationLock(transaction, builderId, operationId);
          return 'same-operation-acquired';
        },
        { client: second(), maxAttempts: 1 },
      );
      await waiterAttempted.promise;
      await expectStillWaiting(waiter);

      releaseHolder.resolve();
      await expect(waiter).resolves.toBe('same-operation-acquired');
      await expect(holder).resolves.toBeUndefined();
    } finally {
      releaseHolder.resolve();
      await Promise.allSettled([holder, waiter].filter(Boolean) as Promise<unknown>[]);
    }
  });

  it('returns PostgreSQL-canonical JSONB hash, decimal, and timestamp values', async () => {
    const builderId = randomUUID();
    const jsonValue = { z: 1, a: ['value', true] };

    const canonical = await withBudgetControlTransaction(
      builderId,
      async (transaction) => {
        const [jsonText] = await transaction<{ value: string }[]>`
          SELECT ${transaction.json(jsonValue)}::JSONB::TEXT AS value
        `;
        return {
          jsonText: jsonText!.value,
          hash: await pgCanonicalJsonbSha256(transaction, jsonValue),
          decimal: await pgCanonicalDecimalText(transaction, '12345678901234567890.123400'),
          timestamp: await pgCanonicalTimestampText(
            transaction,
            '2026-07-14T12:08:07.654321+03:00',
          ),
          now: await pgCanonicalNowText(transaction),
        };
      },
      { client: db().sql, maxAttempts: 1 },
    );

    expect(canonical.hash).toBe(
      createHash('sha256').update(canonical.jsonText, 'utf8').digest('hex'),
    );
    expect(canonical.decimal).toBe('12345678901234567890.1234');
    expect(canonical.timestamp).toBe('2026-07-14T09:08:07.654Z');
    expect(canonical.now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
