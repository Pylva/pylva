import postgres from 'postgres';

export const RLS_TEST_USER = 'pylva_rls_test';
const DEFAULT_RLS_TEST_PASSWORD = 'pylva_rls_test';
const CI_RLS_TEST_DATABASE_URL_ENV = 'PYLVA_RLS_TEST_DATABASE_URL';

function configuredCiRlsUrl(): URL | null {
  const raw = process.env[CI_RLS_TEST_DATABASE_URL_ENV]?.trim();
  if (!raw) return null;
  const url = new URL(raw);
  if (!/^postgres(?:ql)?:$/u.test(url.protocol)) {
    throw new Error(`${CI_RLS_TEST_DATABASE_URL_ENV} must be a PostgreSQL URL`);
  }
  if (decodeURIComponent(url.username) !== RLS_TEST_USER || !url.password || !url.hostname) {
    throw new Error(`${CI_RLS_TEST_DATABASE_URL_ENV} must identify the fixed RLS test login`);
  }
  return url;
}

export function rlsTestPassword(): string {
  const configured = configuredCiRlsUrl();
  return (
    process.env['RLS_TEST_PASSWORD'] ??
    (configured ? decodeURIComponent(configured.password) : DEFAULT_RLS_TEST_PASSWORD)
  );
}

export async function ensureRlsTestRole(sql: ReturnType<typeof postgres>): Promise<void> {
  const configured = configuredCiRlsUrl();
  if (configured) {
    const rows = await sql.unsafe(`
      SELECT current_database() AS database,
             COALESCE((
               SELECT role.rolcanlogin
                 AND role.rolinherit
                 AND NOT role.rolsuper
                 AND NOT role.rolcreatedb
                 AND NOT role.rolcreaterole
                 AND NOT role.rolreplication
                 AND NOT role.rolbypassrls
               FROM pg_catalog.pg_roles AS role
               WHERE role.rolname = '${RLS_TEST_USER}'
             ), FALSE) AS role_safe,
             NOT EXISTS (
               SELECT 1
               FROM pg_catalog.pg_auth_members AS edge
               JOIN pg_catalog.pg_roles AS member ON member.oid = edge.member
               JOIN pg_catalog.pg_roles AS granted ON granted.oid = edge.roleid
               WHERE member.rolname = '${RLS_TEST_USER}'
                  OR granted.rolname = '${RLS_TEST_USER}'
             ) AS memberships_safe,
             pg_catalog.has_table_privilege(
               '${RLS_TEST_USER}', 'public.cost_sources', 'SELECT,INSERT,UPDATE,DELETE'
             ) AS ordinary_access_ready,
             NOT pg_catalog.has_table_privilege(
               '${RLS_TEST_USER}', 'public.budget_control_cutovers', 'SELECT'
             )
               AND NOT pg_catalog.has_table_privilege(
                 '${RLS_TEST_USER}', 'public.budget_rule_revisions', 'SELECT'
               ) AS authority_denied
    `);
    const row = rows[0];
    const configuredDatabase = decodeURIComponent(configured.pathname.replace(/^\//u, ''));
    if (row?.['database'] === configuredDatabase) {
      if (
        row['role_safe'] !== true ||
        row['memberships_safe'] !== true ||
        row['ordinary_access_ready'] !== true ||
        row['authority_denied'] !== true
      ) {
        throw new Error('pre-provisioned CI RLS test role failed its credential boundary');
      }
      return;
    }
  }

  const passwordLiteral = sqlStringLiteral(rlsTestPassword());
  await sql.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RLS_TEST_USER}') THEN
        CREATE ROLE ${RLS_TEST_USER} LOGIN PASSWORD ${passwordLiteral};
      END IF;
    END
    $$;
  `);
  try {
    await sql.unsafe(`ALTER ROLE ${RLS_TEST_USER} LOGIN PASSWORD ${passwordLiteral} NOBYPASSRLS;`);
  } catch (err) {
    // PG16+: only superusers may (re)set BYPASSRLS. In CI/docker the app role
    // is superuser so this succeeds; on a native cluster it throws even when
    // the role is already correct. Tolerate iff the role verifiably has the
    // attributes we would have set; otherwise the environment is truly broken.
    const rows = await sql<{ rolcanlogin: boolean; rolbypassrls: boolean }[]>`
      SELECT rolcanlogin, rolbypassrls FROM pg_roles WHERE rolname = ${RLS_TEST_USER}
    `;
    const role = rows[0];
    if (!role || !role.rolcanlogin || role.rolbypassrls) throw err;
  }
  await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${RLS_TEST_USER};`);
  await sql.unsafe(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RLS_TEST_USER};`,
  );
  await sql.unsafe(
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${RLS_TEST_USER};`,
  );
}

export function rlsDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const configured = configuredCiRlsUrl();
  if (
    configured &&
    configured.hostname === url.hostname &&
    (configured.port || '5432') === (url.port || '5432') &&
    configured.pathname === url.pathname
  ) {
    return configured.toString();
  }
  url.username = RLS_TEST_USER;
  url.password = rlsTestPassword();
  return url.toString();
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
