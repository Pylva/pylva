import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import {
  computeChecksum,
  listMigrationFiles,
  type MigrateSqlClient,
} from '../../scripts/db-migrate-core.js';
import { runDbMigrate, type DbMigrateArgs } from '../../scripts/db-migrate.js';
import { applyMigrationsThrough, createScratchDb, type ScratchDb } from '../helpers/scratch-db.js';

const MIGRATIONS_DIR = path.resolve('db/migrations');
const THROUGH_040 = '040_audit_log_partition_runway.sql';
const TEST_TIMEOUT_MS = 180_000;

interface RunResult {
  exitCode: number;
  logs: string[];
  errors: string[];
}

interface LedgerRow {
  filename: string;
  checksum: string;
  applied_by: string;
}

async function migrationFiles() {
  return listMigrationFiles(MIGRATIONS_DIR);
}

async function migrationFilenames(): Promise<string[]> {
  return (await migrationFiles()).map((file) => file.filename);
}

function migrationPrefix(filename: string): number {
  return Number.parseInt(filename.slice(0, 3), 10);
}

async function runMigrate(scratch: ScratchDb, args: DbMigrateArgs): Promise<RunResult> {
  return runMigrateWithSql(scratch.sql, MIGRATIONS_DIR, args);
}

async function runMigrateWithSql(
  sql: MigrateSqlClient,
  migrationsDir: string,
  args: DbMigrateArgs,
): Promise<RunResult> {
  const logs: string[] = [];
  const errors: string[] = [];
  const exitCode = await runDbMigrate(args, {
    sql,
    migrationsDir,
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
  });
  return { exitCode, logs, errors };
}

function appliedLogFilenames(logs: string[]): string[] {
  return logs
    .filter((line) => line.startsWith('✓ '))
    .map((line) => line.replace(/^✓ /, '').replace(/ \([0-9]+ms\)$/, ''));
}

async function insertMinimalBuilder(scratch: ScratchDb): Promise<string> {
  const suffix = randomBytes(6).toString('hex');
  const [builder] = await scratch.sql<{ id: string }[]>`
    INSERT INTO builders (email, name, slug)
    VALUES (${`migration-runner-${suffix}@example.com`}, 'Migration Runner', ${`migration-runner-${suffix}`})
    RETURNING id
  `;
  return builder!.id;
}

async function insertApiKey(
  scratch: ScratchDb,
  builderId: string,
  scope: string,
  keyId: string,
): Promise<void> {
  await scratch.sql`
    INSERT INTO api_keys (key_id, builder_id, key_hash, scope)
    VALUES (${keyId}, ${builderId}, 'x', ${scope})
  `;
}

async function expectScopeCheckReject(action: Promise<unknown>): Promise<void> {
  try {
    await action;
  } catch (error) {
    const pgError = error as { code?: unknown; message?: unknown };
    expect(pgError.code).toBe('23514');
    expect(String(pgError.message)).toMatch(/api_keys_scope_check/);
    return;
  }
  throw new Error('Expected api_keys_scope_check rejection');
}

async function ledgerRows(scratch: ScratchDb): Promise<LedgerRow[]> {
  return scratch.sql<LedgerRow[]>`
    SELECT filename, checksum, applied_by
    FROM schema_migrations
    ORDER BY filename
  `;
}

async function appliedAtPairs(scratch: ScratchDb): Promise<Array<[string, string]>> {
  const rows = await scratch.sql<{ filename: string; applied_at: Date | string }[]>`
    SELECT filename, applied_at
    FROM schema_migrations
    ORDER BY filename
  `;
  return rows.map((row) => [row.filename, timestampValue(row.applied_at)]);
}

