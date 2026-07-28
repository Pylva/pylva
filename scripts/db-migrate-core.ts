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
const GENERAL_APP_RUNTIME_OWNER_BOUNDARY_MIGRATION = '054_general_app_runtime_owner_boundary.sql';
const WORKSPACE_ACCESS_STATE_EXPAND_MIGRATION = '056_workspace_access_state_expand.sql';
const REMOVE_FREE_PLAN_CONTRACT_MIGRATION = '058_remove_free_plan_contract.sql';
const UNIVERSAL_API_KEY_BACKFILL_BATCH_SIZE = 1_000;
const ONLINE_DDL_LOCK_TIMEOUT = '1s';
export const REMOVE_FREE_FRESH_INSTALL_GUC = 'pylva.remove_free_fresh_install';
const REMOVE_FREE_EXPAND_MIGRATIONS = new Set([
  WORKSPACE_ACCESS_STATE_EXPAND_MIGRATION,
  '057_hosted_workspace_entitlements.sql',
]);
const REMOVE_FREE_CONTRACT_MIGRATIONS = new Set([
  REMOVE_FREE_PLAN_CONTRACT_MIGRATION,
  '059_hosted_remove_free_contract.sql',
]);
const REMOVE_FREE_RESERVED_PREFIX = /^(056|057|058|059)_/;

export interface RemoveFreeMigrationApprovals {
  expand: boolean;
  contract: boolean;
}

export interface RemoveFreeMigrationPolicy {
  approvals: RemoveFreeMigrationApprovals;
  phase?: MigrationPhase;
  /**
   * This is not the CLI flag by itself. Callers may set it only after proving,
   * under the migration advisory lock, that the database contains no builder
   * rows and that its ledger is a clean contiguous manifest prefix.
   */
  freshInstallAuthorized: boolean;
}

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

export function isRemoveFreeReservedMigration(filename: string): boolean {
  return REMOVE_FREE_RESERVED_PREFIX.test(filename);
}

/**
 * The remove-Free migrations are intentionally split into two independently
 * approved deployment windows. Normal upgrades must select exactly one window
 * with its matching phase. A caller may bypass that separation only after it
 * has independently authorized a truly empty fresh installation.
 */
export function removeFreeApprovalError(
  pendingFilenames: string[],
  approvals: RemoveFreeMigrationApprovals,
  opts?: { phase?: MigrationPhase; freshInstallAuthorized?: boolean },
): string | null {
  const unknownReservedMigration = pendingFilenames.find(
    (filename) =>
      isRemoveFreeReservedMigration(filename) &&
      !REMOVE_FREE_EXPAND_MIGRATIONS.has(filename) &&
      !REMOVE_FREE_CONTRACT_MIGRATIONS.has(filename),
  );
  if (unknownReservedMigration !== undefined) {
    return `unrecognized remove-Free migration in reserved rollout window: ${unknownReservedMigration}`;
  }

  const needsExpandApproval = pendingFilenames.some((filename) =>
    REMOVE_FREE_EXPAND_MIGRATIONS.has(filename),
  );
  const needsContractApproval = pendingFilenames.some((filename) =>
    REMOVE_FREE_CONTRACT_MIGRATIONS.has(filename),
  );

  if (opts?.freshInstallAuthorized === true) {
    if (opts.phase !== undefined) {
      return '--fresh-install cannot be combined with a phased migration run';
    }
    if (approvals.expand || approvals.contract) {
      return '--fresh-install cannot be combined with remove-Free rollout approval flags';
    }
    return null;
  }

  if (needsExpandApproval && needsContractApproval) {
    return (
      'remove-Free expand and contract migrations cannot run in one upgrade invocation; ' +
      'apply the expand window with --phase pre_roll, drain old writers, then apply the ' +
      'contract window in a separate --phase post_roll invocation'
    );
  }

  if (needsExpandApproval && opts?.phase !== 'pre_roll') {
    return 'remove-Free expand migrations require an explicit --phase pre_roll invocation';
  }
  if (needsContractApproval && opts?.phase !== 'post_roll') {
    return 'remove-Free contract migrations require an explicit --phase post_roll invocation';
  }
  if (needsExpandApproval && !approvals.expand) {
    return (
      'remove-Free expand migrations are pending; verify the expand preflight artifact, then ' +
      'rerun with --phase pre_roll --approve-remove-free-expand'
    );
  }
  if (needsContractApproval && !approvals.contract) {
    return (
      'remove-Free contract migrations are pending; verify the post-roll zero-Free/no-writer ' +
      'artifact, then rerun with --phase post_roll --approve-remove-free-contract'
    );
  }
  if (approvals.expand && !needsExpandApproval) {
    return (
      '--approve-remove-free-expand was supplied, but no exact remove-Free expand migration ' +
      'is pending in the selected apply set'
    );
  }
  if (approvals.contract && !needsContractApproval) {
    return (
      '--approve-remove-free-contract was supplied, but no exact remove-Free contract migration ' +
      'is pending in the selected apply set'
    );
  }
  return null;
}

