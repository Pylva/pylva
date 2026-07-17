import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';

export const CI_POSTGRES_ADMIN_ROLE = 'pylva' as const;
export const CI_POSTGRES_MIGRATION_ROLE = 'pylva_migration_ci' as const;
export const CI_POSTGRES_ADMIN_URL_ENV = 'CI_POSTGRES_ADMIN_URL' as const;
export const MIGRATION_DATABASE_URL_ENV = 'MIGRATION_DATABASE_URL' as const;

interface ParsedPostgresUrl {
  raw: string;
  username: string;
  password: string;
  hostname: string;
  port: string;
  database: string;
}

export interface BootstrapMigrationRoleConfig {
  adminUrl: string;
  migrationUrl: string;
  adminUsername: typeof CI_POSTGRES_ADMIN_ROLE;
  migrationUsername: typeof CI_POSTGRES_MIGRATION_ROLE;
  migrationPassword: string;
  database: string;
}

export interface BootstrapSqlClient {
  unsafe(query: string): Promise<ReadonlyArray<Record<string, unknown>>>;
  end(options?: { timeout?: number }): Promise<void>;
}

export type BootstrapSqlClientFactory = (databaseUrl: string) => BootstrapSqlClient;

interface RolePosture {
  currentUser: string;
  sessionUser: string;
  roleName: string;
  canLogin: boolean;
  inherit: boolean;
  superuser: boolean;
  createDatabase: boolean;
  createRole: boolean;
  replication: boolean;
  bypassRls: boolean;
  connectionLimit: number;
  validUntil: string | null;
  roleConfig: string | null;
}

interface DatabasePosture {
  databaseName: string;
  ownerName: string;
  canConnect: boolean;
  canCreate: boolean;
  canCreateTemporary: boolean;
  canUsePublicSchema: boolean;
  canCreateInPublicSchema: boolean;
}

const ROLE_POSTURE_QUERY = `
  SELECT current_user::pg_catalog.text AS current_user_name,
         session_user::pg_catalog.text AS session_user_name,
         role.rolname::pg_catalog.text AS role_name,
         role.rolcanlogin AS can_login,
         role.rolinherit AS inherits_privileges,
         role.rolsuper AS is_superuser,
         role.rolcreatedb AS can_create_database,
         role.rolcreaterole AS can_create_role,
         role.rolreplication AS can_replicate,
         role.rolbypassrls AS bypasses_rls,
         role.rolconnlimit AS connection_limit,
         role.rolvaliduntil::pg_catalog.text AS valid_until,
         role.rolconfig::pg_catalog.text AS role_config
  FROM pg_catalog.pg_roles AS role
  WHERE role.rolname = current_user
`;

const DATABASE_POSTURE_QUERY = `
  SELECT database.datname::pg_catalog.text AS database_name,
         owner.rolname::pg_catalog.text AS owner_name,
         pg_catalog.has_database_privilege(
           current_user,
           database.oid,
           'CONNECT'
         ) AS can_connect,
         pg_catalog.has_database_privilege(
           current_user,
           database.oid,
           'CREATE'
         ) AS can_create,
         pg_catalog.has_database_privilege(
           current_user,
           database.oid,
           'TEMP'
         ) AS can_create_temporary,
         pg_catalog.has_schema_privilege(
           current_user,
           'public',
           'USAGE'
         ) AS can_use_public_schema,
         pg_catalog.has_schema_privilege(
           current_user,
           'public',
           'CREATE'
         ) AS can_create_in_public_schema
  FROM pg_catalog.pg_database AS database
  JOIN pg_catalog.pg_roles AS owner ON owner.oid = database.datdba
  WHERE database.datname = current_database()
`;

function required(source: Record<string, string | undefined>, name: string): string {
  const value = source[name]?.trim();
  assert.ok(value, `${name} is required`);
  return value;
}

function decodeUrlPart(value: string, name: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`${name} contains invalid percent encoding`);
  }
}

