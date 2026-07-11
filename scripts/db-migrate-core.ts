import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface MigrateTx {
  unsafe(query: string, params?: unknown[]): Promise<unknown>;
}

export interface MigrateSqlClient {
  begin<T>(fn: (tx: MigrateTx) => Promise<T>): Promise<T>;
  unsafe(query: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;
  end(): Promise<void>;
}

type RawReservedMigrateSqlClient = {
  begin?: MigrateSqlClient['begin'];
  unsafe: MigrateSqlClient['unsafe'];
  end?: MigrateSqlClient['end'];
  release?: () => void | Promise<void>;
};

type ReservedMigrateSqlClient = MigrateSqlClient & {
  release: () => Promise<void>;
};

type ReservableMigrateSqlClient = MigrateSqlClient & {
  reserve: () => Promise<RawReservedMigrateSqlClient>;
};

export interface MigrationFile {
  filename: string;
  checksum: string;
  content: string;
}

export interface LedgerRow {
  filename: string;
  checksum: string;
}

export type MigrationState = 'in_sync' | 'pending' | 'drift' | 'untracked';

export interface MigrationStatus {
  applied: string[];
  pending: string[];
  drift: Array<{ filename: string; ledgerChecksum: string; fileChecksum: string }>;
  unknown: string[];
  state: MigrationState;
}

export class MigrationApplyError extends Error {
  readonly filename: string;

  constructor(filename: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to apply migration ${filename}: ${message}`, { cause });
    this.name = 'MigrationApplyError';
    this.filename = filename;
  }
}

const MIGRATION_ADVISORY_LOCK_ARGS = [1887001718, 1835624306];
const UNIVERSAL_API_KEY_SCOPE_MIGRATION = '048_universal_api_key_scope.sql';
const UNIVERSAL_API_KEY_BACKFILL_BATCH_SIZE = 1_000;
const ONLINE_DDL_LOCK_TIMEOUT = '1s';

function reservableClient(sql: MigrateSqlClient): ReservableMigrateSqlClient | null {
  const candidate = sql as MigrateSqlClient & { reserve?: unknown };
  return typeof candidate.reserve === 'function' ? (candidate as ReservableMigrateSqlClient) : null;
}

async function reserveClient(sql: MigrateSqlClient): Promise<{
  sql: MigrateSqlClient;
  release: () => Promise<void>;
}> {
  const reservable = reservableClient(sql);
  if (!reservable) {
    return { sql, release: async () => undefined };
  }

  const reserved = await reservable.reserve();
  const reservedSql = clientFromReserved(reserved);
  return {
    sql: reservedSql,
    release: reservedSql.release,
  };
}

function clientFromReserved(reserved: RawReservedMigrateSqlClient): ReservedMigrateSqlClient {
  return {
    unsafe: (query, params) => reserved.unsafe(query, params),
    begin:
      typeof reserved.begin === 'function'
        ? (fn) => reserved.begin!(fn)
        : (fn) => beginOnReserved(reserved, fn),
    end: async () => {
      await reserved.end?.();
    },
    release: async () => {
      await reserved.release?.();
    },
  };
}

async function beginOnReserved<T>(
  reserved: RawReservedMigrateSqlClient,
  fn: (tx: MigrateTx) => Promise<T>,
): Promise<T> {
  await reserved.unsafe('BEGIN');
  try {
    const result = await fn({
      unsafe: (query, params) => reserved.unsafe(query, params),
    });
    await reserved.unsafe('COMMIT');
    return result;
  } catch (error) {
    try {
      await reserved.unsafe('ROLLBACK');
    } catch {
      // Preserve the original migration failure.
    }
    throw error;
  }
}

export async function withMigrationAdvisoryLock<T>(
  sql: MigrateSqlClient,
  fn: (lockedSql: MigrateSqlClient) => Promise<T>,
): Promise<T> {
  const reserved = await reserveClient(sql);
  let acquired = false;
  let originalError: unknown;

  try {
    await reserved.sql.unsafe('SELECT pg_advisory_lock($1, $2)', MIGRATION_ADVISORY_LOCK_ARGS);
    acquired = true;
    return await fn(reserved.sql);
  } catch (error) {
    originalError = error;
    throw error;
  } finally {
    let cleanupError: unknown;
    try {
      if (acquired) {
        await reserved.sql.unsafe(
          'SELECT pg_advisory_unlock($1, $2)',
          MIGRATION_ADVISORY_LOCK_ARGS,
        );
      }
    } catch (error) {
      cleanupError = error;
    }

    try {
      await reserved.release();
    } catch (error) {
      cleanupError ??= error;
    }

    if (cleanupError !== undefined && originalError === undefined) {
      throw cleanupError;
    }
  }
}

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new Error(`Expected ${key} to be a string in schema_migrations row`);
  }
  return value;
}

function hasRegclass(rows: Array<Record<string, unknown>>): boolean {
  const regclass = rows[0]?.['regclass'];
  return regclass !== null && regclass !== undefined;
}

function compareFilename(a: { filename: string }, b: { filename: string }): number {
  return a.filename.localeCompare(b.filename);
}

export function computeChecksum(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function migrationHead(files: Array<{ filename: string }>): string | null {
  return files.at(-1)?.filename ?? null;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function logDrift(status: MigrationStatus, error: (line: string) => void): void {
  error('migration ledger drift detected; refusing to apply');
  for (const item of status.drift) {
    error(`${item.filename}: ledger=${item.ledgerChecksum} file=${item.fileChecksum}`);
  }
  for (const filename of status.unknown) {
    error(`${filename}: recorded in schema_migrations but missing on disk`);
  }
}

export async function listMigrationFiles(migrationsDir: string): Promise<MigrationFile[]> {
  const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
  const filenames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();

  return Promise.all(
    filenames.map(async (filename) => {
      const content = await fs.readFile(path.join(migrationsDir, filename), 'utf8');
      return { filename, checksum: computeChecksum(content), content };
    }),
  );
}

export async function ledgerExists(sql: MigrateSqlClient): Promise<boolean> {
  const rows = await sql.unsafe(`SELECT to_regclass('public.schema_migrations') AS regclass`);
  return hasRegclass(rows);
}

export async function ensureLedger(sql: MigrateSqlClient): Promise<void> {
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS schema_migrations (
  filename          TEXT PRIMARY KEY,
  checksum          TEXT NOT NULL,
  applied_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  execution_time_ms INTEGER NOT NULL,
  applied_by        TEXT NOT NULL
)`);
}

export async function readLedger(sql: MigrateSqlClient): Promise<LedgerRow[]> {
  const rows = await sql.unsafe(
    `SELECT filename, checksum FROM schema_migrations ORDER BY filename`,
  );
  return rows.map((row) => ({
    filename: stringField(row, 'filename'),
    checksum: stringField(row, 'checksum'),
  }));
}

export async function buildersTableExists(sql: MigrateSqlClient): Promise<boolean> {
  const rows = await sql.unsafe(`SELECT to_regclass('public.builders') AS regclass`);
  return hasRegclass(rows);
}

function backfillCount(row: Record<string, unknown> | undefined): number {
  const value = row?.['updated_count'];
  const count = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('Expected universal API key backfill to return a non-negative row count');
  }
  return count;
}

