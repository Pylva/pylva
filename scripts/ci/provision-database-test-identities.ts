import assert from 'node:assert/strict';
import postgres from 'postgres';

const CI_ADMIN_ROLE = 'pylva';
const CI_DATABASE = 'pylva_test';
const FIXTURE_ROLE = 'pylva_fixture_ci';
const RLS_TEST_ROLE = 'pylva_rls_test';
const GENERAL_APP_OWNER_ROLE = 'pylva_general_app_runtime';

interface TestLogin {
  username: string;
  password: string;
  bypassRls: boolean;
  target: URL;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} is required`);
  return value;
}

function parsePostgresUrl(raw: string, name: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL URL`);
  }
  assert.match(parsed.protocol, /^postgres(?:ql)?:$/u, `${name} must be PostgreSQL`);
  assert.ok(parsed.username && parsed.password && parsed.hostname, `${name} is incomplete`);
  return parsed;
}

function decoded(value: string, name: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`${name} contains invalid percent encoding`);
  }
}

function quoteIdentifier(value: string): string {
  assert.ok(value.length > 0 && !/[\u0000-\u001f\u007f]/u.test(value), 'unsafe identifier');
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  assert.ok(!value.includes('\u0000'), 'unsafe literal');
  return `'${value.replaceAll("'", "''")}'`;
}

function loginFromEnvironment(
  environmentName: string,
  expectedUsername: string,
  bypassRls: boolean,
): TestLogin {
  const target = parsePostgresUrl(required(environmentName), environmentName);
  const username = decoded(target.username, environmentName);
  const password = decoded(target.password, environmentName);
  assert.equal(username, expectedUsername, `${environmentName} is not the fixed test identity`);
  return { username, password, bypassRls, target };
}

function assertSameTarget(admin: URL, login: TestLogin, name: string): void {
  assert.equal(login.target.pathname, admin.pathname, `${name} database differs from admin`);
  assert.equal(login.target.hostname, admin.hostname, `${name} host differs from admin`);
  assert.equal(
    login.target.port || '5432',
    admin.port || '5432',
    `${name} port differs from admin`,
  );
}

function provisionLoginSql(login: TestLogin, database: string): string {
  const role = quoteIdentifier(login.username);
  const roleLiteral = quoteLiteral(login.username);
  const password = quoteLiteral(login.password);
  const rlsAttribute = login.bypassRls ? 'BYPASSRLS' : 'NOBYPASSRLS';

  return `
    DO $create_test_login$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ${roleLiteral}
      ) THEN
        CREATE ROLE ${role} LOGIN;
      END IF;
    END;
    $create_test_login$;

    ALTER ROLE ${role}
      LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION ${rlsAttribute} CONNECTION LIMIT -1
      PASSWORD ${password} VALID UNTIL 'infinity';
    ALTER ROLE ${role} RESET ALL;

    DO $reset_test_login_memberships$
    DECLARE
      edge RECORD;
    BEGIN
      FOR edge IN
        SELECT granted.rolname AS granted_role
        FROM pg_catalog.pg_auth_members AS membership
        JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
        JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
        WHERE member.rolname = ${roleLiteral}
      LOOP
        EXECUTE pg_catalog.format('REVOKE %I FROM %I', edge.granted_role, ${roleLiteral});
      END LOOP;

      FOR edge IN
        SELECT member.rolname AS member_role
        FROM pg_catalog.pg_auth_members AS membership
        JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
        JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
        WHERE granted.rolname = ${roleLiteral}
      LOOP
        EXECUTE pg_catalog.format('REVOKE %I FROM %I', ${roleLiteral}, edge.member_role);
      END LOOP;
    END;
    $reset_test_login_memberships$;

    REVOKE ALL PRIVILEGES ON DATABASE ${quoteIdentifier(database)} FROM ${role};
    REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${role};
    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${role};
    REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${role};

    GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO ${role};
    GRANT USAGE ON SCHEMA public TO ${role};

    DO $grant_test_login_relations$
    DECLARE
      relation RECORD;
    BEGIN
      FOR relation IN
        SELECT namespace.nspname AS schema_name,
               class.relname AS relation_name,
               class.relkind AS relation_kind
        FROM pg_catalog.pg_class AS class
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = class.relnamespace
        JOIN pg_catalog.pg_roles AS owner ON owner.oid = class.relowner
        WHERE namespace.nspname = 'public'
          AND owner.rolname = ${quoteLiteral(GENERAL_APP_OWNER_ROLE)}
          AND class.relkind IN ('r', 'p', 'v', 'm')
        ORDER BY class.relkind, class.relname
      LOOP
        IF relation.relation_kind IN ('v', 'm') THEN
          EXECUTE pg_catalog.format(
            'GRANT SELECT ON TABLE %I.%I TO %I',
            relation.schema_name,
            relation.relation_name,
            ${roleLiteral}
          );
        ELSE
          EXECUTE pg_catalog.format(
            'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO %I',
            relation.schema_name,
            relation.relation_name,
            ${roleLiteral}
          );
        END IF;
      END LOOP;

      FOR relation IN
        SELECT namespace.nspname AS schema_name, class.relname AS relation_name
        FROM pg_catalog.pg_class AS class
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = class.relnamespace
        JOIN pg_catalog.pg_roles AS owner ON owner.oid = class.relowner
        WHERE namespace.nspname = 'public'
          AND owner.rolname = ${quoteLiteral(GENERAL_APP_OWNER_ROLE)}
          AND class.relkind = 'S'
        ORDER BY class.relname
      LOOP
        EXECUTE pg_catalog.format(
          'GRANT USAGE, SELECT, UPDATE ON SEQUENCE %I.%I TO %I',
          relation.schema_name,
          relation.relation_name,
          ${roleLiteral}
        );
      END LOOP;
    END;
    $grant_test_login_relations$;
  `;
}

