import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import {
  MigrationApplyError,
  applyPending,
  buildersTableExists,
  computeStatus,
  ensureLedger,
  errorMessage,
  ledgerExists,
  listMigrationFiles,
  logDrift,
  migrationHead,
  readLedger,
  recordBaseline,
  withMigrationAdvisoryLock,
  type LedgerRow,
  type MigrateSqlClient,
  type MigrationFile,
  type MigrationState,
  type MigrationStatus,
} from './db-migrate-core.js';
import { readDbMigrateEnv } from './db-migrate-env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_MIGRATIONS_DIR = path.resolve(DEFAULT_ROOT_DIR, 'db/migrations');

export interface DbMigrateArgs {
  mode: 'apply' | 'status' | 'baseline';
  through?: string;
  yes: boolean;
  json: boolean;
}

interface DbMigrateDeps {
  sql: MigrateSqlClient;
  migrationsDir: string;
  log: (l: string) => void;
  error: (l: string) => void;
  lockTimeout?: string;
}

interface StatusJson {
  state: MigrationState;
  head_file: string | null;
  applied_count: number;
  pending: string[];
  drift: MigrationStatus['drift'];
  unknown: string[];
}

export function isMainModule(importMetaUrl: string, argvPath: string | undefined): boolean {
  return argvPath !== undefined && importMetaUrl === pathToFileURL(argvPath).href;
}

function setMode(
  current: DbMigrateArgs['mode'],
  next: DbMigrateArgs['mode'],
): DbMigrateArgs['mode'] {
  if (current !== 'apply' && current !== next) {
    throw new Error('Cannot combine migration modes');
  }
  return next;
}

