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
  phase?: MigrationPhase;
}

export interface LedgerRow {
  filename: string;
  checksum: string;
}

export const MIGRATION_PHASES = ['pre_roll', 'post_roll'] as const;
export type MigrationPhase = (typeof MIGRATION_PHASES)[number];

export const DEFAULT_MIGRATION_PHASE: MigrationPhase = 'pre_roll';

export interface MigrationPhaseMetadata {
  default: MigrationPhase;
  overrides: Readonly<Record<string, MigrationPhase>>;
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
const GENERAL_APP_RUNTIME_OWNER_BOUNDARY_MIGRATION =
  '054_general_app_runtime_owner_boundary.sql';
const UNIVERSAL_API_KEY_BACKFILL_BATCH_SIZE = 1_000;
const ONLINE_DDL_LOCK_TIMEOUT = '1s';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isMigrationPhase(value: unknown): value is MigrationPhase {
  return typeof value === 'string' && MIGRATION_PHASES.includes(value as MigrationPhase);
}

function phaseMetadataError(message: string): Error {
  return new Error(`Invalid migration phase metadata: ${message}`);
}

/**
 * Parse the checked-in db/migration-phases.json shape without tying callers to
 * filesystem access. This is also used by assembled-source deployment checks.
 */
export function parseMigrationPhaseMetadata(value: unknown): MigrationPhaseMetadata {
  if (!isRecord(value)) {
    throw phaseMetadataError('expected an object');
  }

  if (!isMigrationPhase(value['default'])) {
    throw phaseMetadataError(`default must be one of ${MIGRATION_PHASES.join(', ')}`);
  }
  if (!isRecord(value['overrides'])) {
    throw phaseMetadataError('overrides must be an object');
  }

  const overrides: Record<string, MigrationPhase> = {};
  for (const [filename, phase] of Object.entries(value['overrides'])) {
    if (!isMigrationPhase(phase)) {
      throw phaseMetadataError(
        `override for ${filename} must be one of ${MIGRATION_PHASES.join(', ')}`,
      );
    }
    overrides[filename] = phase;
  }

  return { default: value['default'], overrides };
}

export function defaultMigrationPhaseMetadata(): MigrationPhaseMetadata {
  return { default: DEFAULT_MIGRATION_PHASE, overrides: {} };
}

/**
 * Resolve every migration's phase and fail closed on stale override names.
 * Keeping this pure lets deployment assembly validate its merged SQL tree.
 */
export function resolveMigrationPhases(
  filenames: readonly string[],
  metadata: MigrationPhaseMetadata,
): Map<string, MigrationPhase> {
  const knownFilenames = new Set(filenames);
  for (const filename of Object.keys(metadata.overrides)) {
    if (!knownFilenames.has(filename)) {
      throw phaseMetadataError(`override references migration missing from disk: ${filename}`);
    }
  }

  return new Map(
    filenames.map((filename) => [filename, metadata.overrides[filename] ?? metadata.default]),
  );
}

export async function readMigrationPhaseMetadata(
  migrationsDir: string,
): Promise<MigrationPhaseMetadata> {
  const metadataPath = path.resolve(migrationsDir, '..', 'migration-phases.json');
  try {
    const content = await fs.readFile(metadataPath, 'utf8');
    return parseMigrationPhaseMetadata(JSON.parse(content) as unknown);
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === 'ENOENT') {
      return defaultMigrationPhaseMetadata();
    }
    if (error instanceof SyntaxError) {
      throw phaseMetadataError(`could not parse ${metadataPath}: ${error.message}`);
    }
    throw error;
  }
}

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
  const phaseByFilename = resolveMigrationPhases(
    filenames,
    await readMigrationPhaseMetadata(migrationsDir),
  );

  return Promise.all(
    filenames.map(async (filename) => {
      const content = await fs.readFile(path.join(migrationsDir, filename), 'utf8');
      const phase = phaseByFilename.get(filename);
      if (phase === undefined) {
        throw new Error(`Missing migration phase for ${filename}`);
      }
      return { filename, checksum: computeChecksum(content), content, phase };
    }),
  );
}

export function migrationFilesForPhase(
  files: MigrationFile[],
  phase: MigrationPhase,
): MigrationFile[] {
  return files.filter((file) => (file.phase ?? DEFAULT_MIGRATION_PHASE) === phase);
}

function pendingMigrationFiles(status: MigrationStatus, files: MigrationFile[]): MigrationFile[] {
  const filesByFilename = new Map(files.map((file) => [file.filename, file]));
  return status.pending.flatMap((filename) => {
    const file = filesByFilename.get(filename);
    if (file === undefined) {
      throw new Error(`Missing migration file metadata for ${filename}`);
    }
    return file;
  });
}

