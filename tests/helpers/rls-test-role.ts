import postgres from 'postgres';

export const RLS_TEST_USER = 'pylva_rls_test';
const DEFAULT_RLS_TEST_PASSWORD = 'pylva_rls_test';

export function rlsTestPassword(): string {
  return process.env['RLS_TEST_PASSWORD'] ?? DEFAULT_RLS_TEST_PASSWORD;
}

export async function ensureRlsTestRole(sql: ReturnType<typeof postgres>): Promise<void> {
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
    await sql.unsafe(
      `ALTER ROLE ${RLS_TEST_USER} LOGIN PASSWORD ${passwordLiteral} NOBYPASSRLS;`,
    );
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
  url.username = RLS_TEST_USER;
  url.password = rlsTestPassword();
  return url.toString();
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