function timestampValue(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

async function assertCompleteLedger(
  scratch: ScratchDb,
  expectedAppliedBy: (filename: string) => string,
): Promise<LedgerRow[]> {
  const files = await migrationFiles();
  const rows = await ledgerRows(scratch);
  expect(rows.map((row) => row.filename)).toEqual(files.map((file) => file.filename));

  const filesByName = new Map(files.map((file) => [file.filename, file]));
  for (const row of rows) {
    const file = filesByName.get(row.filename);
    expect(file).toBeDefined();
    expect(row.checksum).toBe(computeChecksum(file!.content));
    expect(row.applied_by).toBe(expectedAppliedBy(row.filename));
  }

  return rows;
}

async function baselineThrough040(scratch: ScratchDb): Promise<RunResult> {
  const result = await runMigrate(scratch, {
    mode: 'baseline',
    through: THROUGH_040,
    yes: true,
    json: false,
  });
  expect(result.exitCode).toBe(0);
  return result;
}

async function legacy040WithBaseline(scratch: ScratchDb): Promise<void> {
  await applyMigrationsThrough(scratch, '040');
  await baselineThrough040(scratch);
}

function spawnDbMigrateStatus(url: string) {
  return spawnSync('pnpm', ['exec', 'tsx', 'scripts/db-migrate.ts', '--status', '--json'], {
    env: { ...process.env, DATABASE_URL: url },
    encoding: 'utf8',
  });
}

function spawnDbSetup(url: string) {
  return spawnSync('pnpm', ['exec', 'tsx', 'db/setup.ts'], {
    env: { ...process.env, DATABASE_URL: url, SKIP_CLICKHOUSE: 'true' },
    encoding: 'utf8',
  });
}

describe('migration runner integration', () => {
  it(
    'reproduces the 040 api_keys incident, pins the refusal rail, then baselines and catches up',
    async () => {
      const scratch = await createScratchDb();
      try {
        await applyMigrationsThrough(scratch, '040');
        const [ledgerProbe] = await scratch.sql<{ regclass: string | null }[]>`
          SELECT to_regclass('public.schema_migrations') AS regclass
        `;
        expect(ledgerProbe?.regclass).toBeNull();

        const builderId = await insertMinimalBuilder(scratch);
        await expectScopeCheckReject(insertApiKey(scratch, builderId, 'agent_sdk', 'cj00000001'));

        const guardedApply = await runMigrate(scratch, {
          mode: 'apply',
          yes: false,
          json: false,
        });
        expect(guardedApply.exitCode).toBe(4);
        expect(guardedApply.errors.join('\n')).toContain('--baseline --yes');

        await baselineThrough040(scratch);

        const catchUp = await runMigrate(scratch, { mode: 'apply', yes: false, json: false });
        expect(catchUp.exitCode).toBe(0);
        expect(appliedLogFilenames(catchUp.logs)).toEqual(
          (await migrationFilenames()).filter((filename) => migrationPrefix(filename) >= 41),
        );

        await expect(
          insertApiKey(scratch, builderId, 'agent_sdk', 'cj00000001'),
        ).resolves.toBeUndefined();
        await expectScopeCheckReject(insertApiKey(scratch, builderId, 'telemetry', 'cj00000002'));

        const rows = await assertCompleteLedger(scratch, (filename) =>
          migrationPrefix(filename) <= 40 ? 'baseline' : 'db:migrate',
        );
        expect(rows.at(-1)?.filename).toBe((await migrationFilenames()).at(-1));
      } finally {
        await scratch.drop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is idempotent on re-run after all migrations are recorded',
    async () => {
      const scratch = await createScratchDb();
      try {
        const firstRun = await runMigrate(scratch, { mode: 'apply', yes: false, json: false });
        expect(firstRun.exitCode).toBe(0);
        const before = await appliedAtPairs(scratch);

        const secondRun = await runMigrate(scratch, { mode: 'apply', yes: false, json: false });
        expect(secondRun.exitCode).toBe(0);
        expect(appliedLogFilenames(secondRun.logs)).toEqual([]);
        expect(secondRun.logs.join('\n')).toContain('0 pending');
        expect(await appliedAtPairs(scratch)).toEqual(before);
      } finally {
        await scratch.drop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'serializes concurrent runners against the same fresh database',
    async () => {
      const scratch = await createScratchDb();
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pylva-migrate-concurrent-'));
      const tempMigrationsDir = path.join(tempRoot, 'db/migrations');
      const firstSql = postgres(scratch.url, { max: 1, onnotice: () => undefined });
      const secondSql = postgres(scratch.url, { max: 1, onnotice: () => undefined });

      try {
        await fs.mkdir(tempMigrationsDir, { recursive: true });
        await fs.writeFile(
          path.join(tempMigrationsDir, '001_concurrent.sql'),
          `SELECT pg_sleep(0.25);
CREATE TABLE concurrent_migration_probe (id integer PRIMARY KEY);`,
          'utf8',
        );

        const [first, second] = await Promise.all([
          runMigrateWithSql(firstSql, tempMigrationsDir, {
            mode: 'apply',
            yes: false,
            json: false,
          }),
          runMigrateWithSql(secondSql, tempMigrationsDir, {
            mode: 'apply',
            yes: false,
            json: false,
          }),
        ]);

        expect([first.exitCode, second.exitCode]).toEqual([0, 0]);
        expect([...first.errors, ...second.errors]).toEqual([]);
        expect([...appliedLogFilenames(first.logs), ...appliedLogFilenames(second.logs)]).toEqual([
          '001_concurrent.sql',
        ]);

        const rows = await scratch.sql<{ filename: string }[]>`
          SELECT filename FROM schema_migrations ORDER BY filename
        `;
        expect(rows.map((row) => row.filename)).toEqual(['001_concurrent.sql']);
      } finally {
        await firstSql.end();
        await secondSql.end();
        await fs.rm(tempRoot, { force: true, recursive: true });
        await scratch.drop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps the ledger at the last successful file after an interrupted run',
    async () => {
      const scratch = await createScratchDb();
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pylva-migrate-interrupt-'));
      const tempMigrationsDir = path.join(tempRoot, 'db/migrations');

      try {
        await fs.mkdir(tempMigrationsDir, { recursive: true });
        await fs.writeFile(
          path.join(tempMigrationsDir, '001_valid.sql'),
          'CREATE TABLE migration_one (id integer PRIMARY KEY);',
          'utf8',
        );
        await fs.writeFile(
          path.join(tempMigrationsDir, '002_bad.sql'),
          'CREATE TABLE migration_two (id integer PRIMARY KEY',
          'utf8',
        );
        await fs.writeFile(
          path.join(tempMigrationsDir, '003_valid.sql'),
          'CREATE TABLE migration_three (id integer PRIMARY KEY);',
          'utf8',
        );

        const logs: string[] = [];
        const errors: string[] = [];
        const firstExitCode = await runDbMigrate(
          { mode: 'apply', yes: false, json: false },
          {
            sql: scratch.sql,
            migrationsDir: tempMigrationsDir,
            log: (line) => logs.push(line),
            error: (line) => errors.push(line),
          },
        );
        expect(firstExitCode).toBe(1);
        expect(errors.join('\n')).toContain('002_bad.sql');

        const afterFailure = await scratch.sql<{ filename: string; applied_at: Date | string }[]>`
          SELECT filename, applied_at
          FROM schema_migrations
          ORDER BY filename
        `;
        expect(afterFailure.map((row) => row.filename)).toEqual(['001_valid.sql']);
        const firstAppliedAt = timestampValue(afterFailure[0]!.applied_at);

        await fs.writeFile(
          path.join(tempMigrationsDir, '002_bad.sql'),
          'CREATE TABLE migration_two (id integer PRIMARY KEY);',
          'utf8',
        );

        const secondLogs: string[] = [];
        const secondErrors: string[] = [];
        const secondExitCode = await runDbMigrate(
          { mode: 'apply', yes: false, json: false },
          {
            sql: scratch.sql,
            migrationsDir: tempMigrationsDir,
            log: (line) => secondLogs.push(line),
            error: (line) => secondErrors.push(line),
          },
        );
        expect(secondErrors).toEqual([]);
        expect(secondExitCode).toBe(0);
        expect(appliedLogFilenames(secondLogs)).toEqual(['002_bad.sql', '003_valid.sql']);

        const finalRows = await scratch.sql<{ filename: string; applied_at: Date | string }[]>`
          SELECT filename, applied_at
          FROM schema_migrations
          ORDER BY filename
        `;
        expect(finalRows.map((row) => row.filename)).toEqual([
          '001_valid.sql',
          '002_bad.sql',
          '003_valid.sql',
        ]);
        expect(timestampValue(finalRows[0]!.applied_at)).toBe(firstAppliedAt);
      } finally {
        await fs.rm(tempRoot, { force: true, recursive: true });
        await scratch.drop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'baselines through 040 and catches up through the current head',
    async () => {
      const scratch = await createScratchDb();
      try {
        await applyMigrationsThrough(scratch, '040');
        const baseline = await baselineThrough040(scratch);
        const through040 = (await migrationFilenames()).filter(
          (filename) => migrationPrefix(filename) <= 40,
        );
        expect(baseline.logs).toContain(`${through040.length} file(s)`);

        let rows = await ledgerRows(scratch);
        expect(rows).toHaveLength(through040.length);
        expect(rows.every((row) => row.applied_by === 'baseline')).toBe(true);

        const catchUp = await runMigrate(scratch, { mode: 'apply', yes: false, json: false });
        expect(catchUp.exitCode).toBe(0);
        expect(appliedLogFilenames(catchUp.logs)).toEqual(
          (await migrationFilenames()).filter((filename) => migrationPrefix(filename) >= 41),
        );

        const status = await runMigrate(scratch, { mode: 'status', yes: false, json: true });
        expect(status.exitCode).toBe(0);
        expect(JSON.parse(status.logs[0]!)).toMatchObject({ state: 'in_sync' });

        rows = await assertCompleteLedger(scratch, (filename) =>
          migrationPrefix(filename) <= 40 ? 'baseline' : 'db:migrate',
        );
        expect(rows.filter((row) => row.applied_by === 'baseline')).toHaveLength(through040.length);
      } finally {
        await scratch.drop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'applies pre_roll migrations before the deferred universal-scope post_roll migration',
    async () => {
      const scratch = await createScratchDb();
      try {
        await legacy040WithBaseline(scratch);

        const preRoll = await runMigrate(scratch, {
          mode: 'apply',
          phase: 'pre_roll',
          yes: false,
          json: false,
        });
        expect(preRoll.exitCode).toBe(0);
        expect(appliedLogFilenames(preRoll.logs)).toEqual(
          (await migrationFilenames()).filter(
            (filename) => migrationPrefix(filename) >= 41 && migrationPrefix(filename) < 48,
          ),
        );

        const preRollStatus = await runMigrate(scratch, {
          mode: 'status',
          phase: 'pre_roll',
          yes: false,
          json: true,
        });
        expect(preRollStatus.exitCode).toBe(0);
        expect(JSON.parse(preRollStatus.logs[0]!)).toMatchObject({
          phase: 'pre_roll',
          state: 'in_sync',
          pending: [],
          deferred_pending: [
            '048_universal_api_key_scope.sql',
            '049_backfill_builder_owner_memberships.sql',
          ],
        });

        const postRoll = await runMigrate(scratch, {
          mode: 'apply',
          phase: 'post_roll',
          yes: false,
          json: false,
        });
        expect(postRoll.exitCode).toBe(0);
        expect(appliedLogFilenames(postRoll.logs)).toEqual([
          '048_universal_api_key_scope.sql',
          '049_backfill_builder_owner_memberships.sql',
        ]);

        await assertCompleteLedger(scratch, (filename) =>
          migrationPrefix(filename) <= 40 ? 'baseline' : 'db:migrate',
        );
      } finally {
        await scratch.drop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports status through the real CLI for in-sync and pending scratch databases',
    async () => {
      const inSync = await createScratchDb();
      const pending = await createScratchDb();

      try {
        await legacy040WithBaseline(inSync);
        const catchUp = await runMigrate(inSync, { mode: 'apply', yes: false, json: false });
        expect(catchUp.exitCode).toBe(0);

        const inSyncCli = spawnDbMigrateStatus(inSync.url);
        expect(inSyncCli.status).toBe(0);
        expect(JSON.parse(inSyncCli.stdout.trim())).toMatchObject({ state: 'in_sync' });

        await legacy040WithBaseline(pending);
        const pendingCli = spawnDbMigrateStatus(pending.url);
        expect(pendingCli.status).toBe(1);
        expect(JSON.parse(pendingCli.stdout.trim())).toMatchObject({
          state: 'pending',
          pending: expect.arrayContaining(['041_rename_api_key_scopes.sql']),
        });
      } finally {
        await pending.drop();
        await inSync.drop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'records db:setup migrations on a fresh database',
    async () => {
      const scratch = await createScratchDb();
      try {
        const setup = spawnDbSetup(scratch.url);
        expect(setup.status).toBe(0);

        const rows = await ledgerRows(scratch);
        expect(rows).toHaveLength((await migrationFilenames()).length);
        expect(rows.every((row) => row.applied_by === 'db:setup')).toBe(true);
      } finally {
        await scratch.drop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses db:setup on an untracked existing database',
    async () => {
      const scratch = await createScratchDb();
      try {
        await applyMigrationsThrough(scratch, '040');

        const setup = spawnDbSetup(scratch.url);
        expect(setup.status).not.toBe(0);
        expect(`${setup.stdout}\n${setup.stderr}`).toContain('--baseline');
      } finally {
        await scratch.drop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
