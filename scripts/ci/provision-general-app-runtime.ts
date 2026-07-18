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
const generalAppUrl = required('GENERAL_APP_DATABASE_URL');
const migrationTarget = new URL(migrationUrl);
const generalAppTarget = new URL(generalAppUrl);
const migrationUsername = decodeUrlPart(migrationTarget.username, 'MIGRATION_DATABASE_URL');
const generalAppUsername = decodeUrlPart(generalAppTarget.username, 'GENERAL_APP_DATABASE_URL');
const generalAppPassword = decodeUrlPart(generalAppTarget.password, 'GENERAL_APP_DATABASE_URL');

assert.match(migrationTarget.protocol, /^postgres(?:ql)?:$/u);
assert.match(generalAppTarget.protocol, /^postgres(?:ql)?:$/u);
assert.ok(migrationUsername, 'MIGRATION_DATABASE_URL must include a migration username');
assert.ok(generalAppUsername, 'GENERAL_APP_DATABASE_URL must include a general-app username');
assert.ok(generalAppPassword, 'GENERAL_APP_DATABASE_URL must include a general-app password');
assert.notEqual(
  generalAppUsername,
  migrationUsername,
  'general-app and migration roles must be distinct',
);
assert.notEqual(
  generalAppUsername,
  GENERAL_APP_OWNER_ROLE,
  'general-app login and owner group must be distinct',
);
assert.equal(
  generalAppTarget.hostname,
  migrationTarget.hostname,
  'general-app and migration hosts differ',
);
assert.equal(
  generalAppTarget.port || '5432',
  migrationTarget.port || '5432',
  'general-app and migration ports differ',
);
assert.equal(
  generalAppTarget.pathname,
  migrationTarget.pathname,
  'general-app and migration databases differ',
);

const role = quoteIdentifier(generalAppUsername);
const password = quoteLiteral(generalAppPassword);
const sql = postgres(migrationUrl, { max: 1, onnotice: () => undefined });

