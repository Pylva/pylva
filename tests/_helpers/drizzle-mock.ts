// Reusable Drizzle fluent-chain mock for repository / route tests.
//
// Background: every repository test in this codebase mocks `withRLS`
// to call its callback with a stub `tx`, then stubs the
// `select → from → where → orderBy → limit` chain. The same setup
// was hand-rolled in 5+ test files across B4 — this helper
// consolidates the pattern.
//
// Captures the WHERE-clause arg so tests can assert SQL shape.
// Drizzle SQL objects have circular refs (PgTable → column → table)
// that defeat `JSON.stringify`; assertions should use
// `util.inspect(clause, { depth: null, breakLength: Infinity })`
// (this trap was discovered the hard way in PR #62).
//
// Usage:
//   import { createDrizzleMock } from '../_helpers/drizzle-mock';
//
//   const drizzle = createDrizzleMock();
//
//   vi.mock('../../src/lib/db/rls.js', () => ({
//     withRLS: drizzle.withRLS,
//   }));
//
//   // After importing the module under test (deferred via top-level
//   // `await import(...)` if it imports config.ts which validates env),
//   // call drizzle.setRows(...) before each test to control returns.
//
//   beforeEach(() => {
//     drizzle.handle.reset();
//     drizzle.handle.setRows([fakeRow]);
//   });
//
//   it('forwards customerId filter to WHERE', async () => {
//     await listSomething('b-1', { customerId: 'cust-x' });
//     const captured = drizzle.handle.whereCalls[0];
//     expect(inspect(captured, { depth: null })).toMatch(/cust-x/);
//   });

import { vi } from 'vitest';

export interface DrizzleMockHandle {
  /** Args passed to every `tx.<verb>().…where(<clause>)` call. */
  whereCalls: unknown[];
  /** N values passed to every `.limit(N)`. */
  limitCalls: number[];
  /** Args spread into every `.orderBy(...args)`. */
  orderByCalls: unknown[][];
  /** Set the rows the chain returns for the next call. Resets each `reset()`. */
  setRows(rows: unknown[]): void;
  /** Reset captured calls + return rows. Call in `beforeEach`. */
  reset(): void;
}

interface DrizzleMockResult {
  /** Pass to `vi.mock('../../src/lib/db/rls.js', () => ({ withRLS: drizzle.withRLS }))`. */
  withRLS: ReturnType<typeof vi.fn>;
  handle: DrizzleMockHandle;
}

export function createDrizzleMock(): DrizzleMockResult {
  let rows: unknown[] = [];
  const whereCalls: unknown[] = [];
  const limitCalls: number[] = [];
  const orderByCalls: unknown[][] = [];

  const handle: DrizzleMockHandle = {
    whereCalls,
    limitCalls,
    orderByCalls,
    setRows(next) {
      rows = next;
    },
    reset() {
      rows = [];
      whereCalls.length = 0;
      limitCalls.length = 0;
      orderByCalls.length = 0;
    },
  };

  const buildLeaf = (): unknown => ({
    limit: (n: number) => {
      limitCalls.push(n);
      return Promise.resolve(rows);
    },
    orderBy: (...args: unknown[]) => {
      orderByCalls.push(args);
      return {
        limit: (n: number) => {
          limitCalls.push(n);
          return Promise.resolve(rows);
        },
      };
    },
    returning: () => Promise.resolve(rows),
  });

  const buildAfterFrom = (): unknown => ({
    where: (clause: unknown) => {
      whereCalls.push(clause);
      return buildLeaf();
    },
  });

  const buildTx = (): unknown => ({
    select: () => ({ from: () => buildAfterFrom() }),
    update: () => ({
      set: () => ({
        where: (clause: unknown) => {
          whereCalls.push(clause);
          return { returning: () => Promise.resolve(rows) };
        },
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({ returning: () => Promise.resolve(rows) }),
        returning: () => Promise.resolve(rows),
      }),
    }),
    delete: () => ({
      where: (clause: unknown) => {
        whereCalls.push(clause);
        return { returning: () => Promise.resolve(rows) };
      },
    }),
  });

  const withRLS = vi.fn(async (_builderId: string, cb: (tx: unknown) => Promise<unknown>) => {
    return cb(buildTx());
  });

  return { withRLS, handle };
}

// Serialize a Drizzle SQL clause (or any mock-call arg) for substring assertions.
// JSON.stringify with a function-stripping replacer — NOT util.inspect — is enough
// here because we only match SQL text fragments.
export function sqlText(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === 'function' ? undefined : item));
}

// Standard tx.execute mock for code paths that re-read the builder tier inside a
// locked transaction (advisory-locks.getBuilderTierForShare). Answers the
// `SELECT tier ... FOR SHARE` read from the provided getter; every other
// statement (e.g. pg_advisory_xact_lock) resolves to no rows.
export function forShareTierTxExecuteImpl(
  getFreshTier: () => string | null,
): (query: unknown) => Promise<Array<{ tier: string }>> {
  return async (query: unknown) => {
    if (sqlText(query).includes('FOR SHARE')) {
      const tier = getFreshTier();
      return tier === null ? [] : [{ tier }];
    }
    return [];
  };
}
