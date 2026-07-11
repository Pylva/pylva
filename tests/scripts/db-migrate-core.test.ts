import { describe, expect, it, vi } from 'vitest';
import {
  prepareOnlineMigration,
  type MigrateSqlClient,
  type MigrateTx,
} from '../../scripts/db-migrate-core.js';

describe('prepareOnlineMigration', () => {
  it('does nothing for migrations without an online preparation', async () => {
    const sql = {
      begin: vi.fn(),
      unsafe: vi.fn(),
      end: vi.fn(),
    } as unknown as MigrateSqlClient;

    await prepareOnlineMigration({ sql, filename: '049_other.sql' });

    expect(sql.begin).not.toHaveBeenCalled();
    expect(sql.unsafe).not.toHaveBeenCalled();
  });

  it('splits migration 048 constraint work and bounded backfill into separate transactions', async () => {
    const transactionQueries: string[][] = [];
    const transactionParams: Array<unknown[] | undefined>[] = [];
    let batchCall = 0;

    const sql: MigrateSqlClient = {
      begin: async <T>(fn: (tx: MigrateTx) => Promise<T>): Promise<T> => {
        const queries: string[] = [];
        const params: Array<unknown[] | undefined> = [];
        transactionQueries.push(queries);
        transactionParams.push(params);
        return fn({
          unsafe: async (query: string, queryParams?: unknown[]) => {
            queries.push(query);
            params.push(queryParams);
            if (!query.includes('SELECT count(*)::int AS updated_count')) return [];
            batchCall += 1;
            return batchCall === 1
              ? [{ updated_count: 2, last_key_id: '000000000002' }]
              : [{ updated_count: 0, last_key_id: null }];
          },
        });
      },
      unsafe: vi.fn(async () => []),
      end: vi.fn(async () => undefined),
    };

    await prepareOnlineMigration({
      sql,
      filename: '048_universal_api_key_scope.sql',
      lockTimeout: '5s',
    });

    expect(transactionQueries).toHaveLength(4);
    expect(transactionQueries[0]!.join('\n')).toContain(
      'CREATE TABLE IF NOT EXISTS _048_api_keys_scope_backup',
    );
    expect(transactionQueries[0]!.join('\n')).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_048_api_keys_scope_backup_key_id',
    );
    expect(transactionQueries[0]!.join('\n')).toContain(
      'ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_scope_check',
    );
    expect(transactionQueries[1]!.join('\n')).toContain(
      'ALTER TABLE api_keys VALIDATE CONSTRAINT api_keys_scope_check',
    );
    expect(transactionQueries[2]!.join('\n')).toContain('LIMIT $2');
    expect(transactionQueries[2]!.join('\n')).toContain('INSERT INTO _048_api_keys_scope_backup');
    expect(transactionQueries[2]!.join('\n')).toContain("SET scope = 'universal'");
    expect(transactionParams[2]).toContainEqual(['', 1_000]);
    expect(transactionParams[3]).toContainEqual(['000000000002', 1_000]);
    expect(transactionQueries[0]).toContain("SET LOCAL lock_timeout = '1s'");
    expect(
      transactionQueries
        .slice(1)
        .flat()
        .filter((query) => query.includes("lock_timeout = '5s'")),
    ).toHaveLength(3);
  });
});