try {
  // Protected attributes cannot be safely repaired by an ordinary CREATEROLE
  // migration principal. Reject them before changing a password, ACL, or role
  // membership. Authority ownership/ACL and unexpected membership drift also
  // fail closed rather than being hidden by a provisioning rerun.
  const [preflight] = await sql<
    Array<{
      authorityAclSafe: boolean;
      directAclSafe: boolean;
      fixedOwnerRoleSafe: boolean;
      groupMembershipsSafe: boolean;
      loginIdentitySafe: boolean;
      loginDefaultAclSafe: boolean;
      loginHasNoMembers: boolean;
      loginMembershipsSafe: boolean;
      loginOwnershipSafe: boolean;
      migrationRoleSafe: boolean;
      protectedAttributesSafe: boolean;
      routineAclSafe: boolean;
    }>
  >`
    WITH
    migration_role AS (
      SELECT role.oid, role.rolcanlogin, role.rolinherit, role.rolsuper,
             role.rolcreatedb, role.rolcreaterole, role.rolreplication,
             role.rolbypassrls
      FROM pg_catalog.pg_roles AS role
      WHERE role.rolname = CURRENT_USER
    ),
    owner_role AS (
      SELECT role.oid, role.rolcanlogin, role.rolinherit, role.rolsuper,
             role.rolcreatedb, role.rolcreaterole, role.rolreplication,
             role.rolbypassrls
      FROM pg_catalog.pg_roles AS role
      WHERE role.rolname = ${GENERAL_APP_OWNER_ROLE}
    ),
    login_role AS (
      SELECT role.oid, role.rolcanlogin, role.rolinherit, role.rolsuper,
             role.rolcreatedb, role.rolcreaterole, role.rolreplication,
             role.rolbypassrls
      FROM pg_catalog.pg_roles AS role
      WHERE role.rolname = ${generalAppUsername}
    ),
    authority_relations AS (
      SELECT relation.oid, relation.relkind, relation.relowner, relation.relacl
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = ANY (ARRAY[
          'budget_account_opening_evidence',
          'budget_accounts',
          'budget_control_cutovers',
          'budget_cost_event_outbox',
          'budget_reservation_allocations',
          'budget_reservation_transitions',
          'budget_reservations',
          'budget_rule_revisions',
          'budget_usage_ledger',
          'pylva_budget_authority_order_seq',
          'schema_migrations',
          '_048_api_keys_scope_backup'
        ]::pg_catalog.text[])
    )
    SELECT
      COALESCE((
        SELECT migration.rolcanlogin
           AND migration.rolinherit
           AND NOT migration.rolsuper
           AND migration.rolcreaterole
           AND NOT migration.rolreplication
           AND NOT migration.rolbypassrls
        FROM migration_role AS migration
      ), FALSE) AS "migrationRoleSafe",
      COALESCE((
        SELECT NOT owner.rolcanlogin
           AND NOT owner.rolinherit
           AND NOT owner.rolsuper
           AND NOT owner.rolcreatedb
           AND NOT owner.rolcreaterole
           AND NOT owner.rolreplication
           AND NOT owner.rolbypassrls
           AND NOT EXISTS (
             SELECT 1
             FROM pg_catalog.pg_database AS database
             WHERE database.datdba = owner.oid
           )
           AND NOT EXISTS (
             SELECT 1
             FROM pg_catalog.pg_namespace AS namespace
             WHERE namespace.nspowner = owner.oid
           )
           AND NOT EXISTS (
             SELECT 1
             FROM pg_catalog.pg_default_acl AS default_acl
             WHERE default_acl.defaclrole = owner.oid
           )
           AND NOT EXISTS (
             SELECT 1
             FROM pg_catalog.pg_default_acl AS default_acl
             CROSS JOIN LATERAL pg_catalog.aclexplode(default_acl.defaclacl)
               AS privilege
             WHERE privilege.grantee = owner.oid
           )
        FROM owner_role AS owner
      ), FALSE) AS "fixedOwnerRoleSafe",
      NOT EXISTS (
        SELECT 1
        FROM login_role AS login
        WHERE login.rolsuper OR login.rolreplication OR login.rolbypassrls
      ) AS "protectedAttributesSafe",
      NOT EXISTS (
        SELECT 1
        FROM login_role AS login
        WHERE NOT login.rolcanlogin
      ) AS "loginIdentitySafe",
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_auth_members AS edge
        JOIN login_role AS login ON login.oid = edge.member
        LEFT JOIN owner_role AS owner ON owner.oid = edge.roleid
        WHERE owner.oid IS NULL
           OR edge.admin_option
           OR NOT edge.inherit_option
           OR edge.set_option
      ) AS "loginMembershipsSafe",
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_auth_members AS edge
        JOIN login_role AS login ON login.oid = edge.roleid
        JOIN pg_catalog.pg_roles AS member ON member.oid = edge.member
        WHERE NOT (
          member.rolname = CURRENT_USER
          AND member.rolcreaterole
          AND NOT member.rolsuper
          AND NOT member.rolbypassrls
          AND edge.admin_option
          AND NOT edge.inherit_option
          AND NOT edge.set_option
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM login_role AS login
        WHERE (
          SELECT pg_catalog.count(*) > 1
          FROM pg_catalog.pg_auth_members AS edge
          WHERE edge.roleid = login.oid
        )
      ) AS "loginHasNoMembers",
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_auth_members AS edge
        JOIN owner_role AS owner ON owner.oid = edge.roleid
        JOIN pg_catalog.pg_roles AS member ON member.oid = edge.member
        WHERE NOT (
          member.rolname = CURRENT_USER
          AND member.rolcreaterole
          AND NOT member.rolsuper
          AND NOT member.rolbypassrls
          AND NOT edge.inherit_option
          AND (
            (edge.admin_option AND NOT edge.set_option)
            OR (NOT edge.admin_option AND edge.set_option)
          )
        )
        AND NOT (
          member.rolname = ${generalAppUsername}
          AND member.rolcanlogin
          AND member.rolinherit
          AND NOT member.rolsuper
          AND NOT member.rolcreatedb
          AND NOT member.rolcreaterole
          AND NOT member.rolreplication
          AND NOT member.rolbypassrls
          AND NOT edge.admin_option
          AND edge.inherit_option
          AND NOT edge.set_option
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_auth_members AS edge
        JOIN owner_role AS owner ON owner.oid = edge.member
      ) AS "groupMembershipsSafe",
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_database AS database
        JOIN login_role AS login ON login.oid = database.datdba
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_namespace AS namespace
        JOIN login_role AS login ON login.oid = namespace.nspowner
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class AS relation
        JOIN login_role AS login ON login.oid = relation.relowner
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc AS procedure
        JOIN login_role AS login ON login.oid = procedure.proowner
      ) AS "loginOwnershipSafe",
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_default_acl AS default_acl
        JOIN login_role AS login ON login.oid = default_acl.defaclrole
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_default_acl AS default_acl
        CROSS JOIN LATERAL pg_catalog.aclexplode(default_acl.defaclacl) AS privilege
        JOIN login_role AS login ON login.oid = privilege.grantee
      ) AS "loginDefaultAclSafe",
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class AS relation
        JOIN login_role AS login ON TRUE
        CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS privilege
        WHERE privilege.grantee = login.oid
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_attribute AS attribute
        JOIN login_role AS login ON TRUE
        CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
        WHERE privilege.grantee = login.oid
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_namespace AS namespace
        JOIN login_role AS login ON TRUE
        CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
        WHERE privilege.grantee = login.oid
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_database AS database
        JOIN login_role AS login ON TRUE
        CROSS JOIN LATERAL pg_catalog.aclexplode(database.datacl) AS privilege
        WHERE privilege.grantee = login.oid
      ) AS "directAclSafe",
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc AS procedure
        JOIN login_role AS login ON TRUE
        CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS privilege
        WHERE privilege.grantee = login.oid
      ) AS "routineAclSafe",
      NOT EXISTS (
        SELECT 1
        FROM authority_relations AS relation
        JOIN login_role AS login ON TRUE
        WHERE relation.relowner = login.oid
           OR EXISTS (
             SELECT 1
             FROM pg_catalog.aclexplode(relation.relacl) AS privilege
             WHERE privilege.grantee = login.oid
           )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM authority_relations AS relation
        JOIN owner_role AS owner ON TRUE
        CROSS JOIN LATERAL (VALUES
          ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
          ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
        ) AS candidate(privilege_type)
        WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND relation.oid <> 'public.schema_migrations'::pg_catalog.regclass
          AND pg_catalog.has_table_privilege(
            owner.oid,
            relation.oid,
            candidate.privilege_type
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM authority_relations AS relation
        JOIN owner_role AS owner ON TRUE
        CROSS JOIN LATERAL (VALUES ('USAGE'), ('SELECT'), ('UPDATE'))
          AS candidate(privilege_type)
        WHERE relation.relkind = 'S'
          AND pg_catalog.has_sequence_privilege(
            owner.oid,
            relation.oid,
            candidate.privilege_type
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM authority_relations AS relation
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = relation.oid
        JOIN owner_role AS owner ON TRUE
        CROSS JOIN LATERAL (VALUES
          ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')
        ) AS candidate(privilege_type)
        WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND relation.oid <> 'public.schema_migrations'::pg_catalog.regclass
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND pg_catalog.has_column_privilege(
            owner.oid,
            relation.oid,
            attribute.attnum,
            candidate.privilege_type
          )
      ) AS "authorityAclSafe"
  `;

  assert.equal(preflight?.migrationRoleSafe, true, 'migration role posture is unsafe');
  assert.equal(preflight?.fixedOwnerRoleSafe, true, 'general-app owner group is missing or unsafe');
  assert.equal(
    preflight?.protectedAttributesSafe,
    true,
    'general-app login has protected role-attribute drift; SUPERUSER, REPLICATION, and BYPASSRLS must be remediated by a superuser',
  );
  assert.equal(
    preflight?.loginIdentitySafe,
    true,
    'general-app username already names a NOLOGIN role; refusing to repurpose a group identity',
  );
  assert.equal(
    preflight?.loginMembershipsSafe,
    true,
    'general-app login has unexpected role-membership drift',
  );
  assert.equal(
    preflight?.loginHasNoMembers,
    true,
    'general-app login has member roles that could inherit owner authority transitively',
  );
  assert.equal(
    preflight?.loginOwnershipSafe,
    true,
    'general-app login owns a database, schema, relation, sequence, or routine',
  );
  assert.equal(preflight?.loginDefaultAclSafe, true, 'general-app login has default-ACL drift');
  assert.equal(
    preflight?.directAclSafe,
    true,
    'general-app login has direct database, schema, relation, or column ACL drift',
  );
  assert.equal(
    preflight?.groupMembershipsSafe,
    true,
    'general-app owner group has unexpected membership drift',
  );
  assert.equal(
    preflight?.routineAclSafe,
    true,
    'general-app login has direct routine ACL drift; an object owner must remediate it',
  );
  assert.equal(
    preflight?.authorityAclSafe,
    true,
    'general-app login has direct authority ownership or ACL drift',
  );

  await sql.begin(async (transaction) => {
    await transaction.unsafe(`
    DO $create_general_app_login$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_roles
        WHERE rolname = ${quoteLiteral(generalAppUsername)}
      ) THEN
        CREATE ROLE ${role} LOGIN;
      END IF;
    END;
    $create_general_app_login$;

    ALTER ROLE ${role}
      LOGIN
      INHERIT
      NOCREATEDB
      NOCREATEROLE
      CONNECTION LIMIT -1
      PASSWORD ${password}
      VALID UNTIL 'infinity';
    ALTER ROLE ${role} RESET ALL;

    REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${role};

    SET ROLE pylva_general_app_runtime;

    DO $reset_general_app_relation_acl$
    DECLARE
      relation_row RECORD;
    BEGIN
      FOR relation_row IN
        SELECT namespace.nspname AS schema_name,
               relation.relname AS relation_name,
               relation.relkind AS relation_kind
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relowner = (SELECT role.oid FROM pg_catalog.pg_roles AS role WHERE role.rolname = CURRENT_USER)
          AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
        ORDER BY relation.relkind, relation.relname
      LOOP
        IF relation_row.relation_kind = 'S' THEN
          EXECUTE pg_catalog.format(
            'REVOKE ALL PRIVILEGES ON SEQUENCE %I.%I FROM %I',
            relation_row.schema_name,
            relation_row.relation_name,
            ${quoteLiteral(generalAppUsername)}
          );
        ELSE
          EXECUTE pg_catalog.format(
            'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM %I',
            relation_row.schema_name,
            relation_row.relation_name,
            ${quoteLiteral(generalAppUsername)}
          );
        END IF;
      END LOOP;
    END;
    $reset_general_app_relation_acl$;

    DO $reset_general_app_column_acl$
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
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND attribute.attacl IS NOT NULL
          AND grantee.rolname = ${quoteLiteral(generalAppUsername)}
          AND class.relowner = (
            SELECT role.oid
            FROM pg_catalog.pg_roles AS role
            WHERE role.rolname = CURRENT_USER
          )
        GROUP BY namespace.nspname, class.relname, privilege.privilege_type
      LOOP
        EXECUTE pg_catalog.format(
          'REVOKE %s (%s) ON TABLE %I.%I FROM %I',
          grant_row.privilege_type,
          grant_row.column_list,
          grant_row.schema_name,
          grant_row.relation_name,
          ${quoteLiteral(generalAppUsername)}
        );
      END LOOP;
    END;
    $reset_general_app_column_acl$;

    RESET ROLE;

    DO $general_app_database_acl$
    BEGIN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I',
        pg_catalog.current_database(),
        ${quoteLiteral(generalAppUsername)}
      );
    END;
    $general_app_database_acl$;

    GRANT pylva_general_app_runtime TO ${role}
      WITH ADMIN FALSE, INHERIT TRUE, SET FALSE
      GRANTED BY ${quoteIdentifier(migrationUsername)};
    `);

    const [posture] = await transaction<Array<{ safe: boolean }>>`
      WITH
      login_role AS (
        SELECT role.*
        FROM pg_catalog.pg_roles AS role
        WHERE role.rolname = ${generalAppUsername}
      ),
      owner_role AS (
        SELECT role.*
        FROM pg_catalog.pg_roles AS role
        WHERE role.rolname = ${GENERAL_APP_OWNER_ROLE}
      ),
      excluded_relations AS (
        SELECT relation.oid, relation.relkind
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname = ANY (ARRAY[
            'budget_account_opening_evidence',
            'budget_accounts',
            'budget_control_cutovers',
            'budget_cost_event_outbox',
            'budget_reservation_allocations',
            'budget_reservation_transitions',
            'budget_reservations',
            'budget_rule_revisions',
            'budget_usage_ledger',
            'pylva_budget_authority_order_seq',
            '_048_api_keys_scope_backup'
          ]::pg_catalog.text[])
      )
      SELECT
        login.rolcanlogin
        AND login.rolinherit
        AND NOT login.rolsuper
        AND NOT login.rolcreatedb
        AND NOT login.rolcreaterole
        AND NOT login.rolreplication
        AND NOT login.rolbypassrls
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_auth_members AS edge
          WHERE edge.member = login.oid
            AND (
              edge.roleid <> owner.oid
              OR edge.admin_option
              OR NOT edge.inherit_option
              OR edge.set_option
            )
        )
        AND (
          SELECT pg_catalog.count(*) = 1
          FROM pg_catalog.pg_auth_members AS edge
          WHERE edge.member = login.oid
        )
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_auth_members AS edge
          JOIN pg_catalog.pg_roles AS member ON member.oid = edge.member
          WHERE edge.roleid = login.oid
            AND NOT (
              member.rolname = CURRENT_USER
              AND member.rolcreaterole
              AND NOT member.rolsuper
              AND NOT member.rolbypassrls
              AND edge.admin_option
              AND NOT edge.inherit_option
              AND NOT edge.set_option
            )
        )
        AND (
          SELECT pg_catalog.count(*) <= 1
          FROM pg_catalog.pg_auth_members AS edge
          WHERE edge.roleid = login.oid
        )
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_database AS database
          WHERE database.datdba = login.oid
        )
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_namespace AS namespace
          WHERE namespace.nspowner = login.oid
        )
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_class AS relation
          WHERE relation.relowner = login.oid
        )
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_proc AS procedure
          WHERE procedure.proowner = login.oid
        )
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_default_acl AS default_acl
          WHERE default_acl.defaclrole = login.oid
        )
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_default_acl AS default_acl
          CROSS JOIN LATERAL pg_catalog.aclexplode(default_acl.defaclacl) AS privilege
          WHERE privilege.grantee = login.oid
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
          WHERE privilege.grantee = login.oid
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
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_database AS database
          CROSS JOIN LATERAL pg_catalog.aclexplode(database.datacl) AS privilege
          WHERE privilege.grantee = login.oid
        )
        AND NOT EXISTS (
          SELECT 1
          FROM excluded_relations AS relation
          CROSS JOIN LATERAL (VALUES
            ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
            ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
          ) AS candidate(privilege_type)
          WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND pg_catalog.has_table_privilege(
              login.oid,
              relation.oid,
              candidate.privilege_type
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM excluded_relations AS relation
          CROSS JOIN LATERAL (VALUES ('USAGE'), ('SELECT'), ('UPDATE'))
            AS candidate(privilege_type)
          WHERE relation.relkind = 'S'
            AND pg_catalog.has_sequence_privilege(
              login.oid,
              relation.oid,
              candidate.privilege_type
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM excluded_relations AS relation
          JOIN pg_catalog.pg_attribute AS attribute
            ON attribute.attrelid = relation.oid
          CROSS JOIN LATERAL (VALUES
            ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')
          ) AS candidate(privilege_type)
          WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
            AND pg_catalog.has_column_privilege(
              login.oid,
              relation.oid,
              attribute.attnum,
              candidate.privilege_type
            )
        )
        AND NOT pg_catalog.has_function_privilege(
          login.oid,
          'public.pylva_budget_projection_actionable_builders(uuid,integer)',
          'EXECUTE'
        )
        AND NOT pg_catalog.has_function_privilege(
          login.oid,
          'public.pylva_budget_expiry_actionable_builders(uuid,integer)',
          'EXECUTE'
        )
        AND pg_catalog.has_table_privilege(login.oid, 'public.builders', 'SELECT')
        AND pg_catalog.has_table_privilege(login.oid, 'public.builders', 'INSERT')
        AND pg_catalog.has_table_privilege(login.oid, 'public.builders', 'UPDATE')
        AND pg_catalog.has_table_privilege(login.oid, 'public.builders', 'DELETE')
        AND pg_catalog.has_table_privilege(
          login.oid,
          'public.user_builder_memberships',
          'SELECT'
        )
        AND pg_catalog.has_table_privilege(
          login.oid,
          'public.user_builder_memberships',
          'INSERT'
        )
        AND pg_catalog.has_table_privilege(
          login.oid,
          'public.user_builder_memberships',
          'UPDATE'
        )
        AND pg_catalog.has_table_privilege(
          login.oid,
          'public.user_builder_memberships',
          'DELETE'
        )
        AND pg_catalog.has_table_privilege(
          login.oid,
          'public.schema_migrations',
          'SELECT'
        )
        AND NOT pg_catalog.has_table_privilege(
          login.oid,
          'public.schema_migrations',
          'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
        )
        AND pg_catalog.has_schema_privilege(login.oid, 'public', 'USAGE')
        AND pg_catalog.has_schema_privilege(login.oid, 'public', 'CREATE')
        AND pg_catalog.has_database_privilege(
          login.oid,
          pg_catalog.current_database(),
          'CONNECT'
        ) AS safe
      FROM login_role AS login
      CROSS JOIN owner_role AS owner
    `;
    assert.equal(posture?.safe, true, 'general-app runtime login posture is unsafe');
  });
  process.stdout.write('GENERAL_APP_RUNTIME_PROVISIONED\n');
} finally {
  await sql.end({ timeout: 5 });
}
