import { ClickHouseLogLevel, createClient, type ClickHouseClient } from '@clickhouse/client';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BUDGET_PROJECTION_CLICKHOUSE_ROLE,
  GENERAL_CLICKHOUSE_APP_ROLE,
  parseClickHousePrincipal,
  resolveBudgetProjectionClickHouseConfig,
} from '../src/lib/budget-projection/clickhouse-config.js';
import {
  authoritativeBudgetInsertRevokeAllExcept,
  buildAuthoritativeBudgetClickHouseRbacStatements,
  exactGrantLines,
  expectedAuthoritativeBudgetClickHouseGrants,
  quoteClickHouseIdentifier,
} from '../src/lib/budget-projection/clickhouse-rbac.js';

async function readLines(client: ClickHouseClient, query: string): Promise<string[]> {
  const result = await client.exec({ query });
  let output = '';
  const decoder = new TextDecoder();
  for await (const chunk of result.stream) {
    output +=
      typeof chunk === 'string' ? chunk : decoder.decode(chunk as Uint8Array, { stream: true });
    if (output.length > 32_768) throw new Error('ClickHouse grant output exceeded its bound');
  }
  output += decoder.decode();
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function validateClient(
  client: ClickHouseClient,
  username: string,
  database: string,
  role: string,
  direct: readonly string[],
  roleGrants: readonly string[],
): Promise<void> {
  const identityResult = await client.query({
    query: `SELECT currentUser() AS current_user,
                   currentDatabase() AS current_database,
                   currentRoles() AS current_roles,
                   enabledRoles() AS enabled_roles,
                   defaultRoles() AS default_roles`,
    format: 'JSONEachRow',
  });
  const rows = (await identityResult.json()) as Array<{
    current_database?: unknown;
    current_roles?: unknown;
    current_user?: unknown;
    default_roles?: unknown;
    enabled_roles?: unknown;
  }>;
  if (
    rows.length !== 1 ||
    rows[0]?.current_user !== username ||
    rows[0]?.current_database !== database ||
    ![rows[0]?.current_roles, rows[0]?.enabled_roles, rows[0]?.default_roles].every(
      (roles) => Array.isArray(roles) && roles.length === 1 && roles[0] === role,
    )
  ) {
    throw new Error('ClickHouse RBAC identity validation failed');
  }
  if (!exactGrantLines(await readLines(client, 'SHOW GRANTS'), direct)) {
    throw new Error('ClickHouse direct role validation failed');
  }
  if (
    !exactGrantLines(
      await readLines(client, `SHOW GRANTS FOR ${quoteClickHouseIdentifier(role)}`),
      roleGrants,
    )
  ) {
    throw new Error('ClickHouse fixed-role grant validation failed');
  }
}

interface RoleGrantRow {
  granted_role_name?: unknown;
  role_name?: unknown;
  user_name?: unknown;
}

async function revokeExistingRoleAssignments(admin: ClickHouseClient): Promise<void> {
  const response = await admin.query({
    query: `SELECT user_name, role_name, granted_role_name
            FROM system.role_grants
            WHERE granted_role_name IN {roles:Array(String)}
            ORDER BY granted_role_name, user_name, role_name`,
    query_params: {
      roles: [BUDGET_PROJECTION_CLICKHOUSE_ROLE, GENERAL_CLICKHOUSE_APP_ROLE],
    },
    format: 'JSONEachRow',
  });
  const rows = (await response.json()) as RoleGrantRow[];
  for (const row of rows) {
    if (
      typeof row.granted_role_name !== 'string' ||
      (typeof row.user_name !== 'string' && typeof row.role_name !== 'string')
    ) {
      throw new Error('ClickHouse role-assignment catalog validation failed');
    }
    const grantee = typeof row.user_name === 'string' ? row.user_name : (row.role_name as string);
    await admin.command({
      query: `REVOKE ${quoteClickHouseIdentifier(row.granted_role_name)} FROM ${quoteClickHouseIdentifier(grantee)}`,
    });
  }
}

async function convergeExclusiveAuthoritativeWriter(
  admin: ClickHouseClient,
  database: string,
  adminUsername: string,
  projectorUsername: string,
): Promise<void> {
  await admin.command({
    query: authoritativeBudgetInsertRevokeAllExcept(database, [
      BUDGET_PROJECTION_CLICKHOUSE_ROLE,
      adminUsername,
    ]),
  });

  const writers = await admin.query({
    query: `
      WITH
        {database:String} AS target_database,
        'budget_cost_events' AS target_table,
        target_columns AS
        (
          SELECT name AS target_column
          FROM system.columns
          WHERE database = target_database AND table = target_table
        ),
        candidates AS
        (
          SELECT
            if(isNull(g.user_name), 'role', 'user') AS principal_type,
            coalesce(g.user_name, g.role_name) AS principal_name,
            c.target_column,
            g.is_partial_revoke,
            multiIf(
              isNull(g.database), toUInt8(0),
              isNull(g.table), toUInt8(1),
              isNull(g.column), toUInt8(2),
              toUInt8(3)
            ) AS specificity
          FROM system.grants AS g
          CROSS JOIN target_columns AS c
          WHERE g.access_type IN ('ALL', 'INSERT')
            AND NOT (g.is_partial_revoke = 1 AND g.grant_option = 1)
            AND (
              isNull(g.database)
              OR (
                g.database = target_database
                AND (
                  isNull(g.table)
                  OR (
                    g.table = target_table
                    AND (isNull(g.column) OR g.column = c.target_column)
                  )
                )
              )
            )
        ),
        effective_columns AS
        (
          SELECT
            principal_type,
            principal_name,
            target_column,
            argMax(
              toUInt8(is_partial_revoke = 0),
              tuple(specificity, is_partial_revoke)
            ) AS can_insert
          FROM candidates
          GROUP BY principal_type, principal_name, target_column
        )
      SELECT principal_type,
             principal_name,
             countIf(can_insert = 1) AS writable_column_count
      FROM effective_columns
      GROUP BY principal_type, principal_name
      HAVING writable_column_count > 0
      ORDER BY principal_type, principal_name
    `,
    query_params: { database },
    format: 'JSONEachRow',
  });
  const writerRows = (await writers.json()) as Array<{
    principal_name?: unknown;
    principal_type?: unknown;
    writable_column_count?: unknown;
  }>;
  let projectorRolePresent = false;
  for (const row of writerRows) {
    if (
      (row.principal_type !== 'role' && row.principal_type !== 'user') ||
      typeof row.principal_name !== 'string' ||
      (typeof row.writable_column_count !== 'number' &&
        typeof row.writable_column_count !== 'string')
    ) {
      throw new Error('ClickHouse authoritative writer catalog validation failed');
    }
    if (row.principal_type === 'role' && row.principal_name === BUDGET_PROJECTION_CLICKHOUSE_ROLE) {
      if (projectorRolePresent) {
        throw new Error('ClickHouse projector writer catalog validation failed');
      }
      projectorRolePresent = true;
      continue;
    }
    if (row.principal_type === 'user' && row.principal_name === adminUsername) continue;
    throw new Error('ClickHouse authoritative writer exclusivity validation failed');
  }
  if (!projectorRolePresent) {
    throw new Error('ClickHouse projector writer catalog validation failed');
  }

  const assignments = await admin.query({
    query: `
      SELECT user_name,
             role_name,
             granted_role_name,
             granted_role_is_default,
             with_admin_option
      FROM system.role_grants
      WHERE granted_role_name = {projector_role:String}
         OR role_name = {projector_role:String}
      ORDER BY user_name, role_name, granted_role_name
    `,
    query_params: { projector_role: BUDGET_PROJECTION_CLICKHOUSE_ROLE },
    format: 'JSONEachRow',
  });
  const assignmentRows = (await assignments.json()) as Array<{
    granted_role_is_default?: unknown;
    granted_role_name?: unknown;
    role_name?: unknown;
    user_name?: unknown;
    with_admin_option?: unknown;
  }>;
  if (
    assignmentRows.length !== 1 ||
    assignmentRows[0]?.user_name !== projectorUsername ||
    assignmentRows[0]?.role_name !== null ||
    assignmentRows[0]?.granted_role_name !== BUDGET_PROJECTION_CLICKHOUSE_ROLE ||
    assignmentRows[0]?.granted_role_is_default !== 1 ||
    assignmentRows[0]?.with_admin_option !== 0
  ) {
    throw new Error('ClickHouse projector role exclusivity validation failed');
  }
}

export interface AuthoritativeBudgetClickHouseProvisionOptions {
  /** Real integration tests only; the command-line entrypoint never enables it. */
  allowInsecureLoopbackForTests?: boolean;
}

export async function provisionAuthoritativeBudgetClickHouseRbac(
  source: Record<string, string | undefined>,
  options: AuthoritativeBudgetClickHouseProvisionOptions = {},
): Promise<void> {
  const adminUrl = source['CLICKHOUSE_ADMIN_URL']?.trim();
  if (!adminUrl) {
    throw new Error('CLICKHOUSE_ADMIN_URL is required for ClickHouse RBAC provisioning');
  }
  const config = resolveBudgetProjectionClickHouseConfig(
    {
      ...source,
      NODE_ENV: 'production',
      ALLOW_BUDGET_PROJECTION_CLICKHOUSE_URL_FALLBACK: 'false',
    },
    options,
  );
  const generalUrl = source['CLICKHOUSE_URL']?.trim();
  if (!generalUrl) throw new Error('CLICKHOUSE_URL is required for ClickHouse RBAC provisioning');

  const adminPrincipal = parseClickHousePrincipal(adminUrl, 'CLICKHOUSE_ADMIN_URL');
  const generalPrincipal = parseClickHousePrincipal(generalUrl, 'CLICKHOUSE_URL');
  const allowInsecureAdminForTest =
    options.allowInsecureLoopbackForTests === true &&
    ['127.0.0.1', '::1', 'localhost'].includes(adminPrincipal.hostname);
  if (adminPrincipal.protocol !== 'https:' && !allowInsecureAdminForTest) {
    throw new Error('CLICKHOUSE_ADMIN_URL must use https:// transport');
  }
  if (
    (adminPrincipal.username === 'default' || !adminPrincipal.passwordPresent) &&
    !allowInsecureAdminForTest
  ) {
    throw new Error('CLICKHOUSE_ADMIN_URL must contain a non-default username and credential');
  }
  if (adminPrincipal.origin !== generalPrincipal.origin) {
    throw new Error('CLICKHOUSE_ADMIN_URL must address the same ClickHouse origin');
  }
  if (
    adminPrincipal.username === config.expectedGeneralUsername ||
    adminPrincipal.username === config.expectedProjectorUsername
  ) {
    throw new Error('CLICKHOUSE_ADMIN_URL must use a separate provisioning principal');
  }

  const identity = {
    database: config.database,
    generalUsername: config.expectedGeneralUsername,
    projectorUsername: config.expectedProjectorUsername,
  };
  const admin = createClient({
    url: adminUrl,
    request_timeout: 30_000,
    log: { level: ClickHouseLogLevel.OFF },
  });
  try {
    const statements = buildAuthoritativeBudgetClickHouseRbacStatements(identity);
    for (const query of statements.slice(0, 2)) {
      await admin.command({ query });
    }
    await revokeExistingRoleAssignments(admin);
    for (const query of statements.slice(2)) {
      await admin.command({ query });
    }
    await convergeExclusiveAuthoritativeWriter(
      admin,
      config.database,
      adminPrincipal.username,
      config.expectedProjectorUsername,
    );
  } finally {
    await admin.close();
  }

  const projector = createClient({
    url: config.connectionUrl,
    request_timeout: 30_000,
    log: { level: ClickHouseLogLevel.OFF },
  });
  const general = createClient({
    url: generalUrl,
    request_timeout: 30_000,
    log: { level: ClickHouseLogLevel.OFF },
  });
  try {
    const expected = expectedAuthoritativeBudgetClickHouseGrants(identity);
    await Promise.all([
      validateClient(
        projector,
        config.expectedProjectorUsername,
        config.database,
        BUDGET_PROJECTION_CLICKHOUSE_ROLE,
        expected.projectorDirect,
        expected.projectorRole,
      ),
      validateClient(
        general,
        config.expectedGeneralUsername,
        config.database,
        GENERAL_CLICKHOUSE_APP_ROLE,
        expected.generalDirect,
        expected.generalRole,
      ),
    ]);
  } finally {
    await Promise.all([projector.close(), general.close()]);
  }
}

const entrypoint = process.argv[1];
const invokedDirectly =
  entrypoint !== undefined && import.meta.url === pathToFileURL(path.resolve(entrypoint)).href;
if (invokedDirectly) {
  void provisionAuthoritativeBudgetClickHouseRbac(process.env)
    .then(() => {
      process.stdout.write('Authoritative budget ClickHouse RBAC provisioned and validated.\n');
    })
    .catch(() => {
      // Never print driver errors here: they may contain credential-bearing URLs.
      process.stderr.write('Authoritative budget ClickHouse RBAC provisioning failed.\n');
      process.exitCode = 1;
    });
}