/**
 * Select work for a rollout stage without reordering numbered migrations.
 * pre_roll stops at the first pending post_roll marker; post_roll owns that
 * marker and its remaining pending suffix, including later default-pre files.
 */
export function pendingMigrationFilesForPhase(
  status: MigrationStatus,
  files: MigrationFile[],
  phase: MigrationPhase,
): MigrationFile[] {
  const pendingFiles = pendingMigrationFiles(status, files);
  const firstPostRoll = pendingFiles.findIndex(
    (file) => (file.phase ?? DEFAULT_MIGRATION_PHASE) === 'post_roll',
  );

  if (phase === 'pre_roll') {
    return firstPostRoll < 0 ? pendingFiles : pendingFiles.slice(0, firstPostRoll);
  }

  return firstPostRoll < 0 ? [] : pendingFiles.slice(firstPostRoll);
}

/**
 * A post-roll invocation must never skip a numbered pre-roll prefix. Once a
 * pending post-roll marker is reached, that invocation owns the full suffix.
 */
export function pendingPreRollBlockers(
  status: MigrationStatus,
  files: MigrationFile[],
): MigrationFile[] {
  const pendingFiles = pendingMigrationFiles(status, files);
  const firstPostRoll = pendingFiles.findIndex(
    (file) => (file.phase ?? DEFAULT_MIGRATION_PHASE) === 'post_roll',
  );
  return firstPostRoll < 0 ? [] : pendingFiles.slice(0, firstPostRoll);
}

/**
 * Scope ordinary pending/applied reporting to one rollout stage without
 * allowing global ledger drift or unknown rows to be hidden by that filter.
 */
export function statusForMigrationPhase(
  status: MigrationStatus,
  files: MigrationFile[],
  phase: MigrationPhase,
): MigrationStatus {
  const phaseFilenames = new Set(
    pendingMigrationFilesForPhase(status, files, phase).map((file) => file.filename),
  );
  const appliedPhaseFilenames = new Set(
    migrationFilesForPhase(files, phase).map((file) => file.filename),
  );
  const applied = status.applied.filter((filename) => appliedPhaseFilenames.has(filename));
  const pending = status.pending.filter((filename) => phaseFilenames.has(filename));

  if (status.state === 'untracked') {
    return { applied, pending, drift: [], unknown: [], state: 'untracked' };
  }
  if (status.drift.length > 0 || status.unknown.length > 0) {
    return {
      applied,
      pending,
      drift: status.drift,
      unknown: status.unknown,
      state: 'drift',
    };
  }

  return {
    applied,
    pending,
    drift: [],
    unknown: [],
    state: pending.length > 0 ? 'pending' : 'in_sync',
  };
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
  // Migration 054 transfers ownership of every legacy application relation.
  // Each ALTER OWNER needs ACCESS EXCLUSIVE, so fail fast instead of letting a
  // queued lock request stall new application reads for the default 30 seconds.
  return filename === UNIVERSAL_API_KEY_SCOPE_MIGRATION ||
    filename === GENERAL_APP_RUNTIME_OWNER_BOUNDARY_MIGRATION
    ? ONLINE_DDL_LOCK_TIMEOUT
    : undefined;
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

/**
 * Close the final rollback-backup race for migration 048.
 *
 * The bounded preparation deliberately commits between batches. A previous
 * release can therefore insert one last legacy-scope key after the final empty
 * batch. Take a write-conflicting lock in the migration transaction and sweep
 * those rows into the rollback table before the immutable migration SQL runs
 * its final UPDATE.
 */
export async function finalizeOnlineMigration(tx: MigrateTx, filename: string): Promise<void> {
  if (filename !== UNIVERSAL_API_KEY_SCOPE_MIGRATION) return;

  await tx.unsafe(`LOCK TABLE api_keys IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO _048_api_keys_scope_backup (key_id, scope)
SELECT key_id, scope
FROM api_keys
WHERE scope <> 'universal'
ON CONFLICT (key_id) DO NOTHING;`);
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
  phase?: MigrationPhase;
  lockTimeout?: string;
  log?: (line: string) => void;
}): Promise<{ appliedCount: number }> {
  const lockTimeout = opts.lockTimeout ?? '30s';
  const status = computeStatus(opts.files, opts.ledger);
  const filesByFilename = new Map(opts.files.map((file) => [file.filename, file]));
  const pending =
    opts.phase === undefined
      ? status.pending
      : pendingMigrationFilesForPhase(status, opts.files, opts.phase).map((file) => file.filename);
  let appliedCount = 0;

  for (const filename of pending) {
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
        await finalizeOnlineMigration(tx, file.filename);
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
