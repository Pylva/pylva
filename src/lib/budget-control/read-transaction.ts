import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { TransactionSql } from 'postgres';
import { withBudgetControlTransaction, type BudgetTransactionOptions } from './transaction.js';

/** Minimal Drizzle surface exposed to authoritative read models. */
export interface BudgetControlReadTransaction {
  execute(query: SQL): Promise<unknown>;
}

const dialect = new PgDialect();

/**
 * Run a tenant-scoped read on the dedicated authoritative-control pool.
 *
 * Dashboard and API reads need Drizzle's composable SQL builder, while the
 * authoritative transaction boundary intentionally owns the raw postgres.js
 * client. Wrapping the active postgres.js transaction here preserves its
 * `SET LOCAL app.builder_id` scope and keeps the dedicated pool private.
 */
export function withBudgetControlReadTransaction<T>(
  builderId: string,
  callback: (transaction: BudgetControlReadTransaction) => Promise<T>,
  options: BudgetTransactionOptions = {},
): Promise<T> {
  return withBudgetControlTransaction(
    builderId,
    async (transaction) => {
      return callback({
        execute: (query) => {
          const compiled = dialect.sqlToQuery(query);
          // PgDialect has already applied every parameter encoder. Its public
          // result type is `unknown[]`, while postgres.js exposes the narrower
          // driver-value union; this cast is the adapter seam between them.
          const params = compiled.params as Parameters<TransactionSql['unsafe']>[1];
          return transaction.unsafe(compiled.sql, params);
        },
      });
    },
    options,
  );
}
