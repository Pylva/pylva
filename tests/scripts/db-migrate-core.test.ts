import { describe, expect, it, vi } from 'vitest';
import {
  defaultMigrationPhaseMetadata,
  finalizeOnlineMigration,
  parseMigrationPhaseMetadata,
  prepareOnlineMigration,
  resolveMigrationPhases,
  type MigrateSqlClient,
  type MigrateTx,
} from '../../scripts/db-migrate-core.js';

describe('migration phase metadata', () => {
  it('defaults migrations to pre_roll and applies explicit post_roll overrides', () => {
    const metadata = parseMigrationPhaseMetadata({
      default: 'pre_roll',
      overrides: { '048_universal_api_key_scope.sql': 'post_roll' },
    });
    const phases = resolveMigrationPhases(
      ['041_rename_api_key_scopes.sql', '048_universal_api_key_scope.sql'],
      metadata,
    );

    expect(phases.get('041_rename_api_key_scopes.sql')).toBe('pre_roll');
    expect(phases.get('048_universal_api_key_scope.sql')).toBe('post_roll');
    expect(defaultMigrationPhaseMetadata()).toEqual({ default: 'pre_roll', overrides: {} });
  });

  it('rejects invalid phases and stale override filenames', () => {
    expect(() => parseMigrationPhaseMetadata({ default: 'before_roll', overrides: {} })).toThrow(
      /default must be one of/,
    );
    expect(() =>
      parseMigrationPhaseMetadata({
        default: 'pre_roll',
        overrides: { '048_universal_api_key_scope.sql': 'after_roll' },
      }),
    ).toThrow(/override for 048_universal_api_key_scope\.sql must be one of/);

    expect(() =>
      resolveMigrationPhases(
        ['041_rename_api_key_scopes.sql'],
        parseMigrationPhaseMetadata({
          default: 'pre_roll',
          overrides: { '048_universal_api_key_scope.sql': 'post_roll' },
        }),
      ),
    ).toThrow(/override references migration missing from disk/);
  });
});

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

describe('finalizeOnlineMigration', () => {
  it('does nothing outside migration 048', async () => {
    const tx = { unsafe: vi.fn() } as unknown as MigrateTx;

    await finalizeOnlineMigration(tx, '049_other.sql');

    expect(tx.unsafe).not.toHaveBeenCalled();
  });

  it('blocks writes and captures late legacy rows before the final migration update', async () => {
    const tx = { unsafe: vi.fn(async () => []) } as unknown as MigrateTx;

    await finalizeOnlineMigration(tx, '048_universal_api_key_scope.sql');

    expect(tx.unsafe).toHaveBeenCalledTimes(1);
    const query = String(vi.mocked(tx.unsafe).mock.calls[0]?.[0]);
    expect(query.indexOf('LOCK TABLE api_keys IN SHARE ROW EXCLUSIVE MODE')).toBeGreaterThanOrEqual(
      0,
    );
    expect(query.indexOf('INSERT INTO _048_api_keys_scope_backup')).toBeGreaterThan(
      query.indexOf('LOCK TABLE api_keys IN SHARE ROW EXCLUSIVE MODE'),
    );
    expect(query).toContain("WHERE scope <> 'universal'");
    expect(query).toContain('ON CONFLICT (key_id) DO NOTHING');
  });
});
