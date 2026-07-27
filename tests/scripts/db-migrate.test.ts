import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRecordingSqlClient, type RecordedCall } from '../_helpers/migration-sql-mock.js';
import {
  computeChecksum,
  recordBaseline,
  REMOVE_FREE_FRESH_INSTALL_GUC,
} from '../../scripts/db-migrate-core.js';
import {
  parseArgs,
  removeFreeApprovalError,
  runDbMigrate,
  type DbMigrateArgs,
} from '../../scripts/db-migrate.js';
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
    .filter(
      (query) =>
        query.startsWith('SELECT ') && !query.includes('pg_catalog.set_config'),
    );
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

  it('requires explicit expand and contract approvals for the remove-Free migration windows', async () => {
    await writeMigration('056_workspace_access_state_expand.sql', "SELECT '056';");
    await writeMigration('058_remove_free_plan_contract.sql', "SELECT '058';");
    await writePhaseMetadata({ '058_remove_free_plan_contract.sql': 'post_roll' });

    const blockedExpand = createRecordingSqlClient({ ledgerRows: [] });
    const blockedExpandResult = await runWithRecording(
      { mode: 'apply', phase: 'pre_roll', yes: false, json: false },
      blockedExpand.client,
    );
    expect(blockedExpandResult.exitCode).toBe(4);
    expect(blockedExpandResult.errors.join('\n')).toContain('--approve-remove-free-expand');
    expect(beginCount(blockedExpand.calls)).toBe(0);
    const lockIndex = firstQueryIndex(blockedExpand.calls, 'pg_advisory_lock');
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(firstQueryIndex(blockedExpand.calls, 'FROM schema_migrations')).toBeGreaterThan(
      lockIndex,
    );
    expect(firstQueryIndex(blockedExpand.calls, 'pg_advisory_unlock')).toBeGreaterThan(lockIndex);

    const blockedContract = createRecordingSqlClient({ ledgerRows: [] });
    const blockedContractResult = await runWithRecording(
      {
        mode: 'apply',
        phase: 'pre_roll',
        yes: false,
        json: false,
        approveRemoveFreeExpand: true,
      },
      blockedContract.client,
    );
    expect(blockedContractResult.exitCode).toBe(0);
    expect(pendingContentCalls(blockedContract.calls)).toEqual(["SELECT '056';"]);

    const contractMissingApproval = createRecordingSqlClient({
      ledgerRows: [
        {
          filename: '056_workspace_access_state_expand.sql',
          checksum: computeChecksum("SELECT '056';"),
        },
      ],
    });
    const contractMissingResult = await runWithRecording(
      { mode: 'apply', phase: 'post_roll', yes: false, json: false },
      contractMissingApproval.client,
    );
    expect(contractMissingResult.exitCode).toBe(4);
    expect(contractMissingResult.errors.join('\n')).toContain('--approve-remove-free-contract');
    expect(beginCount(contractMissingApproval.calls)).toBe(0);

    const approvedContract = createRecordingSqlClient({
      ledgerRows: [
        {
          filename: '056_workspace_access_state_expand.sql',
          checksum: computeChecksum("SELECT '056';"),
        },
      ],
    });
    const approvedContractResult = await runWithRecording(
      {
        mode: 'apply',
        phase: 'post_roll',
        yes: false,
        json: false,
        approveRemoveFreeContract: true,
      },
      approvedContract.client,
    );
    expect(approvedContractResult.exitCode).toBe(0);
    expect(pendingContentCalls(approvedContract.calls)).toEqual(["SELECT '058';"]);

    const unphased = createRecordingSqlClient({ ledgerRows: [] });
    const unphasedResult = await runWithRecording(
      { mode: 'apply', yes: false, json: false },
      unphased.client,
    );
    expect(unphasedResult.exitCode).toBe(4);
    expect(unphasedResult.errors.join('\n')).toContain('cannot run in one upgrade invocation');
    expect(beginCount(unphased.calls)).toBe(0);

    const fresh = createRecordingSqlClient({ ledgerRows: [], builderRowsExist: false });
    const freshResult = await runWithRecording(
      { mode: 'apply', yes: false, json: false, freshInstall: true },
      fresh.client,
    );
    expect(freshResult.exitCode).toBe(0);
    expect(pendingContentCalls(fresh.calls)).toEqual(["SELECT '056';", "SELECT '058';"]);
  });

  it('binds remove-Free approvals to the exact pending migration filenames', () => {
    expect(
      removeFreeApprovalError(['055_before.sql', '060_after.sql'], {
        expand: false,
        contract: false,
      }),
    ).toBeNull();
    expect(
      removeFreeApprovalError(
        ['057_hosted_workspace_entitlements.sql'],
        {
          expand: false,
          contract: true,
        },
        { phase: 'pre_roll' },
      ),
    ).toContain('--approve-remove-free-expand');
    expect(
      removeFreeApprovalError(
        ['059_hosted_remove_free_contract.sql'],
        {
          expand: true,
          contract: false,
        },
        { phase: 'post_roll' },
      ),
    ).toContain('--approve-remove-free-contract');
    expect(
      removeFreeApprovalError(
        ['056_unreviewed_name.sql'],
        {
          expand: true,
          contract: false,
        },
        { phase: 'pre_roll' },
      ),
    ).toContain('unrecognized remove-Free migration');
    expect(
      removeFreeApprovalError(
        ['056_workspace_access_state_expand.sql'],
        {
          expand: true,
          contract: true,
        },
        { phase: 'pre_roll' },
      ),
    ).toContain('no exact remove-Free contract migration');
  });

  it('authorizes fresh-install retries only for an empty database with a contiguous ledger prefix', async () => {
    await writeMigration('055_before.sql', "SELECT '055';");
    await writeMigration('056_workspace_access_state_expand.sql', "SELECT '056';");
    await writeMigration('058_remove_free_plan_contract.sql', "SELECT '058';");
    await writePhaseMetadata({ '058_remove_free_plan_contract.sql': 'post_roll' });

    const populated = createRecordingSqlClient({ ledgerRows: [], builderRowsExist: true });
    const populatedResult = await runWithRecording(
      { mode: 'apply', yes: false, json: false, freshInstall: true },
      populated.client,
    );
    expect(populatedResult.exitCode).toBe(4);
    expect(populatedResult.errors.join('\n')).toContain('requires zero rows in builders');
    expect(beginCount(populated.calls)).toBe(0);

    const gap = createRecordingSqlClient({
      ledgerRows: [
        {
          filename: '056_workspace_access_state_expand.sql',
          checksum: computeChecksum("SELECT '056';"),
        },
      ],
      builderRowsExist: false,
    });
    const gapResult = await runWithRecording(
      { mode: 'apply', yes: false, json: false, freshInstall: true },
      gap.client,
    );
    expect(gapResult.exitCode).toBe(4);
    expect(gapResult.errors.join('\n')).toContain('contiguous manifest prefix');
    expect(beginCount(gap.calls)).toBe(0);

    const retry = createRecordingSqlClient({
      ledgerRows: [
        {
          filename: '055_before.sql',
          checksum: computeChecksum("SELECT '055';"),
        },
      ],
      builderRowsExist: false,
    });
    const retryResult = await runWithRecording(
      { mode: 'apply', yes: false, json: false, freshInstall: true },
      retry.client,
    );
    expect(retryResult.exitCode).toBe(0);
    expect(pendingContentCalls(retry.calls)).toEqual(["SELECT '056';", "SELECT '058';"]);
  });

  it.each([
    [
      'a SET ROLE/session mismatch',
      { sessionUserName: 'session_owner' },
      'current_user must equal session_user',
    ],
    ['a NOLOGIN role', { canLogin: false }, 'principal must be LOGIN'],
    ['a role without CREATEROLE', { canCreateRole: false }, 'principal must have CREATEROLE'],
    ['a superuser', { isSuperuser: true }, 'principal must be NOSUPERUSER'],
    ['a BYPASSRLS role', { bypassesRls: true }, 'principal must be NOBYPASSRLS'],
    ['a replication role', { canReplicate: true }, 'principal must be NOREPLICATION'],
    [
      'a non-owner of the target database',
      { ownsCurrentDatabase: false },
      'principal must own current_database()',
    ],
  ])(
    'rejects fresh install under %s before creating the migration ledger',
    async (_description, principal, expectedError) => {
      await writeMigration('001_one.sql', "SELECT '001';");
      const recording = createRecordingSqlClient({
        regclasses: { schema_migrations: false, builders: false },
        freshInstallPrincipal: principal,
      });

      const result = await runWithRecording(
        { mode: 'apply', yes: false, json: false, freshInstall: true },
        recording.client,
      );

      expect(result.exitCode).toBe(4);
      expect(result.errors.join('\n')).toContain(expectedError);
      expect(
        recording.calls.some((call) =>
          call.query?.includes('CREATE TABLE IF NOT EXISTS schema_migrations'),
        ),
      ).toBe(false);
      expect(beginCount(recording.calls)).toBe(0);
    },
  );

  it('rejects an unattestable fresh-install principal before creating the ledger', async () => {
    await writeMigration('001_one.sql', "SELECT '001';");
    const recording = createRecordingSqlClient({
      regclasses: { schema_migrations: false, builders: false },
      freshInstallPrincipal: null,
    });

    const result = await runWithRecording(
      { mode: 'apply', yes: false, json: false, freshInstall: true },
      recording.client,
    );

    expect(result.exitCode).toBe(4);
    expect(result.errors.join('\n')).toContain('could not attest the migration principal');
    expect(
      recording.calls.some((call) =>
        call.query?.includes('CREATE TABLE IF NOT EXISTS schema_migrations'),
      ),
    ).toBe(false);
    expect(beginCount(recording.calls)).toBe(0);
  });

  it('attests a safe fresh-install database owner before creating the ledger', async () => {
    await writeMigration('001_one.sql', "SELECT '001';");
    const recording = createRecordingSqlClient({
      regclasses: { schema_migrations: false, builders: false },
    });

    const result = await runWithRecording(
      { mode: 'apply', yes: false, json: false, freshInstall: true },
      recording.client,
    );

    expect(result.exitCode).toBe(0);
    const attestationIndex = firstQueryIndex(recording.calls, 'FROM pg_catalog.pg_roles AS role');
    const ledgerCreateIndex = firstQueryIndex(
      recording.calls,
      'CREATE TABLE IF NOT EXISTS schema_migrations',
    );
    expect(attestationIndex).toBeGreaterThanOrEqual(0);
    expect(ledgerCreateIndex).toBeGreaterThan(attestationIndex);
    expect(pendingContentCalls(recording.calls)).toEqual(["SELECT '001';"]);
  });

  it('overrides ambient fresh-install state in every migration transaction', async () => {
    await writeMigration('001_one.sql', "SELECT '001';");
    await writeMigration('002_two.sql', "SELECT '002';");
    const fresh = createRecordingSqlClient({
      regclasses: { schema_migrations: false, builders: false },
    });

    const freshResult = await runWithRecording(
      { mode: 'apply', yes: false, json: false, freshInstall: true },
      fresh.client,
    );

    expect(freshResult.exitCode).toBe(0);
    const freshGucCalls = fresh.calls.filter(
      (call) =>
        call.kind === 'tx.unsafe' &&
        call.query === 'SELECT pg_catalog.set_config($1, $2, true)',
    );
    expect(freshGucCalls).toHaveLength(2);
    expect(freshGucCalls.map((call) => call.params)).toEqual([
      [REMOVE_FREE_FRESH_INSTALL_GUC, 'on'],
      [REMOVE_FREE_FRESH_INSTALL_GUC, 'on'],
    ]);

    for (const migrationSql of ["SELECT '001';", "SELECT '002';"]) {
      const migrationIndex = fresh.calls.findIndex(
        (call) => call.kind === 'tx.unsafe' && call.query === migrationSql,
      );
      expect(migrationIndex).toBeGreaterThanOrEqual(1);
      expect(fresh.calls[migrationIndex - 1]).toMatchObject({
        kind: 'tx.unsafe',
        query: 'SELECT pg_catalog.set_config($1, $2, true)',
        params: [REMOVE_FREE_FRESH_INSTALL_GUC, 'on'],
      });
    }

    const ordinary = createRecordingSqlClient({ ledgerRows: [] });
    const ordinaryResult = await runWithRecording(
      { mode: 'apply', yes: false, json: false },
      ordinary.client,
    );
    expect(ordinaryResult.exitCode).toBe(0);
    const ordinaryGucCalls = ordinary.calls.filter(
      (call) =>
        call.kind === 'tx.unsafe' &&
        call.query === 'SELECT pg_catalog.set_config($1, $2, true)',
    );
    expect(ordinaryGucCalls).toHaveLength(2);
    expect(ordinaryGucCalls.map((call) => call.params)).toEqual([
      [REMOVE_FREE_FRESH_INSTALL_GUC, 'off'],
      [REMOVE_FREE_FRESH_INSTALL_GUC, 'off'],
    ]);
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
        'tx.unsafe',
        'begin.exit',
      ]);
      expect(window[1]?.query).toBe("SET LOCAL lock_timeout = '30s'");
      expect(window[2]).toMatchObject({
        query: 'SELECT pg_catalog.set_config($1, $2, true)',
        params: [REMOVE_FREE_FRESH_INSTALL_GUC, 'off'],
      });
      expect(window[3]?.query).toBe(contents[filename as keyof typeof contents]);
      expect(window[4]?.query).toContain('INSERT INTO schema_migrations');
      expect(window[4]?.params?.[0]).toBe(filename);
      expect(window[4]?.params?.[1]).toBe(
        computeChecksum(contents[filename as keyof typeof contents]),
      );
    }
  });

  it('bounds the lock wait for the general application ownership migration', async () => {
    const filename = '054_general_app_runtime_owner_boundary.sql';
    const content = "SELECT '054';";
    await writeMigration(filename, content);
    const { client, calls } = createRecordingSqlClient({ ledgerRows: [] });

    const result = await runWithRecording({ mode: 'apply', yes: false, json: false }, client);

    expect(result.exitCode).toBe(0);
    const transactionQueries = calls
      .filter((call) => call.kind === 'tx.unsafe')
      .map((call) => call.query);
    expect(transactionQueries[0]).toBe("SET LOCAL lock_timeout = '1s'");
    expect(transactionQueries[1]).toBe(
      'SELECT pg_catalog.set_config($1, $2, true)',
    );
    expect(transactionQueries[2]).toBe(content);
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
    expect(result.errors.join('\n')).toContain('--baseline --through');
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
      { mode: 'baseline', through: '003_three.sql', yes: true, json: false },
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

    for (const filename of [
      '056_workspace_access_state_expand.sql',
      '057_hosted_workspace_entitlements.sql',
      '058_remove_free_plan_contract.sql',
      '059_hosted_remove_free_contract.sql',
    ]) {
      await writeMigration(filename, `SELECT '${filename}';`);
      const protectedTarget = createRecordingSqlClient({
        regclasses: { schema_migrations: false, builders: true },
      });
      const protectedResult = await runWithRecording(
        { mode: 'baseline', through: filename, yes: true, json: false },
        protectedTarget.client,
      );
      expect(protectedResult.exitCode).toBe(4);
      expect(protectedResult.errors.join('\n')).toContain(
        'refusing to baseline through protected remove-Free migration',
      );
      expect(beginCount(protectedTarget.calls)).toBe(0);
    }

    const lowerLevel = createRecordingSqlClient({ ledgerRows: [] });
    await expect(
      recordBaseline({
        sql: lowerLevel.client,
        files: [
          {
            filename: '056_workspace_access_state_expand.sql',
            checksum: computeChecksum("SELECT '056';"),
            content: "SELECT '056';",
            phase: 'pre_roll',
          },
        ],
      }),
    ).rejects.toThrow('Refusing to baseline protected remove-Free migration');
    expect(beginCount(lowerLevel.calls)).toBe(0);
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
    expect(parseArgs(['--approve-remove-free-expand', '--phase', 'pre_roll'])).toEqual({
      mode: 'apply',
      phase: 'pre_roll',
      yes: false,
      json: false,
      approveRemoveFreeExpand: true,
    });
    expect(parseArgs(['--fresh-install'])).toEqual({
      mode: 'apply',
      yes: false,
      json: false,
      freshInstall: true,
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
    expect(() => parseArgs(['--baseline'])).toThrow('--baseline requires an explicit --through');
    expect(() => parseArgs(['--through'])).toThrow('--through requires a migration filename');
    expect(() => parseArgs(['--through', '001_one.sql'])).toThrow(
      '--through is only supported with --baseline',
    );
    expect(() => parseArgs(['--json'])).toThrow('--json is only supported with --status');
    expect(() => parseArgs(['--status', '--approve-remove-free-expand'])).toThrow(
      'remove-Free approval flags are only supported when applying migrations',
    );
    expect(() =>
      parseArgs(['--approve-remove-free-contract', '--approve-remove-free-contract']),
    ).toThrow('--approve-remove-free-contract can only be specified once');
    expect(() =>
      parseArgs(['--approve-remove-free-expand', '--approve-remove-free-contract']),
    ).toThrow('require separate invocations');
    expect(() => parseArgs(['--approve-remove-free-expand'])).toThrow('requires --phase pre_roll');
    expect(() => parseArgs(['--phase', 'pre_roll', '--approve-remove-free-contract'])).toThrow(
      'requires --phase post_roll',
    );
    expect(() => parseArgs(['--fresh-install', '--phase', 'pre_roll'])).toThrow(
      'cannot be combined with --phase',
    );
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