const adminUrl = required('CI_POSTGRES_ADMIN_URL');
const adminTarget = parsePostgresUrl(adminUrl, 'CI_POSTGRES_ADMIN_URL');
const adminUsername = decoded(adminTarget.username, 'CI_POSTGRES_ADMIN_URL');
const database = decoded(adminTarget.pathname.replace(/^\//u, ''), 'CI_POSTGRES_ADMIN_URL');
const fixture = loginFromEnvironment('PYLVA_TEST_DATABASE_URL', FIXTURE_ROLE, true);
const rlsTest = loginFromEnvironment('PYLVA_RLS_TEST_DATABASE_URL', RLS_TEST_ROLE, false);

assert.equal(adminUsername, CI_ADMIN_ROLE, 'CI admin role is not the fixed bootstrap identity');
assert.equal(database, CI_DATABASE, 'test identity provisioning must target pylva_test');
assertSameTarget(adminTarget, fixture, 'fixture login');
assertSameTarget(adminTarget, rlsTest, 'RLS test login');

const sql = postgres(adminUrl, { max: 1, onnotice: () => undefined });

async function assertLoginPosture(login: TestLogin): Promise<void> {
  const [posture] = await sql<
    Array<{
      authorityDenied: boolean;
      membershipsSafe: boolean;
      ordinaryAccessReady: boolean;
      roleSafe: boolean;
      schemaSafe: boolean;
    }>
  >`
    SELECT
      COALESCE((
        SELECT role.rolcanlogin
          AND role.rolinherit
          AND NOT role.rolsuper
          AND NOT role.rolcreatedb
          AND NOT role.rolcreaterole
          AND NOT role.rolreplication
          AND role.rolbypassrls = ${login.bypassRls}
        FROM pg_catalog.pg_roles AS role
        WHERE role.rolname = ${login.username}
      ), FALSE) AS "roleSafe",
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_auth_members AS edge
        JOIN pg_catalog.pg_roles AS member ON member.oid = edge.member
        JOIN pg_catalog.pg_roles AS granted ON granted.oid = edge.roleid
        WHERE member.rolname = ${login.username} OR granted.rolname = ${login.username}
      ) AS "membershipsSafe",
      pg_catalog.has_schema_privilege(${login.username}, 'public', 'USAGE')
        AND NOT pg_catalog.has_schema_privilege(${login.username}, 'public', 'CREATE')
        AS "schemaSafe",
      pg_catalog.has_table_privilege(
        ${login.username}, 'public.builders', 'SELECT,INSERT,UPDATE,DELETE'
      )
        AND pg_catalog.has_table_privilege(
          ${login.username}, 'public.llm_pricing', 'SELECT,INSERT,UPDATE,DELETE'
        )
        AND pg_catalog.has_table_privilege(
          ${login.username}, 'public.cost_sources', 'SELECT,INSERT,UPDATE,DELETE'
        ) AS "ordinaryAccessReady",
      NOT pg_catalog.has_table_privilege(
        ${login.username}, 'public.budget_control_cutovers', 'SELECT'
      )
        AND NOT pg_catalog.has_table_privilege(
          ${login.username}, 'public.budget_rule_revisions', 'SELECT'
        ) AS "authorityDenied"
  `;
  assert.deepEqual(posture, {
    authorityDenied: true,
    membershipsSafe: true,
    ordinaryAccessReady: true,
    roleSafe: true,
    schemaSafe: true,
  });
}

try {
  const [identity] = await sql<
    Array<{ database: string; sessionUser: string; superuser: boolean }>
  >`
    SELECT current_database() AS database,
           SESSION_USER AS "sessionUser",
           role.rolsuper AS superuser
    FROM pg_catalog.pg_roles AS role
    WHERE role.rolname = SESSION_USER
  `;
  assert.deepEqual(identity, {
    database: CI_DATABASE,
    sessionUser: CI_ADMIN_ROLE,
    superuser: true,
  });

  const [ownership] = await sql<Array<{ safe: boolean }>>`
    SELECT NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_roles AS role
      WHERE role.rolname IN (${fixture.username}, ${rlsTest.username})
        AND (
          EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datdba = role.oid)
          OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner = role.oid)
          OR EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relowner = role.oid)
          OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE proowner = role.oid)
          OR EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl WHERE defaclrole = role.oid)
        )
    ) AS safe
  `;
  assert.equal(ownership?.safe, true, 'test login owns persistent database objects');

  await sql.begin(async (transaction) => {
    await transaction.unsafe(provisionLoginSql(fixture, database));
    await transaction.unsafe(provisionLoginSql(rlsTest, database));
  });

  await assertLoginPosture(fixture);
  await assertLoginPosture(rlsTest);
  console.log('CI fixture and RLS test identities provisioned with ordinary-table access only');
} finally {
  await sql.end({ timeout: 5 });
}
