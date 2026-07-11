import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import {
  listMigrationFiles,
  type MigrationFile,
  type MigrateSqlClient,
} from './db-migrate-core.js';
import { readDbMigrateEnv } from './db-migrate-env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, '..', 'db/migrations');

export const API_KEY_SCOPE_CONTRACT = 'api_keys_scope' as const;
export const API_KEY_SCOPE_VALUES = ['agent_sdk', 'admin_api', 'data_import', 'universal'] as const;
export const API_KEY_SCOPE_MIGRATIONS = [
  '041_rename_api_key_scopes.sql',
  '048_universal_api_key_scope.sql',
] as const;

type PhysicalSchemaSqlClient = Pick<MigrateSqlClient, 'unsafe'>;
type ApiKeyScopeContract = typeof API_KEY_SCOPE_CONTRACT;

export interface VerifyPhysicalSchemaArgs {
  contract: ApiKeyScopeContract;
  json: boolean;
}

export interface PhysicalScopeConstraint {
  definition: string;
  name: string;
  validated: boolean;
}

export interface PhysicalSchemaContractResult {
  constraint: PhysicalScopeConstraint | null;
  constraint_scope_values: string[];
  ledger: Array<{
    checksum_matches: boolean;
    filename: string;
    present: boolean;
  }>;
  ok: boolean;
  scope_distribution: Array<{ count: string; scope: string }>;
  unexpected_constraints: string[];
  unexpected_scope_values: string[];
}

const CONSTRAINT_QUERY = `SELECT conname, convalidated, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'api_keys'::regclass
  AND conname LIKE 'api_keys_scope%'
ORDER BY conname`;

const LEDGER_QUERY = `SELECT filename, checksum
FROM schema_migrations
WHERE filename = ANY($1::text[])
ORDER BY filename`;

const SCOPE_DISTRIBUTION_QUERY = `SELECT scope, count(*)::text AS count
FROM api_keys
GROUP BY scope
ORDER BY scope`;

function equalStringSets(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function readString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new Error(`Expected ${key} to be a string`);
  }
  return value;
}

function readBoolean(row: Record<string, unknown>, key: string): boolean {
  const value = row[key];
  if (typeof value !== 'boolean') {
    throw new Error(`Expected ${key} to be a boolean`);
  }
  return value;
}

function asScopeConstraint(row: Record<string, unknown>): PhysicalScopeConstraint {
  return {
    definition: readString(row, 'definition'),
    name: readString(row, 'conname'),
    validated: readBoolean(row, 'convalidated'),
  };
}

function asLedgerRow(row: Record<string, unknown>): { checksum: string; filename: string } {
  return {
    checksum: readString(row, 'checksum'),
    filename: readString(row, 'filename'),
  };
}

function asScopeDistribution(row: Record<string, unknown>): { count: string; scope: string } {
  return {
    count: readString(row, 'count'),
    scope: readString(row, 'scope'),
  };
}

/** Extract the string literals used by PostgreSQL's rendered CHECK definition. */
export function scopeValuesFromConstraintDefinition(definition: string): string[] {
  const values = new Set<string>();
  for (const match of definition.matchAll(/'((?:[^']|'')*)'/g)) {
    values.add(match[1]!.replaceAll("''", "'"));
  }
  return [...values].sort();
}

