import crypto from 'node:crypto';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

import postgres, { type Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const OWNER_ROLE = 'pylva_general_app_runtime' as const;
const migrationUrl = process.env['MIGRATION_DATABASE_URL'];
const generalAppUrl = process.env['GENERAL_APP_DATABASE_URL'];
const adminUrl = process.env['CI_POSTGRES_ADMIN_URL'];
const shouldRun = Boolean(migrationUrl && generalAppUrl && adminUrl);
const suite = shouldRun ? describe.sequential : describe.skip;

interface FixtureNames {
  decoy: string;
  nested: string;
  routine: string;
  table: string;
  target: string;
}

interface MembershipEdge {
  adminOption: boolean;
  grantedRole: string;
  grantor: string;
  inheritOption: boolean;
  member: string;
  setOption: boolean;
}

interface RoleSnapshot {
  canLogin: boolean;
  connectionLimit: number;
  createDatabase: boolean;
  createRole: boolean;
  inherit: boolean;
  memberships: MembershipEdge[];
  passwordVerifier: string | null;
  replication: boolean;
  settings: string[];
  superuser: boolean;
  bypassRls: boolean;
  validUntil: string | null;
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value)) throw new Error(`unsafe test identifier: ${value}`);
  return `"${value}"`;
}

function quoteLiteral(value: string): string {
  if (value.includes('\u0000')) throw new Error('unsafe test literal');
  return `'${value.replaceAll("'", "''")}'`;
}

function fixtureNames(label: string): FixtureNames {
  const suffix = crypto.randomBytes(4).toString('hex');
  return {
    decoy: `pylva_gprov_decoy_${label}_${suffix}`,
    nested: `pylva_gprov_nested_${label}_${suffix}`,
    routine: `gprov_routine_${label}_${suffix}`,
    table: `gprov_table_${label}_${suffix}`,
    target: `pylva_gprov_target_${label}_${suffix}`,
  };
}

function password(label: string): string {
  return `${label}-${crypto.randomBytes(18).toString('hex')}`;
}

function loginUrl(username: string, rolePassword: string): string {
  const target = new URL(migrationUrl!);
  target.username = username;
  target.password = rolePassword;
  return target.toString();
}

function runProvisioner(username: string, rolePassword: string): SpawnSyncReturns<string> {
  const childEnvironment = { ...process.env };
  delete childEnvironment['CI_POSTGRES_ADMIN_URL'];
  delete childEnvironment['PYLVA_TEST_DATABASE_ADMIN_URL'];
  return spawnSync('pnpm', ['exec', 'tsx', 'scripts/ci/provision-general-app-runtime.ts'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...childEnvironment,
      GENERAL_APP_DATABASE_URL: loginUrl(username, rolePassword),
      MIGRATION_DATABASE_URL: migrationUrl!,
    },
    timeout: 30_000,
  });
}

function target(value: string): {
  database: string;
  host: string;
  port: string;
  username: string;
} {
  const url = new URL(value);
  return {
    database: decodeURIComponent(url.pathname.slice(1)),
    host: url.hostname,
    port: url.port || '5432',
    username: decodeURIComponent(url.username),
  };
}

