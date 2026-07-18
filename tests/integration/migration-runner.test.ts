import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import {
  computeChecksum,
  ensureLedger,
  listMigrationFiles,
  recordBaseline,
  type MigrateSqlClient,
} from '../../scripts/db-migrate-core.js';
import { runDbMigrate, type DbMigrateArgs } from '../../scripts/db-migrate.js';
import { applyMigrationsThrough, createScratchDb, type ScratchDb } from '../helpers/scratch-db.js';

const MIGRATIONS_DIR = path.resolve('db/migrations');
const THROUGH_040 = '040_audit_log_partition_runway.sql';
const AUTHORITATIVE_BUDGET_LEDGER_MIGRATION = '050_authoritative_budget_control_ledger.sql';
const AUTHORITATIVE_BUDGET_RUNTIME_MIGRATION = '051_authoritative_budget_control_runtime.sql';
const AUTHORITATIVE_BUDGET_RUNTIME_ROLES_MIGRATION =
  '052_authoritative_budget_control_runtime_roles.sql';
const AUTHORITATIVE_BUDGET_LEGACY_RLS_COMPATIBILITY_MIGRATION =
  '053_legacy_catalog_owner_rls_compatibility.sql';
const GENERAL_APP_RUNTIME_OWNER_BOUNDARY_MIGRATION = '054_general_app_runtime_owner_boundary.sql';
const HISTORICAL_AUDIT_TIME_ZONE = 'Asia/Riyadh';
const RESTORED_AUDIT_PARTITION = 'audit_log_y2026m04';
const TEST_TIMEOUT_MS = 180_000;

interface RunResult {
  exitCode: number;
  logs: string[];
  errors: string[];
}

interface LedgerRow {
  filename: string;
  checksum: string;
  applied_by: string;
}

async function migrationFiles() {
  return listMigrationFiles(MIGRATIONS_DIR);
}

async function migrationFilenames(): Promise<string[]> {
  return (await migrationFiles()).map((file) => file.filename);
}

function migrationPrefix(filename: string): number {
  return Number.parseInt(filename.slice(0, 3), 10);
}

async function runMigrate(scratch: ScratchDb, args: DbMigrateArgs): Promise<RunResult> {
  return runMigrateWithSql(scratch.sql, MIGRATIONS_DIR, args);
}

async function runMigrateWithSql(
  sql: MigrateSqlClient,
  migrationsDir: string,
  args: DbMigrateArgs,
): Promise<RunResult> {
  const logs: string[] = [];
  const errors: string[] = [];
  const exitCode = await runDbMigrate(args, {
    sql,
    migrationsDir,
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
  });
  return { exitCode, logs, errors };
}

function appliedLogFilenames(logs: string[]): string[] {
  return logs
    .filter((line) => line.startsWith('✓ '))
    .map((line) => line.replace(/^✓ /, '').replace(/ \([0-9]+ms\)$/, ''));
}

async function insertMinimalBuilder(scratch: ScratchDb): Promise<string> {
  const suffix = randomBytes(6).toString('hex');
  const [builder] = await scratch.sql<{ id: string }[]>`
    INSERT INTO builders (email, name, slug)
    VALUES (${`migration-runner-${suffix}@example.com`}, 'Migration Runner', ${`migration-runner-${suffix}`})
    RETURNING id
  `;
  return builder!.id;
}

async function insertApiKey(
  scratch: ScratchDb,
  builderId: string,
  scope: string,
  keyId: string,
): Promise<void> {
  await scratch.sql`
    INSERT INTO api_keys (key_id, builder_id, key_hash, scope)
    VALUES (${keyId}, ${builderId}, 'x', ${scope})
  `;
}

async function insertApiKeyAsGeneralAppOwner(
  scratch: ScratchDb,
  builderId: string,
  scope: string,
  keyId: string,
): Promise<void> {
  await scratch.sql.begin(async (sql) => {
    await sql.unsafe('SET LOCAL ROLE pylva_general_app_runtime');
    await sql`
      INSERT INTO api_keys (key_id, builder_id, key_hash, scope)
      VALUES (${keyId}, ${builderId}, 'x', ${scope})
    `;
  });
}

async function expectScopeCheckReject(action: Promise<unknown>): Promise<void> {
  try {
    await action;
  } catch (error) {
    const pgError = error as { code?: unknown; message?: unknown };
    expect(pgError.code).toBe('23514');
    expect(String(pgError.message)).toMatch(/api_keys_scope_check/);
    return;
  }
  throw new Error('Expected api_keys_scope_check rejection');
}

async function ledgerRows(scratch: ScratchDb): Promise<LedgerRow[]> {
  return scratch.sql<LedgerRow[]>`
    SELECT filename, checksum, applied_by
    FROM schema_migrations
    ORDER BY filename
  `;
}

async function appliedAtPairs(scratch: ScratchDb): Promise<Array<[string, string]>> {
  const rows = await scratch.sql<{ filename: string; applied_at: Date | string }[]>`
    SELECT filename, applied_at
    FROM schema_migrations
    ORDER BY filename
  `;
  return rows.map((row) => [row.filename, timestampValue(row.applied_at)]);
}