function parsePostgresUrl(raw: string, name: string): ParsedPostgresUrl {
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL URL`);
  }

  if (!/^postgres(?:ql)?:$/u.test(target.protocol)) {
    throw new Error(`${name} must use the postgres or postgresql protocol`);
  }

  const username = decodeUrlPart(target.username, name);
  const password = decodeUrlPart(target.password, name);
  const database = decodeUrlPart(target.pathname.replace(/^\//u, ''), name);
  if (!username || !target.hostname || !database) {
    throw new Error(`${name} must include a username, host, and database`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(username) || /[\u0000-\u001f\u007f]/u.test(database)) {
    throw new Error(`${name} contains an unsafe username or database name`);
  }

  return {
    raw,
    username,
    password,
    hostname: target.hostname,
    port: target.port || '5432',
    database,
  };
}

export function parseBootstrapMigrationRoleConfig(
  source: Record<string, string | undefined>,
): BootstrapMigrationRoleConfig {
  const admin = parsePostgresUrl(
    required(source, CI_POSTGRES_ADMIN_URL_ENV),
    CI_POSTGRES_ADMIN_URL_ENV,
  );
  const migration = parsePostgresUrl(
    required(source, MIGRATION_DATABASE_URL_ENV),
    MIGRATION_DATABASE_URL_ENV,
  );

  if (admin.username !== CI_POSTGRES_ADMIN_ROLE) {
    throw new Error(`${CI_POSTGRES_ADMIN_URL_ENV} must identify the fixed CI admin role`);
  }
  if (migration.username !== CI_POSTGRES_MIGRATION_ROLE) {
    throw new Error(`${MIGRATION_DATABASE_URL_ENV} must identify the fixed CI migration role`);
  }
  if (!migration.password) {
    throw new Error(`${MIGRATION_DATABASE_URL_ENV} must include a migration-role password`);
  }
  if (!admin.password) {
    throw new Error(`${CI_POSTGRES_ADMIN_URL_ENV} must include an admin-role password`);
  }
  if (
    admin.hostname !== migration.hostname ||
    admin.port !== migration.port ||
    admin.database !== migration.database
  ) {
    throw new Error(
      'CI PostgreSQL admin and migration URLs must target the same database endpoint',
    );
  }

  return {
    adminUrl: admin.raw,
    migrationUrl: migration.raw,
    adminUsername: CI_POSTGRES_ADMIN_ROLE,
    migrationUsername: CI_POSTGRES_MIGRATION_ROLE,
    migrationPassword: migration.password,
    database: migration.database,
  };
}

function quoteIdentifier(value: string): string {
  assert.ok(value.length > 0 && !/[\u0000-\u001f\u007f]/u.test(value), 'unsafe identifier');
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  assert.ok(!value.includes('\u0000'), 'unsafe literal');
  return `'${value.replaceAll("'", "''")}'`;
}

function field<T extends boolean | number | string | null>(
  row: Record<string, unknown>,
  name: string,
  expectedType: 'boolean' | 'number' | 'string-or-null',
): T {
  const value = row[name];
  const valid =
    expectedType === 'string-or-null'
      ? value === null || typeof value === 'string'
      : typeof value === expectedType;
  if (!valid) {
    throw new Error('CI PostgreSQL posture query returned an invalid shape');
  }
  return value as T;
}

function parseRolePosture(rows: ReadonlyArray<Record<string, unknown>>): RolePosture {
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new Error('CI PostgreSQL role posture query returned an invalid row count');
  }
  const row = rows[0];
  return {
    currentUser: field(row, 'current_user_name', 'string-or-null'),
    sessionUser: field(row, 'session_user_name', 'string-or-null'),
    roleName: field(row, 'role_name', 'string-or-null'),
    canLogin: field(row, 'can_login', 'boolean'),
    inherit: field(row, 'inherits_privileges', 'boolean'),
    superuser: field(row, 'is_superuser', 'boolean'),
    createDatabase: field(row, 'can_create_database', 'boolean'),
    createRole: field(row, 'can_create_role', 'boolean'),
    replication: field(row, 'can_replicate', 'boolean'),
    bypassRls: field(row, 'bypasses_rls', 'boolean'),
    connectionLimit: field(row, 'connection_limit', 'number'),
    validUntil: field(row, 'valid_until', 'string-or-null'),
    roleConfig: field(row, 'role_config', 'string-or-null'),
  };
}

