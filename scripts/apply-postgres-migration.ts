// Apply one reviewed Postgres migration file to an existing database.
// This is for targeted production remediation; fresh DB bootstrap still uses
// `pnpm db:setup`, which applies the full migration directory.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { readApplyMigrationEnv } from './apply-postgres-migration-env.js';
import {
  buildersTableExists,
  computeChecksum,
  ensureLedger,
  ledgerExists,
  onlineMigrationLockTimeout,
  prepareOnlineMigration,
  withMigrationAdvisoryLock,
} from './db-migrate-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIR = path.resolve(__dirname, '..');
const USAGE = 'Usage: pnpm db:apply:migration -- [--force] db/migrations/<file>.sql';

export interface MigrationSqlClient {
  unsafe(query: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;
  begin<T>(
    fn: (tx: { unsafe(query: string, params?: unknown[]): Promise<unknown> }) => Promise<T>,
  ): Promise<T>;
  end(): Promise<void>;
}

export interface ApplyPostgresMigrationOptions {
  migrationPath: string;
  databaseUrl?: string;
  rootDir?: string;
  sqlClient?: MigrationSqlClient;
  force?: boolean;
}

interface ApplyPostgresMigrationCliArgs {
  migrationPath: string;
  force: boolean;
}

export function isMainModule(importMetaUrl: string, argvPath: string | undefined): boolean {
  return argvPath !== undefined && importMetaUrl === pathToFileURL(argvPath).href;
}

export function resolveMigrationPath(
  migrationPath: string,
  rootDir = DEFAULT_ROOT_DIR,
): { absolutePath: string; relativePath: string } {
  if (!migrationPath) {
    throw new Error(USAGE);
  }

  const migrationsDir = path.resolve(rootDir, 'db/migrations');
  const absolutePath = path.resolve(rootDir, migrationPath);
  const relativeToMigrations = path.relative(migrationsDir, absolutePath);

  if (relativeToMigrations.startsWith('..') || path.isAbsolute(relativeToMigrations)) {
    throw new Error(`Refusing to apply migration outside db/migrations: ${migrationPath}`);
  }
  if (!absolutePath.endsWith('.sql')) {
    throw new Error(`Refusing to apply non-SQL migration: ${migrationPath}`);
  }

  return {
    absolutePath,
    relativePath: path.relative(rootDir, absolutePath),
  };
}

export function parseApplyPostgresMigrationArgs(argv: string[]): ApplyPostgresMigrationCliArgs {
  let force = false;
  const positional: string[] = [];

  for (const arg of argv) {
    if (arg === '--force') {
      force = true;
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 1) {
    throw new Error(USAGE);
  }

  return { migrationPath: positional[0] ?? '', force };
}

export async function applyPostgresMigration(
  options: ApplyPostgresMigrationOptions,
): Promise<{ relativePath: string }> {
  const rootDir = options.rootDir ?? DEFAULT_ROOT_DIR;
  const { absolutePath, relativePath } = resolveMigrationPath(options.migrationPath, rootDir);
  if (!options.sqlClient && !options.databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required when no sqlClient is provided');
  }
  const content = await fs.readFile(absolutePath, 'utf8');
  const client = options.sqlClient ?? postgres(options.databaseUrl!);
  const filename = path.basename(relativePath);

  try {
    await withMigrationAdvisoryLock(client, async (lockedClient) => {
      const hasLedger = await ledgerExists(lockedClient);
      if (!hasLedger && (await buildersTableExists(lockedClient))) {
        throw new Error(
          'database predates migration tracking; run pnpm db:migrate --baseline --yes once before applying manual migrations',
        );
      }

      await ensureLedger(lockedClient);
      const existingRows = await lockedClient.unsafe(
        `SELECT filename FROM schema_migrations WHERE filename = $1`,
        [filename],
      );
      if (existingRows.length > 0 && !options.force) {
        throw new Error(
          `Refusing to re-apply ${filename}: already recorded in schema_migrations (use --force)`,
        );
      }

      try {
        const checksum = computeChecksum(content);
        let elapsedMs = 0;
        const startedAt = Date.now();
        await prepareOnlineMigration({ sql: lockedClient, filename });
        await lockedClient.begin(async (tx) => {
          const lockTimeout = onlineMigrationLockTimeout(filename);
          if (lockTimeout !== undefined) {
            await tx.unsafe(`SET LOCAL lock_timeout = '${lockTimeout}'`);
          }
          await tx.unsafe(content);
          elapsedMs = Date.now() - startedAt;
          await tx.unsafe(
            `INSERT INTO schema_migrations (filename, checksum, execution_time_ms, applied_by)
VALUES ($1, $2, $3, 'db:apply:migration')
ON CONFLICT (filename) DO UPDATE SET
  checksum = EXCLUDED.checksum,
  applied_at = NOW(),
  execution_time_ms = EXCLUDED.execution_time_ms,
  applied_by = EXCLUDED.applied_by`,
            [filename, checksum, elapsedMs],
          );
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to apply migration ${relativePath}: ${message}`, { cause: error });
      }
    });

    return { relativePath };
  } finally {
    if (!options.sqlClient) {
      await client.end();
    }
  }
}

async function main(): Promise<void> {
  const { migrationPath, force } = parseApplyPostgresMigrationArgs(process.argv.slice(2));
  const { databaseUrl } = readApplyMigrationEnv();
  const { relativePath } = await applyPostgresMigration({ migrationPath, databaseUrl, force });
  console.log(`Applied ${relativePath}`);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