function timestampValue(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

async function assertCompleteLedger(
  scratch: ScratchDb,
  expectedAppliedBy: (filename: string) => string,
): Promise<LedgerRow[]> {
  const files = await migrationFiles();
  const rows = await ledgerRows(scratch);
  expect(rows.map((row) => row.filename)).toEqual(files.map((file) => file.filename));

  const filesByName = new Map(files.map((file) => [file.filename, file]));
  for (const row of rows) {
    const file = filesByName.get(row.filename);
    expect(file).toBeDefined();
    expect(row.checksum).toBe(computeChecksum(file!.content));
    expect(row.applied_by).toBe(expectedAppliedBy(row.filename));
  }

  return rows;
}

async function baselineThrough040(scratch: ScratchDb): Promise<RunResult> {
  const result = await runMigrate(scratch, {
    mode: 'baseline',
    through: THROUGH_040,
    yes: true,
    json: false,
  });
  expect(result.exitCode).toBe(0);
  return result;
}

async function legacy040WithBaseline(scratch: ScratchDb): Promise<void> {
  await applyMigrationsThrough(scratch, '040');
  await baselineThrough040(scratch);
}

function childMigrationEnvironment(url: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ALLOW_MIGRATION_DATABASE_URL_FALLBACK: 'true',
    DATABASE_URL: url,
  };
  for (const name of Object.keys(environment)) {
    if (name === 'MIGRATION_DATABASE_URL' || name.startsWith('MIGRATION_DB_')) {
      delete environment[name];
    }
  }
  return environment;
}

function spawnDbMigrateStatus(url: string) {
  return spawnSync('pnpm', ['exec', 'tsx', 'scripts/db-migrate.ts', '--status', '--json'], {
    env: childMigrationEnvironment(url),
    encoding: 'utf8',
  });
}

function spawnDbSetup(url: string) {
  return spawnSync('pnpm', ['exec', 'tsx', 'db/setup.ts'], {
    env: {
      ...childMigrationEnvironment(url),
      SKIP_CLICKHOUSE: 'true',
    },
    encoding: 'utf8',
  });
}

interface AuditPartitionRow {
  bound: string;
  name: string;
  oid: string;
  owner: string;
}

interface AuditPartitionContract {
  mismatched_bounds: number;
  owned_by_current_user: number;
  partition_count: number;
  time_zone: string;
}

async function setMigrationTimeZone(scratch: ScratchDb, timeZone: string): Promise<void> {
  await scratch.sql`SELECT pg_catalog.set_config('TimeZone', ${timeZone}, FALSE)`;
}

async function prepareMigration054Upgrade(prefix: string): Promise<ScratchDb> {
  const scratch = await createScratchDb({ prefix });
  try {
    await setMigrationTimeZone(scratch, HISTORICAL_AUDIT_TIME_ZONE);
    const applied = await applyMigrationsThrough(scratch, '053');
    expect(applied.at(-1)).toBe(AUTHORITATIVE_BUDGET_LEGACY_RLS_COMPATIBILITY_MIGRATION);
    expect(applied).not.toContain(GENERAL_APP_RUNTIME_OWNER_BOUNDARY_MIGRATION);
    await ensureLedger(scratch.sql);
    const appliedSet = new Set(applied);
    const appliedFiles = (await migrationFiles()).filter((file) => appliedSet.has(file.filename));
    expect(appliedFiles).toHaveLength(applied.length);
    await recordBaseline({ sql: scratch.sql, files: appliedFiles });
    return scratch;
  } catch (error) {
    await scratch.drop();
    throw error;
  }
}

async function rawApplyMigration054(scratch: ScratchDb): Promise<void> {
  const source = await fs.readFile(
    path.join(MIGRATIONS_DIR, GENERAL_APP_RUNTIME_OWNER_BOUNDARY_MIGRATION),
    'utf8',
  );
  await scratch.sql.begin(async (sql) => {
    await sql.unsafe(source);
  });
}

async function auditPartitions(scratch: ScratchDb): Promise<AuditPartitionRow[]> {
  return scratch.sql<AuditPartitionRow[]>`
    SELECT child.oid::TEXT AS oid,
           child.relname::TEXT AS name,
           pg_catalog.pg_get_userbyid(child.relowner)::TEXT AS owner,
           pg_catalog.pg_get_expr(child.relpartbound, child.oid)::TEXT AS bound
    FROM pg_catalog.pg_inherits AS inheritance
    JOIN pg_catalog.pg_class AS parent ON parent.oid = inheritance.inhparent
    JOIN pg_catalog.pg_namespace AS parent_namespace
      ON parent_namespace.oid = parent.relnamespace
    JOIN pg_catalog.pg_class AS child ON child.oid = inheritance.inhrelid
    JOIN pg_catalog.pg_namespace AS child_namespace
      ON child_namespace.oid = child.relnamespace
    WHERE parent_namespace.nspname = 'public'
      AND parent.relname = 'audit_log'
      AND child_namespace.nspname = 'public'
    ORDER BY child.relname
  `;
}

