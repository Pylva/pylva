// Database setup — runs PostgreSQL migrations + ClickHouse DDL
// Empty database: pnpm db:setup --fresh-install
// Data-bearing upgrade: use the receipt-backed, phased pnpm db:migrate workflow.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { createClient } from '@clickhouse/client';
import { splitClickHouseStatements } from './clickhouse-statements.js';
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
  prepareFreshInstallLedger,
  readLedger,
  type LedgerRow,
  type MigrateSqlClient,
  withMigrationAdvisoryLock,
} from '../scripts/db-migrate-core.js';
import { parseMigrationDatabaseEnv } from '../scripts/migration-database-env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface DbSetupArgs {
  freshInstall: boolean;
}

export function parseSetupArgs(argv: string[]): DbSetupArgs {
  let freshInstall = false;
  for (const arg of argv) {
    if (arg !== '--fresh-install') {
      throw new Error(`Unknown db:setup argument: ${arg}`);
    }
    if (freshInstall) {
      throw new Error('--fresh-install can only be specified once');
    }
    freshInstall = true;
  }
  return { freshInstall };
}

// Returns whether to skip ClickHouse DDL: SKIP_CLICKHOUSE=true OR an RFC 6761
// `.invalid` host (a known-unreachable placeholder; never resolves via DNS).
export function shouldSkipClickhouse(
  env: Record<string, string | undefined>,
  url: string,
): { skip: boolean; reason?: string } {
  if (env['SKIP_CLICKHOUSE'] === 'true') {
    return { skip: true, reason: 'SKIP_CLICKHOUSE=true' };
  }
  try {
    const hostname = new URL(url).hostname;
    if (hostname.endsWith('.invalid')) {
      return { skip: true, reason: `CLICKHOUSE_URL host ${hostname} is RFC 6761 reserved` };
    }
  } catch {
    // Malformed URL — fall through; the client init will surface a clear error
    // rather than silently skipping.
  }
  return { skip: false };
}

export function shouldSkipPostgres(env: Record<string, string | undefined>): {
  skip: boolean;
  reason?: string;
} {
  if (env['SKIP_POSTGRES'] === 'true') {
    return { skip: true, reason: 'SKIP_POSTGRES=true' };
  }
  return { skip: false };
}

export function isMainModule(importMetaUrl: string, argvPath: string | undefined): boolean {
  return argvPath !== undefined && importMetaUrl === pathToFileURL(argvPath).href;
}

export interface PostgresSetupDeps {
  sql: MigrateSqlClient;
  migrationsDir: string;
  log: (line: string) => void;
  error: (line: string) => void;
}

export async function runPostgresSetupMigrations(
  args: DbSetupArgs,
  deps: PostgresSetupDeps,
): Promise<number> {
  let exitCode = 0;

  try {
    await withMigrationAdvisoryLock(deps.sql, async (lockedSql) => {
      const hasLedger = await ledgerExists(lockedSql);
      if (!hasLedger && (await buildersTableExists(lockedSql))) {
        deps.error(
          'database predates migration tracking; inspect the physical schema, then run pnpm db:migrate --baseline --through <verified-historical-head-before-056> --yes',
        );
        exitCode = 1;
        return;
      }

      const files = await listMigrationFiles(deps.migrationsDir);
      let freshInstallAuthorized = false;
      let ledger: LedgerRow[];
      if (args.freshInstall) {
        const preparation = await prepareFreshInstallLedger(lockedSql, files, hasLedger);
        if (!preparation.authorized) {
          deps.error(`refusing fresh-install migration mode: ${preparation.error}`);
          exitCode = 1;
          return;
        }
        ledger = preparation.ledger;
        freshInstallAuthorized = true;
      } else {
        await ensureLedger(lockedSql);
        ledger = await readLedger(lockedSql);
      }

      const status = computeStatus(files, ledger);
      if (status.drift.length > 0 || status.unknown.length > 0) {
        logDrift(status, deps.error);
        exitCode = 1;
        return;
      }

      const { appliedCount } = await applyPending({
        sql: lockedSql,
        files,
        ledger,
        appliedBy: 'db:setup',
        removeFreePolicy: {
          approvals: { expand: false, contract: false },
          freshInstallAuthorized,
        },
        log: deps.log,
      });
      const headFile = migrationHead(files) ?? '(none)';
      if (appliedCount === 0) {
        deps.log(`0 pending — schema at head ${headFile}`);
      } else {
        deps.log(`applied ${appliedCount} migration(s); head: ${headFile}`);
      }
    });
  } catch (error) {
    if (!(error instanceof MigrationApplyError)) {
      throw error;
    }
    deps.error(`failed to apply ${error.filename}: ${errorMessage(error.cause)}`);
    exitCode = 1;
  }

  return exitCode;
}

