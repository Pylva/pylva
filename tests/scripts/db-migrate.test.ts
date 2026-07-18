import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRecordingSqlClient, type RecordedCall } from '../_helpers/migration-sql-mock.js';
import { computeChecksum } from '../../scripts/db-migrate-core.js';
import { parseArgs, runDbMigrate, type DbMigrateArgs } from '../../scripts/db-migrate.js';
import { parseDbMigrateEnv } from '../../scripts/db-migrate-env.js';

let rootDir = '';
let migrationsDir = '';

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pylva-db-migrate-test-'));
  migrationsDir = path.join(rootDir, 'db/migrations');
  await fs.mkdir(migrationsDir, { recursive: true });
});

afterEach(async () => {
  if (rootDir) {
    await fs.rm(rootDir, { force: true, recursive: true });
  }
});

async function writeMigration(filename: string, content: string): Promise<void> {
  await fs.writeFile(path.join(migrationsDir, filename), content, 'utf8');
}

async function writePhaseMetadata(
  overrides: Record<string, 'pre_roll' | 'post_roll'>,
): Promise<void> {
  await fs.writeFile(
    path.join(rootDir, 'db/migration-phases.json'),
    JSON.stringify({ default: 'pre_roll', overrides }),
    'utf8',
  );
}

async function writeThreeMigrations(): Promise<Record<string, string>> {
  const contents = {
    '001_one.sql': "SELECT '001';",
    '002_two.sql': "SELECT '002';",
    '003_three.sql': "SELECT '003';",
  };
  for (const [filename, content] of Object.entries(contents)) {
    await writeMigration(filename, content);
  }
  return contents;
}

function ledgerRowsFor(contents: Record<string, string>, filenames: string[]) {
  return filenames.map((filename) => ({
    filename,
    checksum: computeChecksum(contents[filename]!),
  }));
}

function pendingContentCalls(calls: RecordedCall[]): string[] {
  return calls
    .filter((call) => call.kind === 'tx.unsafe')
    .map((call) => call.query ?? '')
    .filter((query) => query.startsWith('SELECT '));
}

function beginCount(calls: RecordedCall[]): number {
  return calls.filter((call) => call.kind === 'begin.enter').length;
}

function firstQueryIndex(calls: RecordedCall[], needle: string): number {
  return calls.findIndex((call) => call.query?.includes(needle));
}

function insertCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter(
    (call) => call.kind === 'tx.unsafe' && call.query?.includes('INSERT INTO schema_migrations'),
  );
}

async function runWithRecording(
  args: DbMigrateArgs,
  client: ReturnType<typeof createRecordingSqlClient>['client'],
): Promise<{ exitCode: number; logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const exitCode = await runDbMigrate(args, {
    sql: client,
    migrationsDir,
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
  });
  return { exitCode, logs, errors };
}

function parseSingleJsonLog(logs: string[]): Record<string, unknown> {
  expect(logs).toHaveLength(1);
  return JSON.parse(logs[0]!) as Record<string, unknown>;
}