suite('general-app runtime provisioner fail-closed PostgreSQL boundary', () => {
  let admin: Sql;
  let adminUsername: string;
  let baselineRuntimeMembers: MembershipEdge[] = [];
  let migration: Sql;
  let migrationUsername: string;
  let trackedRoles: string[] = [];
  let cleanupTasks: Array<() => Promise<void>> = [];

  async function roleExists(roleName: string): Promise<boolean> {
    const [row] = await admin<Array<{ present: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_roles AS role
        WHERE role.rolname = ${roleName}
      ) AS present
    `;
    return row?.present === true;
  }

  async function cleanupRole(roleName: string): Promise<void> {
    if (!(await roleExists(roleName))) return;
    const role = quoteIdentifier(roleName);
    await admin.unsafe(`
      ALTER ROLE ${role}
        NOSUPERUSER
        NOREPLICATION
        NOBYPASSRLS;
      DROP OWNED BY ${role};
      DROP ROLE ${role};
    `);
  }

  async function trackRole(roleName: string, definition: string): Promise<void> {
    await migration.unsafe(`CREATE ROLE ${quoteIdentifier(roleName)} ${definition}`);
    trackedRoles.push(roleName);
  }

  async function ownerMemberships(includeMigrator = true): Promise<MembershipEdge[]> {
    const rows = await admin<
      Array<{
        admin_option: boolean;
        granted_role: string;
        grantor: string;
        inherit_option: boolean;
        member: string;
        set_option: boolean;
      }>
    >`
      SELECT edge.admin_option,
             granted.rolname AS granted_role,
             grantor.rolname AS grantor,
             edge.inherit_option,
             member.rolname AS member,
             edge.set_option
      FROM pg_catalog.pg_auth_members AS edge
      JOIN pg_catalog.pg_roles AS granted ON granted.oid = edge.roleid
      JOIN pg_catalog.pg_roles AS member ON member.oid = edge.member
      JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = edge.grantor
      WHERE granted.rolname = ${OWNER_ROLE}
        AND (${includeMigrator} OR member.rolname <> ${migrationUsername})
      ORDER BY member.rolname, grantor.rolname,
               edge.admin_option, edge.inherit_option, edge.set_option
    `;
    return rows.map((row) => ({
      adminOption: row.admin_option,
      grantedRole: row.granted_role,
      grantor: row.grantor,
      inheritOption: row.inherit_option,
      member: row.member,
      setOption: row.set_option,
    }));
  }

  async function revokeMembership(edge: MembershipEdge): Promise<void> {
    await admin.unsafe(`
      REVOKE ${quoteIdentifier(edge.grantedRole)}
        FROM ${quoteIdentifier(edge.member)}
        GRANTED BY ${quoteIdentifier(edge.grantor)};
    `);
  }

  async function grantMembership(edge: MembershipEdge): Promise<void> {
    await admin.unsafe(`
      GRANT ${quoteIdentifier(edge.grantedRole)}
        TO ${quoteIdentifier(edge.member)}
        WITH ADMIN ${edge.adminOption ? 'TRUE' : 'FALSE'},
             INHERIT ${edge.inheritOption ? 'TRUE' : 'FALSE'},
             SET ${edge.setOption ? 'TRUE' : 'FALSE'}
        GRANTED BY ${quoteIdentifier(edge.grantor)};
    `);
  }

  async function removeNonMigrationOwnerMembers(): Promise<void> {
    for (const edge of await ownerMemberships(false)) await revokeMembership(edge);
  }

  async function restoreBaselineOwnerMembers(): Promise<void> {
    await removeNonMigrationOwnerMembers();
    for (const edge of baselineRuntimeMembers) await grantMembership(edge);
  }

  async function roleSnapshot(roleName: string): Promise<RoleSnapshot> {
    const [role] = await admin<
      Array<{
        rolbypassrls: boolean;
        rolcanlogin: boolean;
        rolconfig: string[] | null;
        rolconnlimit: number;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolinherit: boolean;
        rolpassword: string | null;
        rolreplication: boolean;
        rolsuper: boolean;
        rolvaliduntil: string | null;
      }>
    >`
      SELECT role.rolbypassrls,
             role.rolcanlogin,
             role.rolconfig,
             role.rolconnlimit,
             role.rolcreatedb,
             role.rolcreaterole,
             role.rolinherit,
             auth.rolpassword,
             role.rolreplication,
             role.rolsuper,
             role.rolvaliduntil::pg_catalog.text
      FROM pg_catalog.pg_roles AS role
      JOIN pg_catalog.pg_authid AS auth ON auth.oid = role.oid
      WHERE role.rolname = ${roleName}
    `;
    if (!role) throw new Error(`role ${roleName} is missing`);

    const memberships = await admin<
      Array<{
        admin_option: boolean;
        granted_role: string;
        grantor: string;
        inherit_option: boolean;
        member: string;
        set_option: boolean;
      }>
    >`
      SELECT edge.admin_option,
             granted.rolname AS granted_role,
             grantor.rolname AS grantor,
             edge.inherit_option,
             member.rolname AS member,
             edge.set_option
      FROM pg_catalog.pg_auth_members AS edge
      JOIN pg_catalog.pg_roles AS granted ON granted.oid = edge.roleid
      JOIN pg_catalog.pg_roles AS member ON member.oid = edge.member
      JOIN pg_catalog.pg_roles AS grantor ON grantor.oid = edge.grantor
      WHERE granted.rolname = ${roleName}
         OR member.rolname = ${roleName}
      ORDER BY granted.rolname, member.rolname, grantor.rolname,
               edge.admin_option, edge.inherit_option, edge.set_option
    `;

    return {
      bypassRls: role.rolbypassrls,
      canLogin: role.rolcanlogin,
      connectionLimit: role.rolconnlimit,
      createDatabase: role.rolcreatedb,
      createRole: role.rolcreaterole,
      inherit: role.rolinherit,
      memberships: memberships.map((edge) => ({
        adminOption: edge.admin_option,
        grantedRole: edge.granted_role,
        grantor: edge.grantor,
        inheritOption: edge.inherit_option,
        member: edge.member,
        setOption: edge.set_option,
      })),
      passwordVerifier: role.rolpassword,
      replication: role.rolreplication,
      settings: [...(role.rolconfig ?? [])].sort(),
      superuser: role.rolsuper,
      validUntil: role.rolvaliduntil,
    };
  }

  function expectRejected(result: SpawnSyncReturns<string>, message: string): void {
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(message);
    expect(result.stdout).not.toContain('GENERAL_APP_RUNTIME_PROVISIONED');
  }

  beforeAll(async () => {
    const migrationTarget = target(migrationUrl!);
    const generalTarget = target(generalAppUrl!);
    const adminTarget = target(adminUrl!);
    if (!/(?:^|[_-])test(?:$|[_-])/iu.test(migrationTarget.database)) {
      throw new Error(
        'general-app provisioner integration suite requires a dedicated test database',
      );
    }
    expect(generalTarget).toMatchObject({
      database: migrationTarget.database,
      host: migrationTarget.host,
      port: migrationTarget.port,
    });
    expect(adminTarget).toMatchObject({
      database: migrationTarget.database,
      host: migrationTarget.host,
      port: migrationTarget.port,
    });
    expect(generalTarget.username).not.toBe(migrationTarget.username);
    expect(adminTarget.username).not.toBe(migrationTarget.username);

    migrationUsername = migrationTarget.username;
    adminUsername = adminTarget.username;
    migration = postgres(migrationUrl!, { max: 1, onnotice: () => undefined });
    admin = postgres(adminUrl!, { max: 1, onnotice: () => undefined });

    const [adminPosture] = await admin<Array<{ superuser: boolean }>>`
      SELECT role.rolsuper AS superuser
      FROM pg_catalog.pg_roles AS role
      WHERE role.rolname = CURRENT_USER
    `;
    expect(adminPosture?.superuser).toBe(true);
    baselineRuntimeMembers = await ownerMemberships(false);
    expect(baselineRuntimeMembers).toEqual([
      {
        adminOption: false,
        grantedRole: OWNER_ROLE,
        grantor: migrationUsername,
        inheritOption: true,
        member: generalTarget.username,
        setOption: false,
      },
    ]);
  });

  beforeEach(async () => {
    trackedRoles = [];
    cleanupTasks = [];
    await removeNonMigrationOwnerMembers();
  });

  afterEach(async () => {
    const errors: unknown[] = [];
    for (const cleanup of cleanupTasks.reverse()) {
      await cleanup().catch((error: unknown) => errors.push(error));
    }
    for (const roleName of trackedRoles.reverse()) {
      await cleanupRole(roleName).catch((error: unknown) => errors.push(error));
    }
    await restoreBaselineOwnerMembers().catch((error: unknown) => errors.push(error));
    if (errors.length > 0) throw new AggregateError(errors, 'general-app fixture cleanup failed');
  });

  afterAll(async () => {
    await restoreBaselineOwnerMembers().catch(() => undefined);
    await migration?.end({ timeout: 5 });
    await admin?.end({ timeout: 5 });
  });

  it('creates and repairs one exact login and owner-group posture', async () => {
    const names = fixtureNames('happy');
    const oldPassword = password('old');
    const newPassword = password('new');
    await trackRole(
      names.target,
      `LOGIN NOINHERIT CREATEDB CREATEROLE CONNECTION LIMIT 7 PASSWORD ${quoteLiteral(oldPassword)}`,
    );
    await migration.unsafe(`
      ALTER ROLE ${quoteIdentifier(names.target)}
        SET application_name TO 'gprov-original';
    `);
    const before = await roleSnapshot(names.target);

    const result = runProvisioner(names.target, newPassword);
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('GENERAL_APP_RUNTIME_PROVISIONED');

    const after = await roleSnapshot(names.target);
    expect(after).toMatchObject({
      bypassRls: false,
      canLogin: true,
      connectionLimit: -1,
      createDatabase: false,
      createRole: false,
      inherit: true,
      replication: false,
      settings: [],
      superuser: false,
      validUntil: 'infinity',
    });
    expect(after.passwordVerifier).not.toBeNull();
    expect(after.passwordVerifier === before.passwordVerifier).toBe(false);
    expect(after.memberships).toEqual([
      {
        adminOption: false,
        grantedRole: OWNER_ROLE,
        grantor: migrationUsername,
        inheritOption: true,
        member: names.target,
        setOption: false,
      },
      {
        adminOption: true,
        grantedRole: names.target,
        grantor: adminUsername,
        inheritOption: false,
        member: migrationUsername,
        setOption: false,
      },
    ]);

    await expect(ownerMemberships()).resolves.toEqual([
      {
        adminOption: false,
        grantedRole: OWNER_ROLE,
        grantor: migrationUsername,
        inheritOption: true,
        member: names.target,
        setOption: false,
      },
      {
        adminOption: true,
        grantedRole: OWNER_ROLE,
        grantor: adminUsername,
        inheritOption: false,
        member: migrationUsername,
        setOption: false,
      },
      {
        adminOption: false,
        grantedRole: OWNER_ROLE,
        grantor: migrationUsername,
        inheritOption: false,
        member: migrationUsername,
        setOption: true,
      },
    ]);

    const [posture] = await admin<Array<{ safe: boolean }>>`
      SELECT NOT EXISTS (
               SELECT 1
               FROM pg_catalog.pg_shdepend AS dependency
               JOIN pg_catalog.pg_roles AS login ON login.rolname = ${names.target}
               WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
                 AND dependency.refobjid = login.oid
                 AND dependency.deptype = 'o'
             )
         AND NOT EXISTS (
               SELECT 1
               FROM pg_catalog.pg_default_acl AS default_acl
               JOIN pg_catalog.pg_roles AS login ON login.rolname = ${names.target}
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
               JOIN pg_catalog.pg_roles AS login ON login.rolname = ${names.target}
               CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS privilege
               WHERE privilege.grantee = login.oid
             )
         AND NOT EXISTS (
               SELECT 1
               FROM pg_catalog.pg_attribute AS attribute
               JOIN pg_catalog.pg_roles AS login ON login.rolname = ${names.target}
               CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
               WHERE privilege.grantee = login.oid
             )
         AND NOT EXISTS (
               SELECT 1
               FROM pg_catalog.pg_proc AS procedure
               JOIN pg_catalog.pg_roles AS login ON login.rolname = ${names.target}
               CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS privilege
               WHERE privilege.grantee = login.oid
             )
         AND NOT EXISTS (
               SELECT 1
               FROM pg_catalog.pg_namespace AS namespace
               JOIN pg_catalog.pg_roles AS login ON login.rolname = ${names.target}
               CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
               WHERE privilege.grantee = login.oid
             )
         AND NOT EXISTS (
               SELECT 1
               FROM pg_catalog.pg_database AS database
               JOIN pg_catalog.pg_roles AS login ON login.rolname = ${names.target}
               CROSS JOIN LATERAL pg_catalog.aclexplode(database.datacl) AS privilege
               WHERE privilege.grantee = login.oid
             )
         AND pg_catalog.has_table_privilege(${names.target}, 'public.builders', 'SELECT')
         AND pg_catalog.has_table_privilege(${names.target}, 'public.builders', 'INSERT')
         AND pg_catalog.has_table_privilege(${names.target}, 'public.builders', 'UPDATE')
         AND pg_catalog.has_table_privilege(${names.target}, 'public.builders', 'DELETE')
         AND pg_catalog.has_table_privilege(
               ${names.target},
               'public.schema_migrations',
               'SELECT'
             )
         AND NOT pg_catalog.has_table_privilege(
               ${names.target},
               'public.budget_accounts',
               'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
             )
         AND NOT pg_catalog.has_sequence_privilege(
               ${names.target},
               'public.pylva_budget_authority_order_seq',
               'USAGE,SELECT,UPDATE'
             )
         AND NOT pg_catalog.has_function_privilege(
               ${names.target},
               'public.pylva_budget_projection_actionable_builders(uuid,integer)',
               'EXECUTE'
             ) AS safe
    `;
    expect(posture?.safe).toBe(true);
  });

  it('rejects the fixed owner role when it is reused as the login identity', async () => {
    const before = await roleSnapshot(OWNER_ROLE);
    const result = runProvisioner(OWNER_ROLE, password('alias'));
    expectRejected(result, 'general-app login and owner group must be distinct');
    await expect(roleSnapshot(OWNER_ROLE)).resolves.toEqual(before);
  });

  it('rejects an existing NOLOGIN group instead of converting it into a login', async () => {
    const names = fixtureNames('groupid');
    await trackRole(names.target, 'NOLOGIN NOINHERIT');
    const before = await roleSnapshot(names.target);
    const result = runProvisioner(names.target, password('groupid'));
    expectRejected(result, 'refusing to repurpose a group identity');
    await expect(roleSnapshot(names.target)).resolves.toEqual(before);
  });

  it.each(['SUPERUSER', 'REPLICATION', 'BYPASSRLS'] as const)(
    'rejects protected %s drift before changing the login',
    async (attribute) => {
      const names = fixtureNames(attribute.toLowerCase());
      const oldPassword = password('protected-old');
      await trackRole(
        names.target,
        `LOGIN CONNECTION LIMIT 7 PASSWORD ${quoteLiteral(oldPassword)}`,
      );
      await admin.unsafe(`ALTER ROLE ${quoteIdentifier(names.target)} ${attribute}`);
      const before = await roleSnapshot(names.target);

      const result = runProvisioner(names.target, password('protected-new'));
      expectRejected(result, 'protected role-attribute drift');
      await expect(roleSnapshot(names.target)).resolves.toEqual(before);
    },
  );

  it.each([
    ['an unexpected role inherited by the login', 'outgoing'],
    ['a nested role inheriting through the login', 'nested'],
    ['an unexpected member of the fixed owner group', 'group-member'],
    ['the fixed owner group inheriting another role', 'group-outgoing'],
  ] as const)('rejects %s', async (_description, variant) => {
    const names = fixtureNames(variant.replace('-', ''));
    await trackRole(names.target, `LOGIN PASSWORD ${quoteLiteral(password('member-old'))}`);
    await trackRole(names.decoy, 'NOLOGIN NOINHERIT');
    if (variant === 'outgoing') {
      await migration.unsafe(`
        GRANT ${quoteIdentifier(names.decoy)} TO ${quoteIdentifier(names.target)};
      `);
    } else if (variant === 'nested') {
      await trackRole(names.nested, 'LOGIN INHERIT');
      await migration.unsafe(`
        GRANT ${quoteIdentifier(names.target)} TO ${quoteIdentifier(names.nested)};
      `);
    } else if (variant === 'group-member') {
      await migration.unsafe(`
        GRANT ${quoteIdentifier(OWNER_ROLE)} TO ${quoteIdentifier(names.decoy)}
          WITH ADMIN FALSE, INHERIT TRUE, SET FALSE
          GRANTED BY ${quoteIdentifier(migrationUsername)};
      `);
    } else {
      await migration.unsafe(`
        GRANT ${quoteIdentifier(names.decoy)} TO ${quoteIdentifier(OWNER_ROLE)};
      `);
    }

    const result = runProvisioner(names.target, password('member-new'));
    expectRejected(
      result,
      variant === 'outgoing'
        ? 'unexpected role-membership drift'
        : variant === 'nested'
          ? 'member roles that could inherit owner authority transitively'
          : 'owner group has unexpected membership drift',
    );
  });

  it.each([
    ['relation ownership', 'ownership'],
    ['owned default ACL', 'default-owner'],
    ['default ACL granted by another role', 'default-grantee'],
    ['direct database, schema, table, and column ACLs', 'direct'],
    ['direct routine ACL', 'routine'],
    ['authority ACL inherited through the fixed owner group', 'authority'],
  ] as const)('rejects %s drift', async (_description, variant) => {
    const names = fixtureNames(variant.replace('-', ''));
    await trackRole(names.target, `LOGIN PASSWORD ${quoteLiteral(password('acl-old'))}`);
    await trackRole(names.decoy, 'NOLOGIN NOINHERIT');

    if (variant === 'ownership') {
      cleanupTasks.push(async () => {
        await admin.unsafe(`DROP TABLE IF EXISTS public.${quoteIdentifier(names.table)}`);
      });
      await admin.unsafe(`
        CREATE TABLE public.${quoteIdentifier(names.table)} (
          id pg_catalog.int4 PRIMARY KEY
        );
        ALTER TABLE public.${quoteIdentifier(names.table)}
          OWNER TO ${quoteIdentifier(names.target)};
      `);
    } else if (variant === 'default-owner') {
      await admin.unsafe(`
        ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(names.target)} IN SCHEMA public
          GRANT SELECT ON TABLES TO ${quoteIdentifier(names.decoy)};
      `);
    } else if (variant === 'default-grantee') {
      await admin.unsafe(`
        ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(names.decoy)} IN SCHEMA public
          GRANT SELECT ON TABLES TO ${quoteIdentifier(names.target)};
      `);
    } else if (variant === 'direct') {
      await admin.unsafe(`
        GRANT TEMPORARY ON DATABASE ${quoteIdentifier(target(migrationUrl!).database)}
          TO ${quoteIdentifier(names.target)};
        GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(names.target)};
        GRANT SELECT ON TABLE public.builders TO ${quoteIdentifier(names.target)};
        GRANT UPDATE (id) ON TABLE public.builders TO ${quoteIdentifier(names.target)};
      `);
    } else if (variant === 'routine') {
      await admin.unsafe(`
        GRANT EXECUTE ON FUNCTION public.generate_slug(pg_catalog.text)
          TO ${quoteIdentifier(names.target)};
      `);
    } else {
      cleanupTasks.push(async () => {
        await admin.unsafe(`
          REVOKE ALL PRIVILEGES ON TABLE public.budget_accounts
            FROM ${quoteIdentifier(OWNER_ROLE)};
        `);
      });
      await admin.unsafe(`
        GRANT SELECT ON TABLE public.budget_accounts TO ${quoteIdentifier(OWNER_ROLE)};
      `);
    }

    const expectedMessage =
      variant === 'ownership'
        ? 'owns a database, schema, relation, sequence, or routine'
        : variant === 'default-owner' || variant === 'default-grantee'
          ? 'default-ACL drift'
          : variant === 'direct'
            ? 'direct database, schema, relation, or column ACL drift'
            : variant === 'routine'
              ? 'direct routine ACL drift'
              : 'direct authority ownership or ACL drift';
    expectRejected(runProvisioner(names.target, password('acl-new')), expectedMessage);
  });

  it('rolls back the exact password, settings, limits, and memberships after a late failure', async () => {
    const names = fixtureNames('rollback');
    const oldPassword = password('rollback-old');
    const newPassword = password('rollback-new');
    await trackRole(
      names.target,
      `LOGIN NOINHERIT CREATEDB CREATEROLE CONNECTION LIMIT 7 PASSWORD ${quoteLiteral(oldPassword)}`,
    );
    await migration.unsafe(`
      ALTER ROLE ${quoteIdentifier(names.target)}
        SET application_name TO 'gprov-rollback-original';
      ALTER ROLE ${quoteIdentifier(names.target)}
        SET statement_timeout TO '9876ms';
    `);
    const before = await roleSnapshot(names.target);
    let ownerSetEdgeRemoved = false;

    try {
      await admin.unsafe(`
        REVOKE ${quoteIdentifier(OWNER_ROLE)}
          FROM ${quoteIdentifier(migrationUsername)}
          GRANTED BY ${quoteIdentifier(migrationUsername)};
      `);
      ownerSetEdgeRemoved = true;
      const result = runProvisioner(names.target, newPassword);
      expectRejected(result, `permission denied to set role "${OWNER_ROLE}"`);

      const after = await roleSnapshot(names.target);
      expect(after.passwordVerifier === before.passwordVerifier).toBe(true);
      expect({ ...after, passwordVerifier: null }).toEqual({ ...before, passwordVerifier: null });
    } finally {
      if (ownerSetEdgeRemoved) {
        await admin.unsafe(`
          GRANT ${quoteIdentifier(OWNER_ROLE)}
            TO ${quoteIdentifier(migrationUsername)}
            WITH ADMIN FALSE, INHERIT FALSE, SET TRUE
            GRANTED BY ${quoteIdentifier(migrationUsername)};
        `);
      }
    }
  });
});