function parseDatabasePosture(rows: ReadonlyArray<Record<string, unknown>>): DatabasePosture {
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new Error('CI PostgreSQL database posture query returned an invalid row count');
  }
  const row = rows[0];
  return {
    databaseName: field(row, 'database_name', 'string-or-null'),
    ownerName: field(row, 'owner_name', 'string-or-null'),
    canConnect: field(row, 'can_connect', 'boolean'),
    canCreate: field(row, 'can_create', 'boolean'),
    canCreateTemporary: field(row, 'can_create_temporary', 'boolean'),
    canUsePublicSchema: field(row, 'can_use_public_schema', 'boolean'),
    canCreateInPublicSchema: field(row, 'can_create_in_public_schema', 'boolean'),
  };
}

async function queryRows(
  client: BootstrapSqlClient,
  query: string,
  failureMessage: string,
): Promise<ReadonlyArray<Record<string, unknown>>> {
  try {
    return await client.unsafe(query);
  } catch {
    throw new Error(failureMessage);
  }
}

async function runStatement(
  client: BootstrapSqlClient,
  query: string,
  failureMessage: string,
): Promise<void> {
  await queryRows(client, query, failureMessage);
}

async function closeClient(client: BootstrapSqlClient): Promise<void> {
  try {
    await client.end({ timeout: 5 });
  } catch {
    throw new Error('CI PostgreSQL bootstrap connection did not close cleanly');
  }
}

async function readRolePosture(
  client: BootstrapSqlClient,
  failureMessage: string,
): Promise<RolePosture> {
  return parseRolePosture(await queryRows(client, ROLE_POSTURE_QUERY, failureMessage));
}

function assertAdminPosture(posture: RolePosture, expectedUsername: string): void {
  if (
    posture.currentUser !== expectedUsername ||
    posture.sessionUser !== expectedUsername ||
    posture.roleName !== expectedUsername ||
    !posture.canLogin ||
    !posture.superuser
  ) {
    throw new Error('CI PostgreSQL admin identity or posture is unsafe');
  }
}

function assertMigrationRolePosture(posture: RolePosture, expectedUsername: string): void {
  if (
    posture.currentUser !== expectedUsername ||
    posture.sessionUser !== expectedUsername ||
    posture.roleName !== expectedUsername ||
    !posture.canLogin ||
    !posture.inherit ||
    posture.superuser ||
    !posture.createDatabase ||
    !posture.createRole ||
    posture.replication ||
    posture.bypassRls ||
    posture.connectionLimit !== -1 ||
    posture.validUntil !== 'infinity' ||
    posture.roleConfig !== null
  ) {
    throw new Error('CI PostgreSQL migration role failed strict attribute attestation');
  }
}

function assertMigrationDatabasePosture(
  posture: DatabasePosture,
  expectedDatabase: string,
  expectedOwner: string,
): void {
  if (
    posture.databaseName !== expectedDatabase ||
    posture.ownerName !== expectedOwner ||
    !posture.canConnect ||
    !posture.canCreate ||
    !posture.canCreateTemporary ||
    !posture.canUsePublicSchema ||
    !posture.canCreateInPublicSchema
  ) {
    throw new Error('CI PostgreSQL migration role failed database-owner attestation');
  }
}

function defaultClientFactory(databaseUrl: string): BootstrapSqlClient {
  let sql: ReturnType<typeof postgres>;
  try {
    sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  } catch {
    throw new Error('CI PostgreSQL bootstrap client configuration failed');
  }
  return {
    unsafe: async (query) =>
      (await sql.unsafe(query)) as unknown as ReadonlyArray<Record<string, unknown>>,
    end: async (options) => {
      await sql.end(options);
    },
  };
}