async function auditPartitionContract(scratch: ScratchDb): Promise<AuditPartitionContract> {
  const [contract] = await scratch.sql<AuditPartitionContract[]>`
    WITH partitions AS (
      SELECT child.relname AS partition_name,
             pg_catalog.pg_get_userbyid(child.relowner) AS partition_owner,
             pg_catalog.pg_get_expr(child.relpartbound, child.oid) AS partition_bound
      FROM pg_catalog.pg_inherits AS inheritance
      JOIN pg_catalog.pg_class AS parent ON parent.oid = inheritance.inhparent
      JOIN pg_catalog.pg_namespace AS parent_namespace
        ON parent_namespace.oid = parent.relnamespace
      JOIN pg_catalog.pg_class AS child ON child.oid = inheritance.inhrelid
      JOIN pg_catalog.pg_namespace AS child_namespace
        ON child_namespace.oid = child.relnamespace
      WHERE parent_namespace.nspname = 'public'
        AND parent.relname = 'audit_log'
        AND child_namespace.nspname = 'public'
    ), expected AS (
      SELECT partition_name,
             partition_owner,
             partition_bound,
             pg_catalog.format(
               'FOR VALUES FROM (%L) TO (%L)',
               pg_catalog.make_date(
                 pg_catalog.substr(partition_name, 12, 4)::INTEGER,
                 pg_catalog.substr(partition_name, 17, 2)::INTEGER,
                 1
               )::TIMESTAMPTZ,
               (
                 pg_catalog.make_date(
                   pg_catalog.substr(partition_name, 12, 4)::INTEGER,
                   pg_catalog.substr(partition_name, 17, 2)::INTEGER,
                   1
                 ) + INTERVAL '1 month'
               )::DATE::TIMESTAMPTZ
             ) AS expected_bound
      FROM partitions
    )
    SELECT pg_catalog.current_setting('TimeZone')::TEXT AS time_zone,
           pg_catalog.count(*)::INTEGER AS partition_count,
           (
             pg_catalog.count(*) FILTER (WHERE partition_owner = CURRENT_USER)
           )::INTEGER AS owned_by_current_user,
           (
             pg_catalog.count(*) FILTER (
               WHERE partition_bound IS DISTINCT FROM expected_bound
             )
           )::INTEGER AS mismatched_bounds
    FROM expected
  `;
  if (!contract) throw new Error('audit partition contract query returned no row');
  return contract;
}

async function migration054UpgradeSnapshot(scratch: ScratchDb): Promise<Record<string, unknown>> {
  const relations = await scratch.sql`
    SELECT relation.oid::TEXT AS oid,
           relation.relname::TEXT AS name,
           relation.relkind::TEXT AS kind,
           pg_catalog.pg_get_userbyid(relation.relowner)::TEXT AS owner,
           relation.relacl::TEXT AS acl
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S', 'i', 'I')
    ORDER BY relation.relkind, relation.relname, relation.oid
  `;
  const functions = await scratch.sql`
    SELECT procedure.oid::TEXT AS oid,
           procedure.proname::TEXT AS name,
           pg_catalog.pg_get_function_identity_arguments(procedure.oid)::TEXT AS arguments,
           pg_catalog.pg_get_userbyid(procedure.proowner)::TEXT AS owner,
           procedure.prosecdef AS security_definer,
           procedure.provolatile::TEXT AS volatility,
           procedure.proconfig::TEXT AS config,
           procedure.proacl::TEXT AS acl,
           pg_catalog.md5(procedure.prosrc)::TEXT AS source_hash
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
    ORDER BY procedure.proname, arguments, procedure.oid
  `;
  const attributes = await scratch.sql`
    SELECT relation.relname::TEXT AS relation_name,
           attribute.attnum::INTEGER AS attribute_number,
           attribute.attname::TEXT AS attribute_name,
           attribute.attacl::TEXT AS acl
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attacl IS NOT NULL
    ORDER BY relation.relname, attribute.attnum
  `;
  const schemas = await scratch.sql`
    SELECT namespace.nspname::TEXT AS name,
           pg_catalog.pg_get_userbyid(namespace.nspowner)::TEXT AS owner,
           namespace.nspacl::TEXT AS acl
    FROM pg_catalog.pg_namespace AS namespace
    WHERE namespace.nspname = 'public'
  `;
  const databases = await scratch.sql`
    SELECT database.datname::TEXT AS name,
           pg_catalog.pg_get_userbyid(database.datdba)::TEXT AS owner,
           database.datacl::TEXT AS acl
    FROM pg_catalog.pg_database AS database
    WHERE database.datname = pg_catalog.current_database()
  `;
  const roles = await scratch.sql`
    SELECT role.rolname::TEXT AS name,
           role.rolcanlogin AS can_login,
           role.rolsuper AS superuser,
           role.rolcreatedb AS create_database,
           role.rolcreaterole AS create_role,
           role.rolinherit AS inherits,
           role.rolreplication AS replication,
           role.rolbypassrls AS bypass_rls
    FROM pg_catalog.pg_roles AS role
    WHERE role.rolname = 'pylva_general_app_runtime'
  `;
  const memberships = await scratch.sql`
    SELECT owner_role.rolname::TEXT AS owner_role,
           member_role.rolname::TEXT AS member_role,
           grantor_role.rolname::TEXT AS grantor_role,
           edge.admin_option,
           edge.inherit_option,
           edge.set_option
    FROM pg_catalog.pg_auth_members AS edge
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = edge.roleid
    JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = edge.member
    JOIN pg_catalog.pg_roles AS grantor_role ON grantor_role.oid = edge.grantor
    WHERE owner_role.rolname = 'pylva_general_app_runtime'
       OR member_role.rolname = 'pylva_general_app_runtime'
    ORDER BY owner_role.rolname,
             member_role.rolname,
             grantor_role.rolname,
             edge.admin_option,
             edge.inherit_option,
             edge.set_option
  `;
  const [session] = await scratch.sql<{ time_zone: string }[]>`
    SELECT pg_catalog.current_setting('TimeZone')::TEXT AS time_zone
  `;

  return {
    attributes,
    databases,
    functions,
    memberships,
    relations,
    roles,
    schemas,
    time_zone: session?.time_zone,
  };
}