export function onlineMigrationLockTimeout(filename: string): string | undefined {
  return filename === UNIVERSAL_API_KEY_SCOPE_MIGRATION ? ONLINE_DDL_LOCK_TIMEOUT : undefined;
}

/**
 * Prepare migration 048 without holding its ACCESS EXCLUSIVE lock through the
 * backup scan and full-table backfill. The migration file and checksum stay
 * immutable for databases that already recorded it.
 */
export async function prepareOnlineMigration(opts: {
  sql: MigrateSqlClient;
  filename: string;
  lockTimeout?: string;
}): Promise<void> {
  if (opts.filename !== UNIVERSAL_API_KEY_SCOPE_MIGRATION) return;

  const lockTimeout = opts.lockTimeout ?? '30s';
  const ddlLockTimeout = onlineMigrationLockTimeout(opts.filename)!;

  // Scan and preserve rollback data before taking the brief catalog lock.
  // Fail fast if the catalog lock is busy so a queued ACCESS EXCLUSIVE request
  // cannot stall new authentication reads for the runner's default 30 seconds.
  await opts.sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL lock_timeout = '${ddlLockTimeout}'`);
    await tx.unsafe(`CREATE TABLE IF NOT EXISTS _048_api_keys_scope_backup AS
  SELECT key_id, scope FROM api_keys WHERE scope <> 'universal';

CREATE UNIQUE INDEX IF NOT EXISTS idx_048_api_keys_scope_backup_key_id
  ON _048_api_keys_scope_backup(key_id);

ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_scope_check;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_scope_check
  CHECK (scope IN ('agent_sdk', 'admin_api', 'data_import', 'universal')) NOT VALID;`);
  });

  // VALIDATE takes SHARE UPDATE EXCLUSIVE, which permits ordinary reads and
  // writes. Keep it out of the transaction that changed the constraint.
  await opts.sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL lock_timeout = '${lockTimeout}'`);
    await tx.unsafe(`ALTER TABLE api_keys VALIDATE CONSTRAINT api_keys_scope_check;`);
  });

  // Backfill through the key_id index so each transaction locks and writes at
  // most one bounded batch. The original migration catches a rare concurrent
  // insert after the final batch before recording the immutable checksum.
  let cursor = '';
  while (true) {
    const rows = await opts.sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL lock_timeout = '${lockTimeout}'`);
      return tx.unsafe(
        `WITH batch AS (
  SELECT key_id, scope
  FROM api_keys
  WHERE key_id > $1
    AND scope <> 'universal'
  ORDER BY key_id
  LIMIT $2
  FOR UPDATE
), backed_up AS (
  INSERT INTO _048_api_keys_scope_backup (key_id, scope)
  SELECT key_id, scope FROM batch
  ON CONFLICT (key_id) DO NOTHING
), updated AS (
  UPDATE api_keys AS keys
  SET scope = 'universal'
  FROM batch
  WHERE keys.key_id = batch.key_id
  RETURNING keys.key_id
)
SELECT count(*)::int AS updated_count, max(key_id) AS last_key_id
FROM updated`,
        [cursor, UNIVERSAL_API_KEY_BACKFILL_BATCH_SIZE],
      ) as Promise<Array<Record<string, unknown>>>;
    });

    const count = backfillCount(rows[0]);
    if (count === 0) break;

    const lastKeyId = rows[0]?.['last_key_id'];
    if (typeof lastKeyId !== 'string' || lastKeyId.length === 0) {
      throw new Error('Expected universal API key backfill to return its last key_id');
    }
    cursor = lastKeyId;
  }
}

export function computeStatus(files: MigrationFile[], ledger: LedgerRow[] | null): MigrationStatus {
  const sortedFiles = [...files].sort(compareFilename);

  if (ledger === null) {
    return {
      applied: [],
      pending: sortedFiles.map((file) => file.filename),
      drift: [],
      unknown: [],
      state: 'untracked',
    };
  }

  const sortedLedger = [...ledger].sort(compareFilename);
  const filesByFilename = new Map(sortedFiles.map((file) => [file.filename, file]));
  const ledgerByFilename = new Map(sortedLedger.map((row) => [row.filename, row]));
  const applied: string[] = [];
  const drift: MigrationStatus['drift'] = [];
  const unknown: string[] = [];

  for (const row of sortedLedger) {
    const file = filesByFilename.get(row.filename);
    if (!file) {
      unknown.push(row.filename);
      continue;
    }
    if (file.checksum !== row.checksum) {
      drift.push({
        filename: row.filename,
        ledgerChecksum: row.checksum,
        fileChecksum: file.checksum,
      });
      continue;
    }
    applied.push(row.filename);
  }

  const pending = sortedFiles
    .filter((file) => !ledgerByFilename.has(file.filename))
    .map((file) => file.filename);

  const state =
    drift.length > 0 || unknown.length > 0 ? 'drift' : pending.length > 0 ? 'pending' : 'in_sync';

  return { applied, pending, drift, unknown, state };
}

export async function applyPending(opts: {
  sql: MigrateSqlClient;
  files: MigrationFile[];
  ledger: LedgerRow[];
  appliedBy: 'db:migrate' | 'db:setup';
  lockTimeout?: string;
  log?: (line: string) => void;
}): Promise<{ appliedCount: number }> {
  const lockTimeout = opts.lockTimeout ?? '30s';
  const status = computeStatus(opts.files, opts.ledger);
  const filesByFilename = new Map(opts.files.map((file) => [file.filename, file]));
  let appliedCount = 0;

  for (const filename of status.pending) {
    const file = filesByFilename.get(filename);
    if (!file) {
      throw new Error(`Missing migration file metadata for ${filename}`);
    }

    let elapsedMs = 0;
    try {
      const startedAt = Date.now();
      await prepareOnlineMigration({
        sql: opts.sql,
        filename: file.filename,
        lockTimeout,
      });
      await opts.sql.begin(async (tx) => {
        const fileLockTimeout = onlineMigrationLockTimeout(file.filename) ?? lockTimeout;
        await tx.unsafe(`SET LOCAL lock_timeout = '${fileLockTimeout}'`);
        await tx.unsafe(file.content);
        elapsedMs = Date.now() - startedAt;
        await tx.unsafe(
          `INSERT INTO schema_migrations (filename, checksum, execution_time_ms, applied_by)
VALUES ($1, $2, $3, $4)`,
          [file.filename, file.checksum, elapsedMs, opts.appliedBy],
        );
      });
    } catch (error) {
      throw new MigrationApplyError(file.filename, error);
    }

    appliedCount += 1;
    opts.log?.(`✓ ${file.filename} (${elapsedMs}ms)`);
  }

  return { appliedCount };
}

export async function recordBaseline(opts: {
  sql: MigrateSqlClient;
  files: MigrationFile[];
  log?: (line: string) => void;
}): Promise<{ recordedCount: number }> {
  await opts.sql.begin(async (tx) => {
    for (const file of opts.files) {
      await tx.unsafe(
        `INSERT INTO schema_migrations (filename, checksum, execution_time_ms, applied_by)
VALUES ($1, $2, $3, $4)`,
        [file.filename, file.checksum, 0, 'baseline'],
      );
    }
  });

  return { recordedCount: opts.files.length };
}
