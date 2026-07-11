import { sql as defaultSql } from './client.js';
import { EXPECTED_MIGRATIONS, EXPECTED_SCHEMA_HEAD } from './migration-manifest.js';
import { hasPgErrorCode } from './pg-error.js';

export type SchemaState = 'in_sync' | 'behind' | 'drift' | 'untracked' | 'unavailable';

export interface SchemaStatus {
  expected_head: string;
  applied_head: string | null;
  pending_count: number | null;
  state: SchemaState;
}

class SchemaStatusTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Timed out while reading schema_migrations after ${timeoutMs}ms`);
    this.name = 'SchemaStatusTimeoutError';
  }
}

function statusWithNulls(state: 'untracked' | 'unavailable'): SchemaStatus {
  return {
    expected_head: EXPECTED_SCHEMA_HEAD,
    applied_head: null,
    pending_count: null,
    state,
  };
}

function isMigrationLedgerMissing(error: unknown): boolean {
  return hasPgErrorCode(error, '42P01');
}

interface LedgerRow {
  filename: string;
  checksum: string;
}

function ledgerRowFromRow(row: unknown): LedgerRow {
  if (typeof row !== 'object' || row === null || !('filename' in row)) {
    throw new Error('Expected schema_migrations row to include filename');
  }
  if (!('checksum' in row)) {
    throw new Error('Expected schema_migrations row to include checksum');
  }

  const filename = row.filename;
  if (typeof filename !== 'string') {
    throw new Error('Expected schema_migrations filename to be a string');
  }

  const checksum = row.checksum;
  if (typeof checksum !== 'string') {
    throw new Error('Expected schema_migrations checksum to be a string');
  }

  return { filename, checksum };
}

async function readLedgerRows(
  client: Pick<typeof defaultSql, 'unsafe'>,
  timeoutMs: number,
): Promise<LedgerRow[]> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new SchemaStatusTimeoutError(timeoutMs)), timeoutMs);
  });

  try {
    const rows = await Promise.race([
      client.unsafe('SELECT filename, checksum FROM schema_migrations'),
      timeoutPromise,
    ]);
    return rows.map((row) => ledgerRowFromRow(row));
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export async function getSchemaStatus(
  client: Pick<typeof defaultSql, 'unsafe'> = defaultSql,
  timeoutMs = 1500,
): Promise<SchemaStatus> {
  try {
    const ledgerRows = await readLedgerRows(client, timeoutMs);
    const appliedFilenames = ledgerRows.map((row) => row.filename);
    const ledgerByFilename = new Map(ledgerRows.map((row) => [row.filename, row]));
    const pendingCount = EXPECTED_MIGRATIONS.filter(
      (migration) => !ledgerByFilename.has(migration.filename),
    ).length;
    const hasChecksumDrift = EXPECTED_MIGRATIONS.some((migration) => {
      const ledgerRow = ledgerByFilename.get(migration.filename);
      return ledgerRow !== undefined && ledgerRow.checksum !== migration.sha256;
    });
    const appliedHead = [...appliedFilenames].sort().at(-1) ?? null;

    return {
      expected_head: EXPECTED_SCHEMA_HEAD,
      applied_head: appliedHead,
      pending_count: pendingCount,
      state: hasChecksumDrift ? 'drift' : pendingCount > 0 ? 'behind' : 'in_sync',
    };
  } catch (error) {
    if (isMigrationLedgerMissing(error)) {
      return statusWithNulls('untracked');
    }

    return statusWithNulls('unavailable');
  }
}