export async function bootstrapAuthoritativeBudgetMigrationRole(
  source: Record<string, string | undefined>,
  clientFactory: BootstrapSqlClientFactory = defaultClientFactory,
): Promise<void> {
  const config = parseBootstrapMigrationRoleConfig(source);
  const migrationRole = quoteIdentifier(config.migrationUsername);
  const migrationPassword = quoteLiteral(config.migrationPassword);
  const database = quoteIdentifier(config.database);

  let adminClient: BootstrapSqlClient;
  try {
    adminClient = clientFactory(config.adminUrl);
  } catch {
    throw new Error('CI PostgreSQL admin bootstrap client could not be created');
  }

  try {
    const adminBefore = await readRolePosture(
      adminClient,
      'CI PostgreSQL admin pre-attestation query failed',
    );
    assertAdminPosture(adminBefore, config.adminUsername);

    await runStatement(
      adminClient,
      `
        DO $create_ci_migration_role$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_catalog.pg_roles
            WHERE rolname = ${quoteLiteral(config.migrationUsername)}
          ) THEN
            CREATE ROLE ${migrationRole} LOGIN;
          END IF;
        END;
        $create_ci_migration_role$;
      `,
      'CI PostgreSQL migration role creation failed',
    );
    await runStatement(
      adminClient,
      `
        ALTER ROLE ${migrationRole}
          LOGIN
          INHERIT
          NOSUPERUSER
          CREATEDB
          CREATEROLE
          NOREPLICATION
          NOBYPASSRLS
          CONNECTION LIMIT -1
          PASSWORD ${migrationPassword}
          VALID UNTIL 'infinity'
      `,
      'CI PostgreSQL migration role normalization failed',
    );
    await runStatement(
      adminClient,
      `ALTER ROLE ${migrationRole} RESET ALL`,
      'CI PostgreSQL migration role configuration reset failed',
    );
    await runStatement(
      adminClient,
      `ALTER DATABASE ${database} OWNER TO ${migrationRole}`,
      'CI PostgreSQL target database ownership transfer failed',
    );

    const adminAfter = await readRolePosture(
      adminClient,
      'CI PostgreSQL admin post-attestation query failed',
    );
    assertAdminPosture(adminAfter, config.adminUsername);
    if (JSON.stringify(adminAfter) !== JSON.stringify(adminBefore)) {
      throw new Error('CI PostgreSQL admin role changed during migration-role bootstrap');
    }
  } finally {
    await closeClient(adminClient);
  }

  let migrationClient: BootstrapSqlClient;
  try {
    migrationClient = clientFactory(config.migrationUrl);
  } catch {
    throw new Error('CI PostgreSQL migration attestation client could not be created');
  }

  try {
    const rolePosture = await readRolePosture(
      migrationClient,
      'CI PostgreSQL migration-role post-attestation query failed',
    );
    assertMigrationRolePosture(rolePosture, config.migrationUsername);

    const databasePosture = parseDatabasePosture(
      await queryRows(
        migrationClient,
        DATABASE_POSTURE_QUERY,
        'CI PostgreSQL migration database-owner post-attestation query failed',
      ),
    );
    assertMigrationDatabasePosture(databasePosture, config.database, config.migrationUsername);
  } finally {
    await closeClient(migrationClient);
  }
}

export function isMainModule(importMetaUrl: string, argvPath: string | undefined): boolean {
  return argvPath !== undefined && importMetaUrl === pathToFileURL(argvPath).href;
}

async function main(): Promise<void> {
  await bootstrapAuthoritativeBudgetMigrationRole(process.env);
  process.stdout.write('AUTHORITATIVE_BUDGET_MIGRATION_ROLE_BOOTSTRAPPED\n');
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : 'unknown bootstrap failure';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
