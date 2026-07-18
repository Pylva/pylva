import assert from 'node:assert/strict';
import postgres from 'postgres';

const GENERAL_APP_OWNER_ROLE = 'pylva_general_app_runtime' as const;

function required(name: string): string {
  const value = process.env[name]?.trim();
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

function quoteIdentifier(value: string): string {
  assert.ok(value.length > 0 && !/[\u0000-\u001f\u007f]/u.test(value), 'unsafe role name');
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  assert.ok(!value.includes('\u0000'), 'unsafe password');
  return `'${value.replaceAll("'", "''")}'`;
}

const migrationUrl = required('MIGRATION_DATABASE_URL');
const runtimeUrl = required('BUDGET_CONTROL_DATABASE_URL');
const migrationTarget = new URL(migrationUrl);
const runtimeTarget = new URL(runtimeUrl);
const migrationUsername = decodeUrlPart(migrationTarget.username, 'MIGRATION_DATABASE_URL');
const runtimeUsername = decodeUrlPart(runtimeTarget.username, 'BUDGET_CONTROL_DATABASE_URL');
const runtimePassword = decodeUrlPart(runtimeTarget.password, 'BUDGET_CONTROL_DATABASE_URL');

assert.match(migrationTarget.protocol, /^postgres(?:ql)?:$/u);
assert.match(runtimeTarget.protocol, /^postgres(?:ql)?:$/u);
assert.ok(runtimeUsername, 'BUDGET_CONTROL_DATABASE_URL must include a runtime username');
assert.ok(runtimePassword, 'BUDGET_CONTROL_DATABASE_URL must include a runtime password');
assert.notEqual(runtimeUsername, migrationUsername, 'runtime and migration roles must be distinct');
assert.equal(
  runtimeTarget.hostname,
  migrationTarget.hostname,
  'runtime and migration hosts differ',
);
assert.equal(
  runtimeTarget.port || '5432',
  migrationTarget.port || '5432',
  'runtime and migration ports differ',
);
assert.equal(
  runtimeTarget.pathname,
  migrationTarget.pathname,
  'runtime and migration databases differ',
);

const role = quoteIdentifier(runtimeUsername);
const password = quoteLiteral(runtimePassword);
const sql = postgres(migrationUrl, { max: 1, onnotice: () => undefined });

// Migration 054 deliberately splits ownership: the migrator retains the
// authoritative budget relations while pylva_general_app_runtime owns the
// ordinary application catalog. PostgreSQL only lets an object owner revoke a
// direct ACL, so replay the same cleanup once as each owner instead of relying
// on an ON ALL TABLES wildcard issued by the migrator.
const resetRuntimeRelationAclForCurrentOwner = `
  DO $reset_runtime_relation_acl$
  DECLARE
    relation_row RECORD;
  BEGIN
    FOR relation_row IN
      SELECT namespace.nspname AS schema_name,
             relation.relname AS relation_name,
             relation.relkind AS relation_kind
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relowner = (
          SELECT owner.oid
          FROM pg_catalog.pg_roles AS owner
          WHERE owner.rolname = CURRENT_USER
        )
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      ORDER BY relation.relkind, relation.relname
    LOOP
      IF relation_row.relation_kind = 'S' THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON SEQUENCE %I.%I FROM %I',
          relation_row.schema_name,
          relation_row.relation_name,
          ${quoteLiteral(runtimeUsername)}
        );
      ELSE
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM %I',
          relation_row.schema_name,
          relation_row.relation_name,
          ${quoteLiteral(runtimeUsername)}
        );
      END IF;
    END LOOP;
  END;
  $reset_runtime_relation_acl$;

  -- Table-level REVOKE does not clear grants stored on individual columns.
  DO $reset_runtime_column_acl$
  DECLARE
    grant_row RECORD;
  BEGIN
    FOR grant_row IN
      SELECT namespace.nspname AS schema_name,
             class.relname AS relation_name,
             privilege.privilege_type,
             pg_catalog.string_agg(
               pg_catalog.format('%I', attribute.attname),
               ', ' ORDER BY attribute.attnum
             ) AS column_list
      FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_class AS class ON class.oid = attribute.attrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = class.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
      JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
      WHERE namespace.nspname = 'public'
        AND class.relowner = (
          SELECT owner.oid
          FROM pg_catalog.pg_roles AS owner
          WHERE owner.rolname = CURRENT_USER
        )
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND attribute.attacl IS NOT NULL
        AND grantee.rolname = ${quoteLiteral(runtimeUsername)}
      GROUP BY namespace.nspname, class.relname, privilege.privilege_type
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE %s (%s) ON TABLE %I.%I FROM %I',
        grant_row.privilege_type,
        grant_row.column_list,
        grant_row.schema_name,
        grant_row.relation_name,
        ${quoteLiteral(runtimeUsername)}
      );
    END LOOP;
  END;
  $reset_runtime_column_acl$;
`;

try {
  // SUPERUSER, REPLICATION, and BYPASSRLS are protected PostgreSQL role
  // attributes. An ordinary CREATEROLE migration principal cannot toggle
  // them, even to their safer values. Reject pre-existing drift before any
  // ACL, membership, password, or other mutable posture is changed.
  const [protectedPosture] = await sql<
    Array<{
      protectedAttributesSafe: boolean;
      routineAclSafe: boolean;
    }>
  >`
    SELECT
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_roles AS login
        WHERE login.rolname = ${runtimeUsername}
          AND (
            login.rolsuper
            OR login.rolreplication
            OR login.rolbypassrls
          )
      ) AS "protectedAttributesSafe",
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc AS procedure
        JOIN pg_catalog.pg_roles AS login
          ON login.rolname = ${runtimeUsername}
        CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS privilege
        WHERE privilege.grantee = login.oid
      ) AS "routineAclSafe"
  `;
  assert.equal(
    protectedPosture?.protectedAttributesSafe,
    true,
    'CI runtime login has protected role-attribute drift; SUPERUSER, REPLICATION, and BYPASSRLS must be remediated by a superuser',
  );
  assert.equal(
    protectedPosture?.routineAclSafe,
    true,
    'CI runtime login has direct routine ACL drift; a routine owner or superuser must remediate it',
  );

  // PostgreSQL role DDL and ACL changes are transactional. Keep creation,
  // password rotation, membership repair, owner-scoped ACL cleanup, and the
  // complete postcondition in one transaction so any failed SET ROLE, REVOKE,
  // GRANT, or assertion restores the prior login exactly.
  await sql.begin(async (transaction) => {
    await transaction.unsafe(`
      DO $create_runtime_login$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_roles
          WHERE rolname = ${quoteLiteral(runtimeUsername)}
        ) THEN
          CREATE ROLE ${role} LOGIN;
        END IF;
      END;
      $create_runtime_login$;

      ALTER ROLE ${role}
        LOGIN
        INHERIT
        NOCREATEDB
        NOCREATEROLE
        CONNECTION LIMIT -1
        PASSWORD ${password}
        VALID UNTIL 'infinity';
      ALTER ROLE ${role} RESET ALL;
    `);

    // A rerun must remove any historical membership drift before adding the
    // one allowed runtime-group edge.
    await transaction.unsafe(`
      DO $reset_runtime_memberships$
      DECLARE
        membership RECORD;
      BEGIN
        FOR membership IN
          SELECT granted.rolname AS granted_role
          FROM pg_catalog.pg_auth_members AS edge
          JOIN pg_catalog.pg_roles AS member ON member.oid = edge.member
          JOIN pg_catalog.pg_roles AS granted ON granted.oid = edge.roleid
          WHERE member.rolname = ${quoteLiteral(runtimeUsername)}
        LOOP
          EXECUTE pg_catalog.format(
            'REVOKE %I FROM %I',
            membership.granted_role,
            ${quoteLiteral(runtimeUsername)}
          );
        END LOOP;
      END;
      $reset_runtime_memberships$;
    `);

    // The login owns nothing and receives no direct object privileges. CONNECT
    // is its sole direct ACL; all application access is inherited from the
    // migration-sealed pylva_budget_control_runtime group. Direct routine ACLs
    // were rejected above because a normal CREATEROLE migrator cannot revoke
    // grants from the sealed SECURITY DEFINER owners.
    await transaction.unsafe(`
      REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${role};

      ${resetRuntimeRelationAclForCurrentOwner}

      SET ROLE ${GENERAL_APP_OWNER_ROLE};
      ${resetRuntimeRelationAclForCurrentOwner}
      RESET ROLE;

      DO $runtime_database_acl$
      BEGIN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I',
          pg_catalog.current_database(),
          ${quoteLiteral(runtimeUsername)}
        );
        EXECUTE pg_catalog.format(
          'GRANT CONNECT ON DATABASE %I TO %I',
          pg_catalog.current_database(),
          ${quoteLiteral(runtimeUsername)}
        );
      END;
      $runtime_database_acl$;

      GRANT pylva_budget_control_runtime TO ${role}
        WITH ADMIN FALSE, INHERIT TRUE, SET TRUE
        GRANTED BY ${quoteIdentifier(migrationUsername)};
    `);

    const [posture] = await transaction<Array<{ safe: boolean }>>`
      WITH RECURSIVE
      login_role AS (
        SELECT role.oid, role.rolcanlogin, role.rolinherit, role.rolsuper,
               role.rolcreatedb, role.rolcreaterole, role.rolreplication,
               role.rolbypassrls, role.rolconnlimit, role.rolvaliduntil,
               role.rolconfig
        FROM pg_catalog.pg_roles AS role
        WHERE role.rolname = ${runtimeUsername}
      ),
      runtime_role AS (
        SELECT role.oid, role.rolcanlogin, role.rolinherit, role.rolsuper,
               role.rolcreatedb, role.rolcreaterole, role.rolreplication,
               role.rolbypassrls
        FROM pg_catalog.pg_roles AS role
        WHERE role.rolname = 'pylva_budget_control_runtime'
      ),
      reachable_roles(role_oid) AS (
        SELECT login.oid
        FROM login_role AS login
        UNION
        SELECT edge.roleid
        FROM pg_catalog.pg_auth_members AS edge
        JOIN reachable_roles AS reachable ON reachable.role_oid = edge.member
      ),
      direct_database_acl AS (
        SELECT database.oid AS database_oid,
               database.datname AS database_name,
               privilege.privilege_type,
               privilege.is_grantable
        FROM pg_catalog.pg_database AS database
        CROSS JOIN login_role AS login
        CROSS JOIN LATERAL pg_catalog.aclexplode(database.datacl) AS privilege
        WHERE privilege.grantee = login.oid
      )
      SELECT COALESCE((
        SELECT login.rolcanlogin
           AND login.rolinherit
           AND NOT login.rolsuper
           AND NOT login.rolcreatedb
           AND NOT login.rolcreaterole
           AND NOT login.rolreplication
           AND NOT login.rolbypassrls
           AND login.rolconnlimit = -1
           AND login.rolvaliduntil = 'infinity'::pg_catalog.timestamptz
           AND COALESCE(pg_catalog.cardinality(login.rolconfig), 0) = 0
           AND NOT runtime.rolcanlogin
           AND NOT runtime.rolinherit
           AND NOT runtime.rolsuper
           AND NOT runtime.rolcreatedb
           AND NOT runtime.rolcreaterole
           AND NOT runtime.rolreplication
           AND NOT runtime.rolbypassrls
           -- Exactly one inherited/settable edge leaves the login.
           AND 1 = (
             SELECT pg_catalog.count(*)
             FROM pg_catalog.pg_auth_members AS edge
             WHERE edge.member = login.oid
           )
           AND EXISTS (
             SELECT 1
             FROM pg_catalog.pg_auth_members AS edge
             WHERE edge.member = login.oid
               AND edge.roleid = runtime.oid
               AND NOT edge.admin_option
               AND edge.inherit_option
               AND edge.set_option
           )
           -- The migration principal is the login's sole, non-inheriting,
           -- non-settable administrator; no other role can inherit through it.
           AND 1 = (
             SELECT pg_catalog.count(*)
             FROM pg_catalog.pg_auth_members AS edge
             WHERE edge.roleid = login.oid
           )
           AND EXISTS (
             SELECT 1
             FROM pg_catalog.pg_auth_members AS edge
             JOIN pg_catalog.pg_roles AS member ON member.oid = edge.member
             WHERE edge.roleid = login.oid
               AND member.rolname = CURRENT_USER
               AND edge.admin_option
               AND NOT edge.inherit_option
               AND NOT edge.set_option
           )
           AND 2 = (SELECT pg_catalog.count(*) FROM reachable_roles)
           AND NOT EXISTS (
             SELECT 1
             FROM reachable_roles AS reachable
             WHERE reachable.role_oid NOT IN (login.oid, runtime.oid)
           )
           -- pg_shdepend closes ownership across every catalog and database,
           -- including object kinds that are not currently used by Pylva.
           AND NOT EXISTS (
             SELECT 1
             FROM pg_catalog.pg_shdepend AS dependency
             WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
               AND dependency.refobjid = login.oid
               AND dependency.deptype = 'o'
           )
           AND NOT EXISTS (
             SELECT 1
             FROM pg_catalog.pg_default_acl AS default_acl
             WHERE default_acl.defaclrole = login.oid
                OR EXISTS (
                  SELECT 1
                  FROM pg_catalog.aclexplode(default_acl.defaclacl) AS privilege
                  WHERE privilege.grantee = login.oid
                )
           )
           AND NOT EXISTS (
             SELECT 1
             FROM pg_catalog.pg_class AS relation
             CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS privilege
             WHERE privilege.grantee = login.oid
           )
           AND NOT EXISTS (
             SELECT 1
             FROM pg_catalog.pg_attribute AS attribute
             CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
             WHERE attribute.attnum > 0
               AND NOT attribute.attisdropped
               AND privilege.grantee = login.oid
           )
           AND NOT EXISTS (
             SELECT 1
             FROM pg_catalog.pg_proc AS procedure
             CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS privilege
             WHERE privilege.grantee = login.oid
           )
           AND NOT EXISTS (
             SELECT 1
             FROM pg_catalog.pg_namespace AS namespace
             CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
             WHERE privilege.grantee = login.oid
           )
           -- CONNECT on this database is the one intentional direct ACL.
           AND 1 = (SELECT pg_catalog.count(*) FROM direct_database_acl)
           AND EXISTS (
             SELECT 1
             FROM direct_database_acl AS privilege
             WHERE privilege.database_name = pg_catalog.current_database()
               AND privilege.privilege_type = 'CONNECT'
               AND NOT privilege.is_grantable
           )
        FROM login_role AS login
        CROSS JOIN runtime_role AS runtime
      ), FALSE) AS safe
    `;
    assert.equal(
      posture?.safe,
      true,
      'CI runtime login posture is unsafe; provisioning transaction rolled back',
    );
  });
  process.stdout.write('AUTHORITATIVE_BUDGET_RUNTIME_PROVISIONED\n');
} finally {
  await sql.end({ timeout: 5 });
}
