// Transaction-scoped RLS — Decision #1
// SET LOCAL auto-resets on COMMIT/ROLLBACK, no session variable leaks

import { sql as drizzleSql } from 'drizzle-orm';
import { db } from './client.js';

type DrizzleTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type { DrizzleTransaction };

/**
 * Execute a callback within a transaction with RLS context set.
 * All data access for tenant-scoped data MUST go through this function.
 * Queries outside withRLS() have no RLS context — this is intentional.
 */
export async function withRLS<T>(
  builderId: string,
  callback: (tx: DrizzleTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(drizzleSql`SELECT set_config('app.builder_id', ${builderId}, true)`);
    return callback(tx);
  });
}