function ownStringProperty(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    return undefined;
  }
  const property = (value as Record<string, unknown>)[key];
  return typeof property === 'string' ? property : undefined;
}

function isCannotAssignAlter(error: unknown): boolean {
  return (
    ownStringProperty(error, 'code') === '517' ||
    ownStringProperty(error, 'type') === 'CANNOT_ASSIGN_ALTER'
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function commandWithClickHouseRetry(
  run: () => Promise<unknown>,
  opts?: {
    attempts?: number;
    baseDelayMs?: number;
    log?: (line: string) => void;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<void> {
  const attempts = opts?.attempts ?? 5;
  const baseDelayMs = opts?.baseDelayMs ?? 3000;
  const sleep = opts?.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await run();
      return;
    } catch (error) {
      if (!isCannotAssignAlter(error) || attempt >= attempts) {
        throw error;
      }

      const nextAttempt = attempt + 1;
      opts?.log?.(`retrying after CANNOT_ASSIGN_ALTER (attempt ${nextAttempt}/${attempts})`);
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
}

async function setup(args: DbSetupArgs) {
  const clickhouseUrl = process.env['CLICKHOUSE_URL'] ?? 'http://localhost:8123';

  // --- PostgreSQL Migrations ---
  const skipPg = shouldSkipPostgres(process.env);
  if (skipPg.skip) {
    console.log(`[PostgreSQL] SKIPPED — ${skipPg.reason}.\n`);
  } else {
    console.log('Running PostgreSQL migrations...');
    const { databaseUrl } = parseMigrationDatabaseEnv(process.env);
    const sql = postgres(databaseUrl);
    const migrationsDir = path.join(__dirname, 'migrations');
    let exitCode: number;

    try {
      exitCode = await runPostgresSetupMigrations(args, {
        sql,
        migrationsDir,
        log: console.log,
        error: console.error,
      });
    } finally {
      await sql.end();
    }

    if (exitCode !== 0) {
      process.exit(exitCode);
    }

    console.log('PostgreSQL migrations complete.\n');
  }

  // --- ClickHouse DDL ---
  const skip = shouldSkipClickhouse(process.env, clickhouseUrl);
  if (skip.skip) {
    console.log(
      `[ClickHouse] SKIPPED — ${skip.reason} (set CLICKHOUSE_URL and unset SKIP_CLICKHOUSE to enable).\n`,
    );
  } else {
    console.log('Running ClickHouse DDL...');
    const ch = createClient({ url: clickhouseUrl });

    const chDir = path.join(__dirname, 'clickhouse');
    const chFiles = fs
      .readdirSync(chDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of chFiles) {
      const filePath = path.join(chDir, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const statements = splitClickHouseStatements(content);

      console.log(`  Running ${file} (${statements.length} statements)...`);
      for (const stmt of statements) {
        await commandWithClickHouseRetry(
          () => ch.command({ query: stmt.endsWith(';') ? stmt : stmt + ';' }),
          { log: console.log },
        );
      }
      console.log(`  ✓ ${file}`);
    }

    await ch.close();
    console.log('ClickHouse DDL complete.\n');
  }

  console.log('Database setup finished.');
}

// Run setup only when invoked as a script (not when imported by tests).
if (isMainModule(import.meta.url, process.argv[1])) {
  setup(parseSetupArgs(process.argv.slice(2))).catch((err) => {
    console.error('Setup failed:', err);
    process.exit(1);
  });
}