export function parseVerifyPhysicalSchemaArgs(argv: string[]): VerifyPhysicalSchemaArgs {
  let contract: ApiKeyScopeContract | undefined;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    // pnpm preserves its conventional argument separator when this script is
    // run as `pnpm db:migrate:verify-physical -- --contract …`.
    if (arg === '--') {
      continue;
    }
    if (arg === '--contract') {
      const value = argv[index + 1];
      if (value !== API_KEY_SCOPE_CONTRACT) {
        throw new Error(`--contract must be ${API_KEY_SCOPE_CONTRACT}`);
      }
      contract = value;
      index += 1;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg ?? ''}`);
  }

  if (contract === undefined) {
    throw new Error(`--contract ${API_KEY_SCOPE_CONTRACT} is required`);
  }

  return { contract, json };
}

export async function verifyApiKeyScopeContract({
  migrations,
  sql,
}: {
  migrations: MigrationFile[];
  sql: PhysicalSchemaSqlClient;
}): Promise<PhysicalSchemaContractResult> {
  const expectedChecksums = new Map(
    migrations
      .filter((migration) =>
        API_KEY_SCOPE_MIGRATIONS.includes(
          migration.filename as (typeof API_KEY_SCOPE_MIGRATIONS)[number],
        ),
      )
      .map((migration) => [migration.filename, migration.checksum]),
  );
  if (expectedChecksums.size !== API_KEY_SCOPE_MIGRATIONS.length) {
    throw new Error('Migration files for the API-key scope contract are missing from this image');
  }

  const [constraintRows, ledgerRows, scopeRows] = await Promise.all([
    sql.unsafe(CONSTRAINT_QUERY),
    sql.unsafe(LEDGER_QUERY, [[...API_KEY_SCOPE_MIGRATIONS]]),
    sql.unsafe(SCOPE_DISTRIBUTION_QUERY),
  ]);
  const constraints = constraintRows.map(asScopeConstraint);
  const constraint = constraints.find((item) => item.name === 'api_keys_scope_check') ?? null;
  const constraintScopeValues =
    constraint === null ? [] : scopeValuesFromConstraintDefinition(constraint.definition);
  const ledgerByFilename = new Map(ledgerRows.map(asLedgerRow).map((row) => [row.filename, row]));
  const ledger = API_KEY_SCOPE_MIGRATIONS.map((filename) => {
    const row = ledgerByFilename.get(filename);
    return {
      checksum_matches: row !== undefined && row.checksum === expectedChecksums.get(filename),
      filename,
      present: row !== undefined,
    };
  });
  const scopeDistribution = scopeRows.map(asScopeDistribution);
  const allowedScopes = [...API_KEY_SCOPE_VALUES].sort();
  const unexpectedScopeValues = scopeDistribution
    .map((row) => row.scope)
    .filter(
      (scope) => !API_KEY_SCOPE_VALUES.includes(scope as (typeof API_KEY_SCOPE_VALUES)[number]),
    );
  const unexpectedConstraints = constraints
    .filter((item) => item.name !== 'api_keys_scope_check')
    .map((item) => item.name);

  return {
    constraint,
    constraint_scope_values: constraintScopeValues,
    ledger,
    ok:
      constraint !== null &&
      constraint.validated &&
      unexpectedConstraints.length === 0 &&
      equalStringSets(constraintScopeValues, allowedScopes) &&
      ledger.every((row) => row.checksum_matches) &&
      unexpectedScopeValues.length === 0,
    scope_distribution: scopeDistribution,
    unexpected_constraints: unexpectedConstraints,
    unexpected_scope_values: unexpectedScopeValues,
  };
}

function logResult(result: PhysicalSchemaContractResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result));
    return;
  }

  console.log(`contract: ${API_KEY_SCOPE_CONTRACT}`);
  console.log(`status: ${result.ok ? 'in_sync' : 'drift'}`);
  console.log(`constraint: ${result.constraint?.name ?? '(missing)'}`);
  console.log(`constraint_scope_values: ${result.constraint_scope_values.join(',') || '(none)'}`);
  console.log(
    `ledger: ${result.ledger.map((row) => `${row.filename}=${row.checksum_matches ? 'ok' : 'mismatch'}`).join(', ')}`,
  );
  console.log(
    `scope_distribution: ${result.scope_distribution.map((row) => `${row.scope}=${row.count}`).join(',') || '(empty)'}`,
  );
}

export async function runPhysicalSchemaVerification({
  args,
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
  sql,
}: {
  args: VerifyPhysicalSchemaArgs;
  migrationsDir?: string;
  sql: PhysicalSchemaSqlClient;
}): Promise<PhysicalSchemaContractResult> {
  if (args.contract !== API_KEY_SCOPE_CONTRACT) {
    throw new Error(`Unsupported contract: ${args.contract}`);
  }
  const result = await verifyApiKeyScopeContract({
    migrations: await listMigrationFiles(migrationsDir),
    sql,
  });
  logResult(result, args.json);
  return result;
}

function isMainModule(importMetaUrl: string, argvPath: string | undefined): boolean {
  return argvPath !== undefined && importMetaUrl === pathToFileURL(argvPath).href;
}

async function main(): Promise<void> {
  const args = parseVerifyPhysicalSchemaArgs(process.argv.slice(2));
  const { databaseUrl } = readDbMigrateEnv();
  const sql = postgres(databaseUrl);

  try {
    const result = await runPhysicalSchemaVerification({ args, sql });
    process.exitCode = result.ok ? 0 : 2;
  } finally {
    await sql.end();
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch(() => {
    console.error('Physical schema contract verification failed.');
    process.exitCode = 1;
  });
}