describe('db-migrate core and CLI', () => {
  it('applies files in ascending filename order', async () => {
    await writeMigration('003_three.sql', "SELECT '003';");
    await writeMigration('001_one.sql', "SELECT '001';");
    await writeMigration('002_two.sql', "SELECT '002';");
    const { client, calls } = createRecordingSqlClient({ ledgerRows: [] });

    const result = await runWithRecording({ mode: 'apply', yes: false, json: false }, client);

    expect(result.exitCode).toBe(0);
    expect(pendingContentCalls(calls)).toEqual(["SELECT '001';", "SELECT '002';", "SELECT '003';"]);
  });

  it('applies only the selected phase while keeping other pending migrations deferred', async () => {
    const contents = await writeThreeMigrations();
    await writePhaseMetadata({ '002_two.sql': 'post_roll' });
    const { client, calls } = createRecordingSqlClient({ ledgerRows: [] });

    const result = await runWithRecording(
      { mode: 'apply', phase: 'pre_roll', yes: false, json: false },
      client,
    );

    expect(result.exitCode).toBe(0);
    expect(pendingContentCalls(calls)).toEqual(["SELECT '001';"]);
    expect(insertCalls(calls).map((call) => call.params?.[0])).toEqual(['001_one.sql']);

    const phaseStatus = createRecordingSqlClient({
      ledgerRows: ledgerRowsFor(contents, ['001_one.sql']),
    });
    const statusResult = await runWithRecording(
      { mode: 'status', phase: 'pre_roll', yes: false, json: true },
      phaseStatus.client,
    );
    expect(statusResult.exitCode).toBe(0);
    expect(parseSingleJsonLog(statusResult.logs)).toMatchObject({
      phase: 'pre_roll',
      state: 'in_sync',
      pending: [],
      deferred_pending: ['002_two.sql', '003_three.sql'],
    });
  });

  it('keeps an unphased run backward-compatible by applying every pending migration', async () => {
    await writeThreeMigrations();
    await writePhaseMetadata({ '002_two.sql': 'post_roll' });
    const { client, calls } = createRecordingSqlClient({ ledgerRows: [] });

    const result = await runWithRecording({ mode: 'apply', yes: false, json: false }, client);

    expect(result.exitCode).toBe(0);
    expect(pendingContentCalls(calls)).toEqual(["SELECT '001';", "SELECT '002';", "SELECT '003';"]);
  });

  it('requires every pre_roll migration before applying post_roll work', async () => {
    const contents = await writeThreeMigrations();
    await writePhaseMetadata({ '002_two.sql': 'post_roll' });

    const blocked = createRecordingSqlClient({ ledgerRows: [] });
    const blockedResult = await runWithRecording(
      { mode: 'apply', phase: 'post_roll', yes: false, json: false },
      blocked.client,
    );
    expect(blockedResult.exitCode).toBe(4);
    expect(blockedResult.errors.join('\n')).toContain('pre_roll migrations remain pending');
    expect(beginCount(blocked.calls)).toBe(0);

    const ready = createRecordingSqlClient({
      ledgerRows: ledgerRowsFor(contents, ['001_one.sql']),
    });
    const readyResult = await runWithRecording(
      { mode: 'apply', phase: 'post_roll', yes: false, json: false },
      ready.client,
    );
    expect(readyResult.exitCode).toBe(0);
    expect(pendingContentCalls(ready.calls)).toEqual(["SELECT '002';", "SELECT '003';"]);
  });

  it('resumes a post_roll suffix after an earlier post_roll migration committed', async () => {
    const contents = await writeThreeMigrations();
    await writePhaseMetadata({
      '002_two.sql': 'post_roll',
      '003_three.sql': 'post_roll',
    });
    const retry = createRecordingSqlClient({
      ledgerRows: ledgerRowsFor(contents, ['001_one.sql', '002_two.sql']),
    });

    const result = await runWithRecording(
      { mode: 'apply', phase: 'post_roll', yes: false, json: false },
      retry.client,
    );

    expect(result.exitCode).toBe(0);
    expect(pendingContentCalls(retry.calls)).toEqual(["SELECT '003';"]);
    expect(insertCalls(retry.calls).map((call) => call.params?.[0])).toEqual(['003_three.sql']);
  });

  it('does not hide global ledger drift when inspecting one phase', async () => {
    const contents = await writeThreeMigrations();
    await writePhaseMetadata({ '002_two.sql': 'post_roll' });
    const { client } = createRecordingSqlClient({
      ledgerRows: [
        { filename: '001_one.sql', checksum: 'wrong-checksum' },
        ...ledgerRowsFor(contents, ['003_three.sql']),
      ],
    });

    const result = await runWithRecording(
      { mode: 'status', phase: 'post_roll', yes: false, json: true },
      client,
    );

    expect(result.exitCode).toBe(2);
    expect(parseSingleJsonLog(result.logs)).toMatchObject({
      phase: 'post_roll',
      state: 'drift',
      pending: ['002_two.sql'],
      drift: [
        {
          filename: '001_one.sql',
          ledgerChecksum: 'wrong-checksum',
          fileChecksum: computeChecksum(contents['001_one.sql']!),
        },
      ],
    });
  });

  it('serializes the ledger read and apply sequence with an advisory lock', async () => {
    await writeMigration('001_one.sql', "SELECT '001';");
    const { client, calls } = createRecordingSqlClient({ ledgerRows: [] });

    const result = await runWithRecording({ mode: 'apply', yes: false, json: false }, client);

    expect(result.exitCode).toBe(0);
    const lockIndex = firstQueryIndex(calls, 'pg_advisory_lock');
    const ledgerReadIndex = firstQueryIndex(calls, 'FROM schema_migrations');
    const migrationBeginIndex = calls.findIndex((call) => call.kind === 'begin.enter');
    const unlockIndex = firstQueryIndex(calls, 'pg_advisory_unlock');
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(ledgerReadIndex).toBeGreaterThan(lockIndex);
    expect(migrationBeginIndex).toBeGreaterThan(ledgerReadIndex);
    expect(unlockIndex).toBeGreaterThan(migrationBeginIndex);
  });

  it('skips applied ledger rows with matching checksums', async () => {
    const contents = await writeThreeMigrations();
    const { client, calls } = createRecordingSqlClient({
      ledgerRows: ledgerRowsFor(contents, ['001_one.sql', '002_two.sql']),
    });

    const result = await runWithRecording({ mode: 'apply', yes: false, json: false }, client);

    expect(result.exitCode).toBe(0);
    expect(beginCount(calls)).toBe(1);
    expect(pendingContentCalls(calls)).toEqual(["SELECT '003';"]);
  });

  it('keeps checksum computation pinned', () => {
    expect(computeChecksum('SELECT 1;\n')).toBe(
      'b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd',
    );
  });

  it('refuses all apply work when the ledger checksum drifts', async () => {
    const contents = await writeThreeMigrations();
    const fileChecksum = computeChecksum(contents['001_one.sql']!);
    const { client, calls } = createRecordingSqlClient({
      ledgerRows: [{ filename: '001_one.sql', checksum: 'ledger-checksum' }],
    });

    const result = await runWithRecording({ mode: 'apply', yes: false, json: false }, client);

    expect(result.exitCode).toBe(2);
    expect(beginCount(calls)).toBe(0);
    expect(result.errors.join('\n')).toContain('001_one.sql');
    expect(result.errors.join('\n')).toContain('ledger-checksum');
    expect(result.errors.join('\n')).toContain(fileChecksum);
  });

  it('records each applied migration in the same transaction window as the migration content', async () => {
    const contents = {
      '001_one.sql': "SELECT '001';",
      '002_two.sql': "SELECT '002';",
    };
    for (const [filename, content] of Object.entries(contents)) {
      await writeMigration(filename, content);
    }
    const { client, calls } = createRecordingSqlClient({ ledgerRows: [] });

    const result = await runWithRecording({ mode: 'apply', yes: false, json: false }, client);

    expect(result.exitCode).toBe(0);
    const windows: RecordedCall[][] = [];
    for (let index = 0; index < calls.length; index += 1) {
      if (calls[index]?.kind !== 'begin.enter') continue;
      const endIndex = calls.findIndex(
        (call, candidateIndex) => candidateIndex > index && call.kind === 'begin.exit',
      );
      windows.push(calls.slice(index, endIndex + 1));
    }

    expect(windows).toHaveLength(2);
    for (const [index, filename] of ['001_one.sql', '002_two.sql'].entries()) {
      const window = windows[index]!;
      expect(window.map((call) => call.kind)).toEqual([
        'begin.enter',
        'tx.unsafe',
        'tx.unsafe',
        'tx.unsafe',
        'begin.exit',
      ]);
      expect(window[1]?.query).toBe("SET LOCAL lock_timeout = '30s'");
      expect(window[2]?.query).toBe(contents[filename as keyof typeof contents]);
      expect(window[3]?.query).toContain('INSERT INTO schema_migrations');
      expect(window[3]?.params?.[0]).toBe(filename);
      expect(window[3]?.params?.[1]).toBe(
        computeChecksum(contents[filename as keyof typeof contents]),
      );
    }
  });

  it('stops on the first migration failure without recording the failed file', async () => {
    await writeMigration('001_one.sql', "SELECT '001';");
    await writeMigration('002_bad.sql', "SELECT '002';");
    await writeMigration('003_three.sql', "SELECT '003';");
    const { client, calls } = createRecordingSqlClient({
      ledgerRows: [],
      failOn: (query) => (query === "SELECT '002';" ? new Error('boom') : undefined),
    });

    const result = await runWithRecording({ mode: 'apply', yes: false, json: false }, client);

    expect(result.exitCode).toBe(1);
    expect(result.errors.join('\n')).toContain('002_bad.sql');
    expect(pendingContentCalls(calls)).toEqual(["SELECT '001';", "SELECT '002';"]);
    expect(insertCalls(calls).map((call) => call.params?.[0])).toEqual(['001_one.sql']);
    expect(beginCount(calls)).toBe(2);
  });

  it('refuses to apply an existing untracked database', async () => {
    await writeThreeMigrations();
    const { client, calls } = createRecordingSqlClient({
      regclasses: { schema_migrations: false, builders: true },
    });

    const result = await runWithRecording({ mode: 'apply', yes: false, json: false }, client);

    expect(result.exitCode).toBe(4);
    expect(result.errors.join('\n')).toContain('--baseline --yes');
    expect(beginCount(calls)).toBe(0);
  });

  it('enforces baseline rails and records approved baselines', async () => {
    const contents = await writeThreeMigrations();

    const tracked = createRecordingSqlClient({
      ledgerRows: ledgerRowsFor(contents, ['001_one.sql']),
    });
    const trackedResult = await runWithRecording(
      { mode: 'baseline', yes: true, json: false },
      tracked.client,
    );
    expect(trackedResult.exitCode).toBe(4);
    expect(trackedResult.errors.join('\n')).toContain('already tracked');

    const empty = createRecordingSqlClient({
      regclasses: { schema_migrations: false, builders: false },
    });
    const emptyResult = await runWithRecording(
      { mode: 'baseline', yes: true, json: false },
      empty.client,
    );
    expect(emptyResult.exitCode).toBe(4);
    expect(emptyResult.errors.join('\n')).toContain('empty database');

    const unknownThrough = createRecordingSqlClient({
      regclasses: { schema_migrations: false, builders: true },
    });
    const unknownResult = await runWithRecording(
      { mode: 'baseline', through: '999_missing.sql', yes: true, json: false },
      unknownThrough.client,
    );
    expect(unknownResult.exitCode).toBe(4);
    expect(unknownResult.errors.join('\n')).toContain('--through file not found');

    const dryRun = createRecordingSqlClient({
      regclasses: { schema_migrations: false, builders: true },
    });
    const dryRunResult = await runWithRecording(
      { mode: 'baseline', through: '002_two.sql', yes: false, json: false },
      dryRun.client,
    );
    expect(dryRunResult.exitCode).toBe(3);
    expect(dryRunResult.logs).toContain(
      `001_one.sql  ${computeChecksum(contents['001_one.sql']!)}`,
    );
    expect(dryRunResult.logs).toContain(
      `002_two.sql  ${computeChecksum(contents['002_two.sql']!)}`,
    );
    expect(dryRunResult.logs).toContain('2 file(s)');
    expect(beginCount(dryRun.calls)).toBe(0);

    const approved = createRecordingSqlClient({
      regclasses: { schema_migrations: false, builders: true },
    });
    const approvedResult = await runWithRecording(
      { mode: 'baseline', through: '002_two.sql', yes: true, json: false },
      approved.client,
    );
    expect(approvedResult.exitCode).toBe(0);
    expect(beginCount(approved.calls)).toBe(1);
    expect(insertCalls(approved.calls).map((call) => call.params?.[0])).toEqual([
      '001_one.sql',
      '002_two.sql',
    ]);
    expect(insertCalls(approved.calls).map((call) => call.params?.[3])).toEqual([
      'baseline',
      'baseline',
    ]);
  });

  it('reports status JSON shapes and exit codes', async () => {
    const contents = await writeThreeMigrations();
    const fullLedger = ledgerRowsFor(contents, ['001_one.sql', '002_two.sql', '003_three.sql']);

    const full = createRecordingSqlClient({ ledgerRows: fullLedger });
    const fullResult = await runWithRecording(
      { mode: 'status', yes: false, json: true },
      full.client,
    );
    expect(fullResult.exitCode).toBe(0);
    expect(parseSingleJsonLog(fullResult.logs)).toMatchObject({
      state: 'in_sync',
      head_file: '003_three.sql',
      applied_count: 3,
      pending: [],
      drift: [],
      unknown: [],
    });

    const partial = createRecordingSqlClient({
      ledgerRows: ledgerRowsFor(contents, ['001_one.sql']),
    });
    const partialResult = await runWithRecording(
      { mode: 'status', yes: false, json: true },
      partial.client,
    );
    expect(partialResult.exitCode).toBe(1);
    expect(parseSingleJsonLog(partialResult.logs)).toMatchObject({
      state: 'pending',
      head_file: '003_three.sql',
      applied_count: 1,
      pending: ['002_two.sql', '003_three.sql'],
      drift: [],
      unknown: [],
    });

    const drift = createRecordingSqlClient({
      ledgerRows: [{ filename: '001_one.sql', checksum: 'old-checksum' }],
    });
    const driftResult = await runWithRecording(
      { mode: 'status', yes: false, json: true },
      drift.client,
    );
    expect(driftResult.exitCode).toBe(2);
    expect(parseSingleJsonLog(driftResult.logs)).toMatchObject({
      state: 'drift',
      head_file: '003_three.sql',
      applied_count: 0,
      pending: ['002_two.sql', '003_three.sql'],
      drift: [
        {
          filename: '001_one.sql',
          ledgerChecksum: 'old-checksum',
          fileChecksum: computeChecksum(contents['001_one.sql']!),
        },
      ],
      unknown: [],
    });

    const untracked = createRecordingSqlClient({
      regclasses: { schema_migrations: false, builders: true },
    });
    const untrackedResult = await runWithRecording(
      { mode: 'status', yes: false, json: true },
      untracked.client,
    );
    expect(untrackedResult.exitCode).toBe(4);
    expect(parseSingleJsonLog(untrackedResult.logs)).toMatchObject({
      state: 'untracked',
      head_file: '003_three.sql',
      applied_count: 0,
      pending: ['001_one.sql', '002_two.sql', '003_three.sql'],
      drift: [],
      unknown: [],
    });
  });

  it('validates CLI argument combinations', () => {
    expect(parseArgs(['--phase', 'pre_roll'])).toEqual({
      mode: 'apply',
      phase: 'pre_roll',
      yes: false,
      json: false,
    });
    expect(parseArgs(['--status', '--phase', 'post_roll', '--json'])).toEqual({
      mode: 'status',
      phase: 'post_roll',
      yes: false,
      json: true,
    });
    expect(() => parseArgs(['--phase'])).toThrow('--phase requires pre_roll or post_roll');
    expect(() => parseArgs(['--phase', 'unknown'])).toThrow(
      '--phase requires pre_roll or post_roll',
    );
    expect(() => parseArgs(['--phase', 'pre_roll', '--phase', 'post_roll'])).toThrow(
      '--phase can only be specified once',
    );
    expect(() => parseArgs(['--baseline', '--phase', 'pre_roll'])).toThrow(
      '--phase is not supported with --baseline',
    );
    expect(() => parseArgs(['--through'])).toThrow('--through requires a migration filename');
    expect(() => parseArgs(['--through', '001_one.sql'])).toThrow(
      '--through is only supported with --baseline',
    );
    expect(() => parseArgs(['--json'])).toThrow('--json is only supported with --status');
    expect(() => parseArgs(['--wat'])).toThrow('Unknown argument: --wat');
    expect(() => parseArgs(['--status', '--baseline'])).toThrow('Cannot combine migration modes');
  });

  it('validates db-migrate environment values', () => {
    expect(() => parseDbMigrateEnv({})).toThrow('MIGRATION_DATABASE_URL is required');
    expect(() => parseDbMigrateEnv({ MIGRATION_DATABASE_URL: '' })).toThrow(
      'MIGRATION_DATABASE_URL is required',
    );
    expect(() =>
      parseDbMigrateEnv({
        MIGRATION_DATABASE_URL: 'postgresql://localhost/pylva',
        MIGRATE_LOCK_TIMEOUT: '30s; DROP TABLE x',
      }),
    ).toThrow('MIGRATE_LOCK_TIMEOUT must match /^[0-9]+(ms|s|min)?$/');

    expect(parseDbMigrateEnv({ MIGRATION_DATABASE_URL: 'postgresql://localhost/pylva' })).toEqual({
      databaseUrl: 'postgresql://localhost/pylva',
    });
    expect(
      parseDbMigrateEnv({
        MIGRATION_DATABASE_URL: 'postgresql://localhost/pylva',
        MIGRATE_LOCK_TIMEOUT: '30s',
      }),
    ).toEqual({ databaseUrl: 'postgresql://localhost/pylva', lockTimeout: '30s' });
  });
});
