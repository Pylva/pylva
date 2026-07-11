import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const postgresMock = vi.hoisted(() => vi.fn());

vi.mock('postgres', () => ({
  default: postgresMock,
}));

import {
  applyPostgresMigration,
  parseApplyPostgresMigrationArgs,
  resolveMigrationPath,
  type MigrationSqlClient,
} from '../../scripts/apply-postgres-migration.js';

let rootDir = '';

type TopLevelUnsafe = (
  query: string,
  params?: unknown[],
) => Promise<Array<Record<string, unknown>>>;
type TxUnsafe = (query: string, params?: unknown[]) => Promise<unknown>;
type MigrationTx = { unsafe(query: string, params?: unknown[]): Promise<unknown> };

async function writeMigration(name: string, content: string): Promise<string> {
  const migrationsDir = path.join(rootDir, 'db/migrations');
  await fs.mkdir(migrationsDir, { recursive: true });
  const file = path.join(migrationsDir, name);
  await fs.writeFile(file, content, 'utf8');
  return path.relative(rootDir, file);
}

function fakeSqlClient(opts?: { topLevelUnsafe?: TopLevelUnsafe; txUnsafe?: TxUnsafe }) {
  const topLevelUnsafe =
    opts?.topLevelUnsafe ??
    vi.fn<TopLevelUnsafe>(async (_query: string, _params?: unknown[]) => []);
  const txUnsafe = opts?.txUnsafe ?? vi.fn<TxUnsafe>(async () => undefined);
  const end = vi.fn(async () => undefined);
  let beginCount = 0;

  const client: MigrationSqlClient = {
    unsafe: topLevelUnsafe,
    begin: async <T>(fn: (tx: MigrationTx) => Promise<T>): Promise<T> => {
      beginCount += 1;
      return fn({ unsafe: txUnsafe });
    },
    end,
  };

  return {
    client,
    topLevelUnsafe,
    txUnsafe,
    end,
    beginCount: () => beginCount,
  };
}

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pylva-migration-test-'));
  postgresMock.mockReset();
});

afterEach(async () => {
  if (rootDir) await fs.rm(rootDir, { force: true, recursive: true });
});

describe('resolveMigrationPath', () => {
  it('rejects files outside db/migrations', () => {
    expect(() => resolveMigrationPath('scripts/not-a-migration.sql', rootDir)).toThrow(
      /outside db\/migrations/,
    );
  });

  it('rejects non-SQL files inside db/migrations', () => {
    expect(() => resolveMigrationPath('db/migrations/041_notes.txt', rootDir)).toThrow(/non-SQL/);
  });
});

describe('parseApplyPostgresMigrationArgs', () => {
  it('accepts --force before or after the migration path', () => {
    expect(parseApplyPostgresMigrationArgs(['--force', 'db/migrations/041_test.sql'])).toEqual({
      migrationPath: 'db/migrations/041_test.sql',
      force: true,
    });
    expect(parseApplyPostgresMigrationArgs(['db/migrations/041_test.sql', '--force'])).toEqual({
      migrationPath: 'db/migrations/041_test.sql',
      force: true,
    });
  });

  it('rejects multiple positional arguments', () => {
    expect(() =>
      parseApplyPostgresMigrationArgs(['db/migrations/041_test.sql', 'db/migrations/042_test.sql']),
    ).toThrow(/Usage: pnpm db:apply:migration/);
  });
});