async function expectRawMigration054Failure(
  scratch: ScratchDb,
  code: string,
  message: RegExp,
): Promise<void> {
  try {
    await rawApplyMigration054(scratch);
  } catch (error) {
    const postgresError = error as { code?: unknown; message?: unknown };
    expect(postgresError.code).toBe(code);
    expect(String(postgresError.message)).toMatch(message);
    return;
  }
  throw new Error('Expected raw migration 054 to fail');
}

describe('migration runner integration', () => {
  it(
    'reproduces the 040 api_keys incident, pins the refusal rail, then baselines and catches up',
    async () => {
      const scratch = await createScratchDb();
      try {
        await applyMigrationsThrough(scratch, '040');
        const [ledgerProbe] = await scratch.sql<{ regclass: string | null }[]>`
          SELECT to_regclass('public.schema_migrations') AS regclass
        `;
        expect(ledgerProbe?.regclass).toBeNull();

        const builderId = await insertMinimalBuilder(scratch);
        await expectScopeCheckReject(insertApiKey(scratch, builderId, 'agent_sdk', 'cj00000001'));

        const guardedApply = await runMigrate(scratch, {
          mode: 'apply',
          yes: false,
          json: false,
        });
        expect(guardedApply.exitCode).toBe(4);
        expect(guardedApply.errors.join('\n')).toContain('--baseline --yes');

        await baselineThrough040(scratch);

        const catchUp = await runMigrate(scratch, { mode: 'apply', yes: false, json: false });
        expect(catchUp.exitCode).toBe(0);
        const catchUpFilenames = appliedLogFilenames(catchUp.logs);
        expect(catchUpFilenames).toEqual(
          (await migrationFilenames()).filter((filename) => migrationPrefix(filename) >= 41),
        );
        expect(catchUpFilenames).toContain(AUTHORITATIVE_BUDGET_LEDGER_MIGRATION);
        expect(catchUpFilenames).toContain(AUTHORITATIVE_BUDGET_RUNTIME_MIGRATION);

        await expect(
          insertApiKey(scratch, builderId, 'agent_sdk', 'cj00000001'),
        ).rejects.toMatchObject({ code: '42501' });
        await expect(
          insertApiKeyAsGeneralAppOwner(scratch, builderId, 'agent_sdk', 'cj00000001'),
        ).resolves.toBeUndefined();
        await expectScopeCheckReject(
          insertApiKeyAsGeneralAppOwner(scratch, builderId, 'telemetry', 'cj00000002'),
        );

        const rows = await assertCompleteLedger(scratch, (filename) =>
          migrationPrefix(filename) <= 40 ? 'baseline' : 'db:migrate',
        );
        expect(rows.at(-1)?.filename).toBe((await migrationFilenames()).at(-1));
      } finally {
        await scratch.drop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is idempotent on re-run after all migrations are recorded',
    async () => {
      const scratch = await createScratchDb();
      try {
        const firstRun = await runMigrate(scratch, { mode: 'apply', yes: false, json: false });
        expect(firstRun.exitCode).toBe(0);
        expect(appliedLogFilenames(firstRun.logs)).toContain(AUTHORITATIVE_BUDGET_LEDGER_MIGRATION);
        expect(appliedLogFilenames(firstRun.logs)).toContain(
          AUTHORITATIVE_BUDGET_RUNTIME_MIGRATION,
        );
        const before = await appliedAtPairs(scratch);

        const secondRun = await runMigrate(scratch, { mode: 'apply', yes: false, json: false });
        expect(secondRun.exitCode).toBe(0);
        expect(appliedLogFilenames(secondRun.logs)).toEqual([]);
        expect(secondRun.logs.join('\n')).toContain('0 pending');
        expect(await appliedAtPairs(scratch)).toEqual(before);
      } finally {
        await scratch.drop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'raw-applies migration 054 with restored historical audit preconditions and replays idempotently',
    async () => {
      const scratch = await prepareMigration054Upgrade('pylva_migration_054_replay');
      try {
        const historicalContract = await auditPartitionContract(scratch);
        expect(historicalContract).toMatchObject({
          time_zone: HISTORICAL_AUDIT_TIME_ZONE,
          mismatched_bounds: 0,
        });
        expect(historicalContract.partition_count).toBeGreaterThan(0);
        expect(historicalContract.owned_by_current_user).toBe(historicalContract.partition_count);

        const beforePartitions = await auditPartitions(scratch);
        const [beforeParent] = await scratch.sql<{ oid: string; owner: string }[]>`
          SELECT relation.oid::TEXT AS oid,
                 pg_catalog.pg_get_userbyid(relation.relowner)::TEXT AS owner
          FROM pg_catalog.pg_class AS relation
          WHERE relation.oid = 'public.audit_log'::REGCLASS
        `;
        const [beforeFunction] = await scratch.sql<{ function_oid: string | null }[]>`
          SELECT pg_catalog.to_regprocedure(
            'public.pylva_ensure_audit_log_partition(date)'
          )::TEXT AS function_oid
        `;
        expect(beforeParent).toBeDefined();
        expect(beforePartitions.every((partition) => partition.owner === beforeParent!.owner)).toBe(
          true,
        );
        expect(beforeFunction?.function_oid).toBeNull();

        // A restored upgrade can inherit a different session default. Prove
        // that the stored instants reject that interpretation, then restore
        // the historical session zone before applying the frozen migration.
        await setMigrationTimeZone(scratch, 'UTC');
        const wrongZoneContract = await auditPartitionContract(scratch);
        expect(wrongZoneContract.mismatched_bounds).toBe(wrongZoneContract.partition_count);
        await setMigrationTimeZone(scratch, HISTORICAL_AUDIT_TIME_ZONE);
        expect(await auditPartitionContract(scratch)).toMatchObject({ mismatched_bounds: 0 });

        await rawApplyMigration054(scratch);

        const afterPartitions = await auditPartitions(scratch);
        expect(afterPartitions.map(({ bound, name, oid }) => ({ bound, name, oid }))).toEqual(
          beforePartitions.map(({ bound, name, oid }) => ({ bound, name, oid })),
        );
        expect(
          afterPartitions.every((partition) => partition.owner === 'pylva_general_app_runtime'),
        ).toBe(true);

        const selectedRelations = await scratch.sql<
          Array<{ kind: string; name: string; owner: string }>
        >`
          SELECT relation.relname::TEXT AS name,
                 relation.relkind::TEXT AS kind,
                 pg_catalog.pg_get_userbyid(relation.relowner)::TEXT AS owner
          FROM pg_catalog.pg_class AS relation
          JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public'
            AND relation.relname IN (
              'audit_log',
              'audit_log_id_seq',
              'webhook_configs_with_grace',
              'budget_accounts',
              'schema_migrations',
              '_048_api_keys_scope_backup'
            )
          ORDER BY relation.relname
        `;
        const relationPosture = Object.fromEntries(
          selectedRelations.map((relation) => [relation.name, relation]),
        );
        expect(relationPosture).toMatchObject({
          audit_log: { kind: 'p', owner: 'pylva_general_app_runtime' },
          audit_log_id_seq: { kind: 'S', owner: 'pylva_general_app_runtime' },
          webhook_configs_with_grace: { kind: 'v', owner: 'pylva_general_app_runtime' },
          budget_accounts: { kind: 'r', owner: beforeParent!.owner },
          schema_migrations: { kind: 'r', owner: beforeParent!.owner },
          _048_api_keys_scope_backup: { kind: 'r', owner: beforeParent!.owner },
        });

        const [functionPosture] = await scratch.sql<
          Array<{
            acl: string | null;
            config: string[] | null;
            oid: string;
            owner: string;
            security_definer: boolean;
            volatility: string;
          }>
        >`
          SELECT procedure.oid::TEXT AS oid,
                 pg_catalog.pg_get_userbyid(procedure.proowner)::TEXT AS owner,
                 procedure.prosecdef AS security_definer,
                 procedure.provolatile::TEXT AS volatility,
                 procedure.proconfig AS config,
                 procedure.proacl::TEXT AS acl
          FROM pg_catalog.pg_proc AS procedure
          WHERE procedure.oid =
            'public.pylva_ensure_audit_log_partition(date)'::REGPROCEDURE
        `;
        expect(functionPosture).toMatchObject({
          owner: 'pylva_general_app_runtime',
          security_definer: true,
          volatility: 'v',
        });
        expect(functionPosture?.config).toHaveLength(2);
        expect(functionPosture?.config).toEqual(
          expect.arrayContaining([
            'search_path=pg_catalog',
            `TimeZone=${HISTORICAL_AUDIT_TIME_ZONE}`,
          ]),
        );

        const [aclPosture] = await scratch.sql<
          Array<{
            authority_select: boolean;
            database_connect: boolean;
            function_execute: boolean;
            ledger_insert: boolean;
            ledger_select: boolean;
            public_execute: boolean;
            schema_create: boolean;
            schema_usage: boolean;
            sequence_usage: boolean;
          }>
        >`
          SELECT pg_catalog.has_schema_privilege(
                   'pylva_general_app_runtime', 'public', 'USAGE'
                 ) AS schema_usage,
                 pg_catalog.has_schema_privilege(
                   'pylva_general_app_runtime', 'public', 'CREATE'
                 ) AS schema_create,
                 pg_catalog.has_database_privilege(
                   'pylva_general_app_runtime', pg_catalog.current_database(), 'CONNECT'
                 ) AS database_connect,
                 pg_catalog.has_table_privilege(
                   'pylva_general_app_runtime', 'public.schema_migrations', 'SELECT'
                 ) AS ledger_select,
                 pg_catalog.has_table_privilege(
                   'pylva_general_app_runtime', 'public.schema_migrations', 'INSERT'
                 ) AS ledger_insert,
                 pg_catalog.has_table_privilege(
                   'pylva_general_app_runtime', 'public.budget_accounts', 'SELECT'
                 ) AS authority_select,
                 pg_catalog.has_sequence_privilege(
                   'pylva_general_app_runtime',
                   'public.pylva_budget_authority_order_seq',
                   'USAGE'
                 ) AS sequence_usage,
                 pg_catalog.has_function_privilege(
                   'pylva_general_app_runtime',
                   'public.pylva_ensure_audit_log_partition(date)',
                   'EXECUTE'
                 ) AS function_execute,
                 EXISTS (
                   SELECT 1
                   FROM pg_catalog.pg_proc AS procedure
                   CROSS JOIN LATERAL pg_catalog.aclexplode(
                     COALESCE(
                       procedure.proacl,
                       pg_catalog.acldefault('f', procedure.proowner)
                     )
                   ) AS privilege
                   WHERE procedure.oid =
                     'public.pylva_ensure_audit_log_partition(date)'::REGPROCEDURE
                     AND privilege.grantee = 0
                     AND privilege.privilege_type = 'EXECUTE'
                 ) AS public_execute
        `;
        expect(aclPosture).toEqual({
          authority_select: false,
          database_connect: true,
          function_execute: true,
          ledger_insert: false,
          ledger_select: true,
          public_execute: false,
          schema_create: true,
          schema_usage: true,
          sequence_usage: false,
        });

        const [rolePosture] = await scratch.sql<
          Array<{
            bypass_rls: boolean;
            can_login: boolean;
            create_database: boolean;
            create_role: boolean;
            inherits: boolean;
            replication: boolean;
            superuser: boolean;
          }>
        >`
          SELECT role.rolcanlogin AS can_login,
                 role.rolsuper AS superuser,
                 role.rolcreatedb AS create_database,
                 role.rolcreaterole AS create_role,
                 role.rolinherit AS inherits,
                 role.rolreplication AS replication,
                 role.rolbypassrls AS bypass_rls
          FROM pg_catalog.pg_roles AS role
          WHERE role.rolname = 'pylva_general_app_runtime'
        `;
        expect(rolePosture).toEqual({
          bypass_rls: false,
          can_login: false,
          create_database: false,
          create_role: false,
          inherits: false,
          replication: false,
          superuser: false,
        });

        const [existingPartition] = await scratch.sql.begin(async (sql) => {
          await sql.unsafe('SET LOCAL ROLE pylva_general_app_runtime');
          return sql<{ created: boolean }[]>`
            SELECT public.pylva_ensure_audit_log_partition(
              pg_catalog.date_trunc(
                'month',
                pg_catalog.statement_timestamp() AT TIME ZONE 'UTC'
              )::DATE
            ) AS created
          `;
        });
        expect(existingPartition?.created).toBe(false);

        const beforeReplay = await migration054UpgradeSnapshot(scratch);
        await rawApplyMigration054(scratch);
        expect(await migration054UpgradeSnapshot(scratch)).toEqual(beforeReplay);
        const [replayedExistingPartition] = await scratch.sql.begin(async (sql) => {
          await sql.unsafe('SET LOCAL ROLE pylva_general_app_runtime');
          return sql<{ created: boolean }[]>`
            SELECT public.pylva_ensure_audit_log_partition(
              pg_catalog.date_trunc(
                'month',
                pg_catalog.statement_timestamp() AT TIME ZONE 'UTC'
              )::DATE
            ) AS created
          `;
        });
        expect(replayedExistingPartition?.created).toBe(false);
      } finally {
        await scratch.drop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rolls migration 054 back atomically when restored partition bounds use a different TimeZone',
    async () => {
      const scratch = await prepareMigration054Upgrade('pylva_migration_054_timezone');
      try {
        await setMigrationTimeZone(scratch, 'UTC');
        const contract = await auditPartitionContract(scratch);
        expect(contract.partition_count).toBeGreaterThan(0);
        expect(contract.owned_by_current_user).toBe(contract.partition_count);
        expect(contract.mismatched_bounds).toBe(contract.partition_count);

        const before = await migration054UpgradeSnapshot(scratch);
        await expectRawMigration054Failure(
          scratch,
          '55000',
          /bounds do not match migration TimeZone UTC/u,
        );
        expect(await migration054UpgradeSnapshot(scratch)).toEqual(before);
        expect(await auditPartitionContract(scratch)).toEqual(contract);
        const [functionProbe] = await scratch.sql<{ function_oid: string | null }[]>`
          SELECT pg_catalog.to_regprocedure(
            'public.pylva_ensure_audit_log_partition(date)'
          )::TEXT AS function_oid
        `;
        expect(functionProbe?.function_oid).toBeNull();
      } finally {
        await scratch.drop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rolls migration 054 back atomically when a restored audit partition has another owner',
    async () => {
      const scratch = await prepareMigration054Upgrade('pylva_migration_054_owner');
      try {
        const [databaseOwnerMembership] = await scratch.sql<{ can_set: boolean }[]>`
          SELECT pg_catalog.pg_has_role(
            CURRENT_USER, 'pg_database_owner', 'SET'
          ) AS can_set
        `;
        expect(databaseOwnerMembership?.can_set).toBe(true);
        await scratch.sql.unsafe(
          `ALTER TABLE public.${RESTORED_AUDIT_PARTITION} OWNER TO pg_database_owner`,
        );

        const contract = await auditPartitionContract(scratch);
        expect(contract.mismatched_bounds).toBe(0);
        expect(contract.owned_by_current_user).toBe(contract.partition_count - 1);
        const mismatchedPartition = (await auditPartitions(scratch)).find(
          (partition) => partition.name === RESTORED_AUDIT_PARTITION,
        );
        expect(mismatchedPartition?.owner).toBe('pg_database_owner');

        const before = await migration054UpgradeSnapshot(scratch);
        await expectRawMigration054Failure(
          scratch,
          '42501',
          new RegExp(
            `ownership upgrade precondition failed for public\\.${RESTORED_AUDIT_PARTITION}`,
            'u',
          ),
        );
        expect(await migration054UpgradeSnapshot(scratch)).toEqual(before);
        expect(await auditPartitionContract(scratch)).toEqual(contract);
        expect(
          (await auditPartitions(scratch)).find(
            (partition) => partition.name === RESTORED_AUDIT_PARTITION,
          )?.owner,
        ).toBe('pg_database_owner');
        const [functionProbe] = await scratch.sql<{ function_oid: string | null }[]>`
          SELECT pg_catalog.to_regprocedure(
            'public.pylva_ensure_audit_log_partition(date)'
          )::TEXT AS function_oid
        `;
        expect(functionProbe?.function_oid).toBeNull();
      } finally {
        await scratch.drop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'serializes concurrent runners against the same fresh database',
    async () => {
      const scratch = await createScratchDb();
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pylva-migrate-concurrent-'));
      const tempMigrationsDir = path.join(tempRoot, 'db/migrations');
      const firstSql = postgres(scratch.url, { max: 1, onnotice: () => undefined });
      const secondSql = postgres(scratch.url, { max: 1, onnotice: () => undefined });

      try {
        await fs.mkdir(tempMigrationsDir, { recursive: true });
        await fs.writeFile(
          path.join(tempMigrationsDir, '001_concurrent.sql'),
          `SELECT pg_sleep(0.25);
CREATE TABLE concurrent_migration_probe (id integer PRIMARY KEY);`,
          'utf8',
        );

        const [first, second] = await Promise.all([
          runMigrateWithSql(firstSql, tempMigrationsDir, {
            mode: 'apply',
            yes: false,
            json: false,
          }),
          runMigrateWithSql(secondSql, tempMigrationsDir, {
            mode: 'apply',
            yes: false,
            json: false,
          }),
        ]);

        expect([first.exitCode, second.exitCode]).toEqual([0, 0]);
        expect([...first.errors, ...second.errors]).toEqual([]);
        expect([...appliedLogFilenames(first.logs), ...appliedLogFilenames(second.logs)]).toEqual([
          '001_concurrent.sql',
        ]);

        const rows = await scratch.sql<{ filename: string }[]>`
          SELECT filename FROM schema_migrations ORDER BY filename
        `;
        expect(rows.map((row) => row.filename)).toEqual(['001_concurrent.sql']);
      } finally {
        await firstSql.end();
        await secondSql.end();
        await fs.rm(tempRoot, { force: true, recursive: true });
        await scratch.drop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps the ledger at the last successful file after an interrupted run',
    async () => {
      const scratch = await createScratchDb();
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pylva-migrate-interrupt-'));
      const tempMigrationsDir = path.join(tempRoot, 'db/migrations');

      try {
        await fs.mkdir(tempMigrationsDir, { recursive: true });
        await fs.writeFile(
          path.join(tempMigrationsDir, '001_valid.sql'),
          'CREATE TABLE migration_one (id integer PRIMARY KEY);',
          'utf8',
        );
        await fs.writeFile(
          path.join(tempMigrationsDir, '002_bad.sql'),
          'CREATE TABLE migration_two (id integer PRIMARY KEY',
          'utf8',
        );
        await fs.writeFile(
          path.join(tempMigrationsDir, '003_valid.sql'),
          'CREATE TABLE migration_three (id integer PRIMARY KEY);',
          'utf8',
        );

        const logs: string[] = [];
        const errors: string[] = [];
        const firstExitCode = await runDbMigrate(
          { mode: 'apply', yes: false, json: false },
          {
            sql: scratch.sql,
            migrationsDir: tempMigrationsDir,
            log: (line) => logs.push(line),
            error: (line) => errors.push(line),
          },
        );
        expect(firstExitCode).toBe(1);
        expect(errors.join('\n')).toContain('002_bad.sql');

        const afterFailure = await scratch.sql<{ filename: string; applied_at: Date | string }[]>`
          SELECT filename, applied_at
          FROM schema_migrations
          ORDER BY filename
        `;
        expect(afterFailure.map((row) => row.filename)).toEqual(['001_valid.sql']);
        const firstAppliedAt = timestampValue(afterFailure[0]!.applied_at);

        await fs.writeFile(
          path.join(tempMigrationsDir, '002_bad.sql'),
          'CREATE TABLE migration_two (id integer PRIMARY KEY);',
          'utf8',
        );

        const secondLogs: string[] = [];
        const secondErrors: string[] = [];
        const secondExitCode = await runDbMigrate(
          { mode: 'apply', yes: false, json: false },
          {
            sql: scratch.sql,
            migrationsDir: tempMigrationsDir,
            log: (line) => secondLogs.push(line),
            error: (line) => secondErrors.push(line),
          },
        );
        expect(secondErrors).toEqual([]);
        expect(secondExitCode).toBe(0);
        expect(appliedLogFilenames(secondLogs)).toEqual(['002_bad.sql', '003_valid.sql']);

        const finalRows = await scratch.sql<{ filename: string; applied_at: Date | string }[]>`
          SELECT filename, applied_at
          FROM schema_migrations
          ORDER BY filename
        `;
        expect(finalRows.map((row) => row.filename)).toEqual([
          '001_valid.sql',
          '002_bad.sql',
          '003_valid.sql',
        ]);
        expect(timestampValue(finalRows[0]!.applied_at)).toBe(firstAppliedAt);
      } finally {
        await fs.rm(tempRoot, { force: true, recursive: true });
        await scratch.drop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'baselines through 040 and catches up through the current head',
    async () => {
      const scratch = await createScratchDb();
      try {
        await applyMigrationsThrough(scratch, '040');
        const baseline = await baselineThrough040(scratch);
        const through040 = (await migrationFilenames()).filter(
          (filename) => migrationPrefix(filename) <= 40,
        );
        expect(baseline.logs).toContain(`${through040.length} file(s)`);

        let rows = await ledgerRows(scratch);
        expect(rows).toHaveLength(through040.length);
        expect(rows.every((row) => row.applied_by === 'baseline')).toBe(true);

        const catchUp = await runMigrate(scratch, { mode: 'apply', yes: false, json: false });
        expect(catchUp.exitCode).toBe(0);
        expect(appliedLogFilenames(catchUp.logs)).toEqual(
          (await migrationFilenames()).filter((filename) => migrationPrefix(filename) >= 41),
        );

        const status = await runMigrate(scratch, { mode: 'status', yes: false, json: true });
        expect(status.exitCode).toBe(0);
        expect(JSON.parse(status.logs[0]!)).toMatchObject({ state: 'in_sync' });

        rows = await assertCompleteLedger(scratch, (filename) =>
          migrationPrefix(filename) <= 40 ? 'baseline' : 'db:migrate',
        );
        expect(rows.filter((row) => row.applied_by === 'baseline')).toHaveLength(through040.length);
      } finally {
        await scratch.drop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'applies pre_roll migrations before the deferred universal-scope post_roll migration',
    async () => {
      const scratch = await createScratchDb();
      try {
        await legacy040WithBaseline(scratch);

        const preRoll = await runMigrate(scratch, {
          mode: 'apply',
          phase: 'pre_roll',
          yes: false,
          json: false,
        });
        expect(preRoll.exitCode).toBe(0);
        expect(appliedLogFilenames(preRoll.logs)).toEqual(
          (await migrationFilenames()).filter(
            (filename) => migrationPrefix(filename) >= 41 && migrationPrefix(filename) < 48,
          ),
        );

        const preRollStatus = await runMigrate(scratch, {
          mode: 'status',
          phase: 'pre_roll',
          yes: false,
          json: true,
        });
        expect(preRollStatus.exitCode).toBe(0);
        expect(JSON.parse(preRollStatus.logs[0]!)).toMatchObject({
          phase: 'pre_roll',
          state: 'in_sync',
          pending: [],
          deferred_pending: [
            '048_universal_api_key_scope.sql',
            '049_backfill_builder_owner_memberships.sql',
            AUTHORITATIVE_BUDGET_LEDGER_MIGRATION,
            AUTHORITATIVE_BUDGET_RUNTIME_MIGRATION,
            AUTHORITATIVE_BUDGET_RUNTIME_ROLES_MIGRATION,
            AUTHORITATIVE_BUDGET_LEGACY_RLS_COMPATIBILITY_MIGRATION,
            GENERAL_APP_RUNTIME_OWNER_BOUNDARY_MIGRATION,
          ],
        });

        const postRoll = await runMigrate(scratch, {
          mode: 'apply',
          phase: 'post_roll',
          yes: false,
          json: false,
        });
        expect(postRoll.exitCode).toBe(0);
        expect(appliedLogFilenames(postRoll.logs)).toEqual([
          '048_universal_api_key_scope.sql',
          '049_backfill_builder_owner_memberships.sql',
          AUTHORITATIVE_BUDGET_LEDGER_MIGRATION,
          AUTHORITATIVE_BUDGET_RUNTIME_MIGRATION,
          AUTHORITATIVE_BUDGET_RUNTIME_ROLES_MIGRATION,
          AUTHORITATIVE_BUDGET_LEGACY_RLS_COMPATIBILITY_MIGRATION,
          GENERAL_APP_RUNTIME_OWNER_BOUNDARY_MIGRATION,
        ]);

        await assertCompleteLedger(scratch, (filename) =>
          migrationPrefix(filename) <= 40 ? 'baseline' : 'db:migrate',
        );
      } finally {
        await scratch.drop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports status through the real CLI for in-sync and pending scratch databases',
    async () => {
      const inSync = await createScratchDb();
      const pending = await createScratchDb();

      try {
        await legacy040WithBaseline(inSync);
        const catchUp = await runMigrate(inSync, { mode: 'apply', yes: false, json: false });
        expect(catchUp.exitCode).toBe(0);

        const inSyncCli = spawnDbMigrateStatus(inSync.url);
        expect(inSyncCli.status).toBe(0);
        expect(JSON.parse(inSyncCli.stdout.trim())).toMatchObject({ state: 'in_sync' });

        await legacy040WithBaseline(pending);
        const pendingCli = spawnDbMigrateStatus(pending.url);
        expect(pendingCli.status).toBe(1);
        expect(JSON.parse(pendingCli.stdout.trim())).toMatchObject({
          state: 'pending',
          pending: expect.arrayContaining(['041_rename_api_key_scopes.sql']),
        });
      } finally {
        await pending.drop();
        await inSync.drop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'records db:setup migrations on a fresh database',
    async () => {
      const scratch = await createScratchDb();
      try {
        const setup = spawnDbSetup(scratch.url);
        expect(setup.status).toBe(0);

        const rows = await ledgerRows(scratch);
        expect(rows).toHaveLength((await migrationFilenames()).length);
        expect(rows.every((row) => row.applied_by === 'db:setup')).toBe(true);
      } finally {
        await scratch.drop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses db:setup on an untracked existing database',
    async () => {
      const scratch = await createScratchDb();
      try {
        await applyMigrationsThrough(scratch, '040');

        const setup = spawnDbSetup(scratch.url);
        expect(setup.status).not.toBe(0);
        expect(`${setup.stdout}\n${setup.stderr}`).toContain('--baseline');
      } finally {
        await scratch.drop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