/**
 * A fresh-install retry may have already committed an initial migration
 * prefix. It is safe to resume only when there are no customer workspaces and
 * the ledger contains exactly a prefix of the checked-in manifest.
 */
export function freshInstallStateError(
  files: Array<{ filename: string }>,
  ledger: LedgerRow[],
  builderRowsExist: boolean,
): string | null {
  if (builderRowsExist) {
    return '--fresh-install requires zero rows in builders';
  }

  const applied = new Set(ledger.map((row) => row.filename));
  let encounteredMissing = false;
  for (const file of [...files].sort(compareFilename)) {
    if (!applied.has(file.filename)) {
      encounteredMissing = true;
      continue;
    }
    if (encounteredMissing) {
      return (
        '--fresh-install requires schema_migrations to be a contiguous manifest prefix; ' +
        `found applied migration after a gap: ${file.filename}`
      );
    }
  }
  return null;
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

  if (firstPostRoll < 0) {
    return [];
  }

  const postRollSuffix = pendingFiles.slice(firstPostRoll);
  const nextProtectedExpand = postRollSuffix.findIndex((file) =>
    REMOVE_FREE_EXPAND_MIGRATIONS.has(file.filename),
  );
  // A database upgrading from an older post-roll boundary (for example 048)
  // must be able to reach the schema immediately before remove-Free without
  // accidentally entering its independently approved expand window. Ordinary
  // post-roll behavior still owns the full suffix; only the protected 056/057
  // boundary truncates it.
  return nextProtectedExpand <= 0 ? postRollSuffix : postRollSuffix.slice(0, nextProtectedExpand);
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

export async function buildersContainRows(sql: MigrateSqlClient): Promise<boolean> {
  if (!(await buildersTableExists(sql))) {
    return false;
  }
  const rows = await sql.unsafe(`SELECT EXISTS (SELECT 1 FROM builders LIMIT 1) AS has_builders`);
  const value = rows[0]?.['has_builders'];
  if (typeof value !== 'boolean') {
    throw new Error('Expected builders existence probe to return a boolean');
  }
  return value;
}

export async function freshInstallPrincipalError(
  sql: MigrateSqlClient,
): Promise<string | null> {
  const rows = await sql.unsafe(`
SELECT current_user::text AS current_user_name,
       session_user::text AS session_user_name,
       role.rolcanlogin AS can_login,
       role.rolcreaterole AS can_create_role,
       role.rolsuper AS is_superuser,
       role.rolbypassrls AS bypasses_rls,
       role.rolreplication AS can_replicate,
       (database.datdba = role.oid) AS owns_current_database
FROM pg_catalog.pg_roles AS role
JOIN pg_catalog.pg_database AS database
  ON database.datname = current_database()
WHERE role.rolname = current_user`);
  const row = rows[0];
  if (!row) {
    return '--fresh-install could not attest the migration principal';
  }

  const currentUser = row['current_user_name'];
  const sessionUser = row['session_user_name'];
  const booleanFields = [
    'can_login',
    'can_create_role',
    'is_superuser',
    'bypasses_rls',
    'can_replicate',
    'owns_current_database',
  ] as const;
  if (
    typeof currentUser !== 'string' ||
    typeof sessionUser !== 'string' ||
    booleanFields.some((field) => typeof row[field] !== 'boolean')
  ) {
    throw new Error('Fresh-install migration-principal attestation returned malformed data');
  }

  const failures: string[] = [];
  if (currentUser !== sessionUser) failures.push('current_user must equal session_user');
  if (row['can_login'] !== true) failures.push('principal must be LOGIN');
  if (row['can_create_role'] !== true) failures.push('principal must have CREATEROLE');
  if (row['is_superuser'] !== false) failures.push('principal must be NOSUPERUSER');
  if (row['bypasses_rls'] !== false) failures.push('principal must be NOBYPASSRLS');
  if (row['can_replicate'] !== false) failures.push('principal must be NOREPLICATION');
  if (row['owns_current_database'] !== true) {
    failures.push('principal must own current_database()');
  }
  return failures.length === 0
    ? null
    : `--fresh-install migration principal is unsafe: ${failures.join('; ')}`;
}

export type FreshInstallLedgerPreparation =
  | {
      authorized: true;
      ledger: LedgerRow[];
    }
  | {
      authorized: false;
      error: string;
    };

/**
 * Prove a fresh install is both empty and running as the deliberately scoped
 * migration owner before creating the migration ledger. Keeping this shared
 * prevents db:migrate and db:setup from drifting into different bootstrap
 * safety postures.
 */
export async function prepareFreshInstallLedger(
  sql: MigrateSqlClient,
  files: Array<{ filename: string }>,
  hasLedger: boolean,
): Promise<FreshInstallLedgerPreparation> {
  const principalError = await freshInstallPrincipalError(sql);
  if (principalError !== null) {
    return { authorized: false, error: principalError };
  }

  const ledger = hasLedger ? await readLedger(sql) : [];
  const stateError = freshInstallStateError(files, ledger, await buildersContainRows(sql));
  if (stateError !== null) {
    return { authorized: false, error: stateError };
  }

  await ensureLedger(sql);
  return { authorized: true, ledger };
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
  // Migrations 056 and 058 alter builders while authentication and lifecycle
  // reads remain live. Their ACCESS EXCLUSIVE requests must fail fast instead
  // of letting a queued request stall later reads for the default 30 seconds.
  return filename === UNIVERSAL_API_KEY_SCOPE_MIGRATION ||
    filename === GENERAL_APP_RUNTIME_OWNER_BOUNDARY_MIGRATION ||
    filename === WORKSPACE_ACCESS_STATE_EXPAND_MIGRATION ||
    filename === REMOVE_FREE_PLAN_CONTRACT_MIGRATION
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
  removeFreePolicy: RemoveFreeMigrationPolicy;
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
  const policyError = removeFreeApprovalError(
    pending,
    opts.removeFreePolicy.approvals,
    opts.removeFreePolicy,
  );
  if (policyError !== null) {
    throw new Error(`Refusing remove-Free migration apply: ${policyError}`);
  }
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
        // Custom PostgreSQL settings can be inherited from ALTER ROLE,
        // ALTER DATABASE, or PGOPTIONS. Always override the fresh-install
        // attestation inside this transaction so ambient configuration can
        // never make an ordinary upgrade look like an authorized empty
        // bootstrap to migrations 057/059.
        await tx.unsafe(
          'SELECT pg_catalog.set_config($1, $2, true)',
          [
            REMOVE_FREE_FRESH_INSTALL_GUC,
            opts.removeFreePolicy.freshInstallAuthorized ? 'on' : 'off',
          ],
        );
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
  const protectedMigration = opts.files.find((file) =>
    isRemoveFreeReservedMigration(file.filename),
  );
  if (protectedMigration !== undefined) {
    throw new Error(
      `Refusing to baseline protected remove-Free migration ${protectedMigration.filename}`,
    );
  }
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