describe('applyPostgresMigration', () => {
  it('requires a database URL when no sqlClient is provided', async () => {
    const relativePath = await writeMigration('041_test.sql', 'SELECT 1;');

    await expect(applyPostgresMigration({ migrationPath: relativePath, rootDir })).rejects.toThrow(
      /DATABASE_URL environment variable is required/,
    );
    expect(postgresMock).not.toHaveBeenCalled();
  });

  it('fails for missing database URL before reading the migration file', async () => {
    await expect(
      applyPostgresMigration({ migrationPath: 'db/migrations/missing.sql', rootDir }),
    ).rejects.toThrow(/DATABASE_URL environment variable is required/);
    expect(postgresMock).not.toHaveBeenCalled();
  });

  it('uses an explicit database URL to create a postgres client', async () => {
    const relativePath = await writeMigration('041_test.sql', 'SELECT 1;');
    const txUnsafe = vi.fn<TxUnsafe>(async () => undefined);
    const fake = fakeSqlClient({ txUnsafe });
    postgresMock.mockReturnValue(fake.client);

    await expect(
      applyPostgresMigration({
        migrationPath: relativePath,
        rootDir,
        databaseUrl: 'postgresql://prod.example/pylva',
      }),
    ).resolves.toEqual({ relativePath });

    expect(postgresMock).toHaveBeenCalledWith('postgresql://prod.example/pylva');
    expect(fake.beginCount()).toBe(1);
    expect(fake.topLevelUnsafe).toHaveBeenCalledTimes(6);
    expect(txUnsafe).toHaveBeenCalledTimes(2);
    expect(txUnsafe).toHaveBeenNthCalledWith(1, 'SELECT 1;');
    expect(txUnsafe).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO schema_migrations'),
      ['041_test.sql', expect.stringMatching(/^[a-f0-9]{64}$/), expect.any(Number)],
    );
    expect(fake.end).toHaveBeenCalledTimes(1);
  });

  it('wraps the migration file in a transaction', async () => {
    const relativePath = await writeMigration('041_test.sql', 'SELECT 1;');
    const txUnsafe = vi.fn<TxUnsafe>(async () => undefined);
    const fake = fakeSqlClient({ txUnsafe });

    await expect(
      applyPostgresMigration({ migrationPath: relativePath, rootDir, sqlClient: fake.client }),
    ).resolves.toEqual({ relativePath });

    expect(fake.beginCount()).toBe(1);
    expect(txUnsafe).toHaveBeenNthCalledWith(1, 'SELECT 1;');
    expect(txUnsafe).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('ON CONFLICT (filename) DO UPDATE SET'),
      ['041_test.sql', expect.stringMatching(/^[a-f0-9]{64}$/), expect.any(Number)],
    );
    expect(fake.end).not.toHaveBeenCalled();
  });

  it('records into schema_migrations inside the same begin window as the content', async () => {
    const relativePath = await writeMigration('041_test.sql', 'SELECT 1;');
    const operations: string[] = [];
    const topLevelUnsafe = vi.fn<TopLevelUnsafe>(async (query: string) => {
      if (query.includes('pg_advisory_unlock')) {
        operations.push('top:unlock');
      } else if (query.includes('pg_advisory_lock')) {
        operations.push('top:lock');
      } else if (query.includes("to_regclass('public.schema_migrations')")) {
        operations.push('top:probe-ledger');
      } else if (query.includes("to_regclass('public.builders')")) {
        operations.push('top:probe-builders');
      } else if (query.includes('CREATE TABLE')) {
        operations.push('top:create-ledger');
      } else {
        operations.push('top:read-ledger');
      }
      return [];
    });
    const txUnsafe = vi.fn<TxUnsafe>(async (query: string) => {
      operations.push(query === 'SELECT 1;' ? 'tx:migration-content' : 'tx:ledger-upsert');
      return undefined;
    });
    const sqlClient: MigrationSqlClient = {
      unsafe: topLevelUnsafe,
      begin: async <T>(fn: (tx: MigrationTx) => Promise<T>): Promise<T> => {
        operations.push('begin:start');
        const result = await fn({ unsafe: txUnsafe });
        operations.push('begin:end');
        return result;
      },
      end: vi.fn(async () => undefined),
    };

    await expect(
      applyPostgresMigration({ migrationPath: relativePath, rootDir, sqlClient }),
    ).resolves.toEqual({ relativePath });

    expect(operations).toEqual([
      'top:lock',
      'top:probe-ledger',
      'top:probe-builders',
      'top:create-ledger',
      'top:read-ledger',
      'begin:start',
      'tx:migration-content',
      'tx:ledger-upsert',
      'begin:end',
      'top:unlock',
    ]);
  });

  it('refuses to create a partial ledger on an existing untracked database', async () => {
    const relativePath = await writeMigration('041_test.sql', 'SELECT 1;');
    const topLevelUnsafe = vi.fn<TopLevelUnsafe>(async (query: string) => {
      if (query.includes("to_regclass('public.schema_migrations')")) {
        return [{ regclass: null }];
      }
      if (query.includes("to_regclass('public.builders')")) {
        return [{ regclass: 'builders' }];
      }
      return [];
    });
    const fake = fakeSqlClient({ topLevelUnsafe });

    await expect(
      applyPostgresMigration({ migrationPath: relativePath, rootDir, sqlClient: fake.client }),
    ).rejects.toThrow(
      'database predates migration tracking; run pnpm db:migrate --baseline --yes once before applying manual migrations',
    );

    const queries = topLevelUnsafe.mock.calls.map(([query]) => query);
    expect(fake.beginCount()).toBe(0);
    expect(queries.some((query) => query.includes('CREATE TABLE IF NOT EXISTS'))).toBe(false);
    expect(queries.some((query) => query.includes('SELECT filename FROM schema_migrations'))).toBe(
      false,
    );
    expect(queries.at(-1)).toContain('pg_advisory_unlock');
  });

  it('refuses an already-recorded filename without force', async () => {
    const relativePath = await writeMigration('041_test.sql', 'SELECT 1;');
    const topLevelUnsafe = vi.fn<TopLevelUnsafe>(async (query: string) =>
      query.includes('SELECT filename') ? [{ filename: '041_test.sql' }] : [],
    );
    const fake = fakeSqlClient({ topLevelUnsafe });

    await expect(
      applyPostgresMigration({ migrationPath: relativePath, rootDir, sqlClient: fake.client }),
    ).rejects.toThrow(
      'Refusing to re-apply 041_test.sql: already recorded in schema_migrations (use --force)',
    );

    expect(fake.beginCount()).toBe(0);
    expect(fake.end).not.toHaveBeenCalled();
  });

  it('force re-applies an already-recorded filename and upserts the ledger row', async () => {
    const relativePath = await writeMigration('041_test.sql', 'SELECT 1;');
    const topLevelUnsafe = vi.fn<TopLevelUnsafe>(async (query: string) =>
      query.includes('SELECT filename') ? [{ filename: '041_test.sql' }] : [],
    );
    const txUnsafe = vi.fn<TxUnsafe>(async () => undefined);
    const fake = fakeSqlClient({ topLevelUnsafe, txUnsafe });

    await expect(
      applyPostgresMigration({
        migrationPath: relativePath,
        rootDir,
        sqlClient: fake.client,
        force: true,
      }),
    ).resolves.toEqual({ relativePath });

    expect(fake.beginCount()).toBe(1);
    expect(txUnsafe).toHaveBeenNthCalledWith(1, 'SELECT 1;');
    expect(txUnsafe).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('ON CONFLICT (filename) DO UPDATE SET'),
      ['041_test.sql', expect.stringMatching(/^[a-f0-9]{64}$/), expect.any(Number)],
    );
  });

  it('surfaces the failing migration filename on error', async () => {
    const relativePath = await writeMigration('041_fail.sql', 'SELECT bad;');
    const txUnsafe = vi.fn<TxUnsafe>(async () => {
      throw new Error('syntax error');
    });
    const fake = fakeSqlClient({ txUnsafe });

    await expect(
      applyPostgresMigration({
        migrationPath: relativePath,
        rootDir,
        sqlClient: fake.client,
      }),
    ).rejects.toThrow(/041_fail\.sql: syntax error/);
  });
});