export function parseArgs(argv: string[]): DbMigrateArgs {
  let mode: DbMigrateArgs['mode'] = 'apply';
  let through: string | undefined;
  let yes = false;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--status') {
      mode = setMode(mode, 'status');
      continue;
    }
    if (arg === '--baseline') {
      mode = setMode(mode, 'baseline');
      continue;
    }
    if (arg === '--through') {
      const filename = argv[index + 1];
      if (!filename || filename.startsWith('--')) {
        throw new Error('--through requires a migration filename');
      }
      through = filename;
      index += 1;
      continue;
    }
    if (arg === '--yes') {
      yes = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg ?? ''}`);
  }

  if (through !== undefined && mode !== 'baseline') {
    throw new Error('--through is only supported with --baseline');
  }
  if (json && mode !== 'status') {
    throw new Error('--json is only supported with --status');
  }

  if (through === undefined) {
    return { mode, yes, json };
  }

  return { mode, through, yes, json };
}

function statusExitCode(state: MigrationState): number {
  if (state === 'in_sync') return 0;
  if (state === 'pending') return 1;
  if (state === 'drift') return 2;
  return 4;
}

function logStatusHuman(
  status: MigrationStatus,
  headFile: string | null,
  log: (line: string) => void,
): void {
  log(`state: ${status.state}`);
  log(`head_file: ${headFile ?? '(none)'}`);
  log(`applied_count: ${status.applied.length}`);
  if (status.pending.length > 0) {
    log('pending:');
    for (const filename of status.pending) log(`  ${filename}`);
  }
  if (status.drift.length > 0) {
    log('drift:');
    for (const item of status.drift) {
      log(`  ${item.filename} ledger=${item.ledgerChecksum} file=${item.fileChecksum}`);
    }
  }
  if (status.unknown.length > 0) {
    log('unknown:');
    for (const filename of status.unknown) log(`  ${filename}`);
  }
}

function logBaselineListing(files: MigrationFile[], log: (line: string) => void): void {
  for (const file of files) {
    log(`${file.filename}  ${file.checksum}`);
  }
  log(`${files.length} file(s)`);
}

async function runApply(deps: DbMigrateDeps, files: MigrationFile[]): Promise<number> {
  return withMigrationAdvisoryLock(deps.sql, async (lockedSql) => {
    const hasLedger = await ledgerExists(lockedSql);
    if (!hasLedger && (await buildersTableExists(lockedSql))) {
      deps.error(
        'database predates migration tracking; run pnpm db:migrate --baseline --yes once before applying migrations',
      );
      return 4;
    }

    await ensureLedger(lockedSql);
    const ledger = await readLedger(lockedSql);
    const status = computeStatus(files, ledger);
    if (status.drift.length > 0 || status.unknown.length > 0) {
      logDrift(status, deps.error);
      return 2;
    }

    try {
      const { appliedCount } = await applyPending({
        sql: lockedSql,
        files,
        ledger,
        appliedBy: 'db:migrate',
        lockTimeout: deps.lockTimeout ?? '30s',
        log: deps.log,
      });
      const headFile = migrationHead(files) ?? '(none)';
      if (appliedCount === 0) {
        deps.log(`0 pending — schema at head ${headFile}`);
      } else {
        deps.log(`applied ${appliedCount} migration(s); head: ${headFile}`);
      }
      return 0;
    } catch (error) {
      if (error instanceof MigrationApplyError) {
        deps.error(`failed to apply ${error.filename}: ${errorMessage(error.cause)}`);
        return 1;
      }
      throw error;
    }
  });
}

async function runStatus(
  deps: DbMigrateDeps,
  files: MigrationFile[],
  json: boolean,
): Promise<number> {
  const ledger = (await ledgerExists(deps.sql)) ? await readLedger(deps.sql) : null;
  const status = computeStatus(files, ledger);
  const headFile = migrationHead(files);

  if (json) {
    const payload: StatusJson = {
      state: status.state,
      head_file: headFile,
      applied_count: status.applied.length,
      pending: status.pending,
      drift: status.drift,
      unknown: status.unknown,
    };
    deps.log(JSON.stringify(payload));
  } else {
    logStatusHuman(status, headFile, deps.log);
  }

  return statusExitCode(status.state);
}

async function readLedgerIfPresent(sql: MigrateSqlClient): Promise<LedgerRow[]> {
  return (await ledgerExists(sql)) ? readLedger(sql) : [];
}

async function runBaseline(
  args: DbMigrateArgs,
  deps: DbMigrateDeps,
  files: MigrationFile[],
): Promise<number> {
  return withMigrationAdvisoryLock(deps.sql, async (lockedSql) => {
    const existingLedger = await readLedgerIfPresent(lockedSql);
    if (existingLedger.length > 0) {
      deps.error('already tracked — baseline is a one-time operation');
      return 4;
    }

    if (!(await buildersTableExists(lockedSql))) {
      deps.error('empty database — run pnpm db:migrate to bootstrap instead');
      return 4;
    }

    const throughIndex =
      args.through === undefined
        ? files.length - 1
        : files.findIndex((file) => file.filename === args.through);

    if (throughIndex < 0) {
      deps.error(`--through file not found: ${args.through ?? ''}`);
      return 4;
    }

    const baselineFiles = files.slice(0, throughIndex + 1);

    if (!args.yes) {
      logBaselineListing(baselineFiles, deps.log);
      return 3;
    }

    await ensureLedger(lockedSql);
    const { recordedCount } = await recordBaseline({
      sql: lockedSql,
      files: baselineFiles,
    });
    logBaselineListing(baselineFiles, deps.log);
    deps.log(`baselined ${recordedCount} file(s)`);
    return 0;
  });
}

export async function runDbMigrate(args: DbMigrateArgs, deps: DbMigrateDeps): Promise<number> {
  const files = await listMigrationFiles(deps.migrationsDir);

  if (args.mode === 'status') {
    return runStatus(deps, files, args.json);
  }
  if (args.mode === 'baseline') {
    return runBaseline(args, deps, files);
  }
  return runApply(deps, files);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { databaseUrl, lockTimeout } = readDbMigrateEnv();
  const sql = postgres(databaseUrl);
  let exitCode = 1;

  try {
    exitCode = await runDbMigrate(args, {
      sql,
      migrationsDir: DEFAULT_MIGRATIONS_DIR,
      log: (line) => console.log(line),
      error: (line) => console.error(line),
      lockTimeout,
    });
  } finally {
    await sql.end();
  }

  process.exit(exitCode);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
