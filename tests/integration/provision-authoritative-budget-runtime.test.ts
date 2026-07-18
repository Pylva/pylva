import crypto from 'node:crypto';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migrationUrl = process.env['MIGRATION_DATABASE_URL'];
const generalAppUrl = process.env['GENERAL_APP_DATABASE_URL'];
const shouldRun = Boolean(migrationUrl && generalAppUrl);

const suite = shouldRun ? describe.sequential : describe.skip;

interface FixtureNames {
  decoy: string;
  hostile: string;
  table: string;
  target: string;
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value)) throw new Error(`unsafe test identifier: ${value}`);
  return `"${value}"`;
}

function fixtureNames(label: string): FixtureNames {
  const suffix = crypto.randomBytes(4).toString('hex');
  return {
    decoy: `pylva_bprov_decoy_${label}_${suffix}`,
    hostile: `pylva_bprov_hostile_${label}_${suffix}`,
    table: `bprov_hostile_${label}_${suffix}`,
    target: `pylva_bprov_target_${label}_${suffix}`,
  };
}

function runtimeUrl(username: string, password: string): string {
  const target = new URL(migrationUrl!);
  target.username = username;
  target.password = password;
  return target.toString();
}

function runProvisioner(username: string, password: string): SpawnSyncReturns<string> {
  return spawnSync(
    'pnpm',
    ['exec', 'tsx', 'scripts/ci/provision-authoritative-budget-runtime.ts'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        BUDGET_CONTROL_DATABASE_URL: runtimeUrl(username, password),
        MIGRATION_DATABASE_URL: migrationUrl!,
      },
      timeout: 30_000,
    },
  );
}

async function credentialWorks(url: string, expectedUsername: string): Promise<boolean> {
  const client = postgres(url, { connect_timeout: 2, max: 1 });
  try {
    const [identity] = await client<Array<{ current_user: string }>>`
      SELECT CURRENT_USER AS current_user
    `;
    return identity?.current_user === expectedUsername;
  } catch {
    return false;
  } finally {
    await client.end({ timeout: 1 }).catch(() => undefined);
  }
}

suite('authoritative budget runtime provisioner transaction boundary', () => {
  let migration: Sql;
  let migrationUsername: string;

  beforeAll(() => {
    migration = postgres(migrationUrl!, { max: 1, onnotice: () => undefined });
    migrationUsername = decodeURIComponent(new URL(migrationUrl!).username);
  });

  afterAll(async () => {
    await migration?.end({ timeout: 5 });
  });

  async function roleExists(roleName: string): Promise<boolean> {
    const [row] = await migration<Array<{ present: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles AS role WHERE role.rolname = ${roleName}
      ) AS present
    `;
    return row?.present === true;
  }

  async function cleanupRole(roleName: string): Promise<void> {
    if (!(await roleExists(roleName))) return;
    const role = quoteIdentifier(roleName);
    const migrator = quoteIdentifier(migrationUsername);
    const resetOwnedAcl = `
      DO $reset_owned_relation_acl$
      DECLARE
        relation_row RECORD;
      BEGIN
        FOR relation_row IN
          SELECT namespace.nspname, relation.relname, relation.relkind
          FROM pg_catalog.pg_class AS relation
          JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public'
            AND relation.relowner = (
              SELECT owner.oid FROM pg_catalog.pg_roles AS owner WHERE owner.rolname = CURRENT_USER
            )
            AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
        LOOP
          IF relation_row.relkind = 'S' THEN
            EXECUTE pg_catalog.format(
              'REVOKE ALL PRIVILEGES ON SEQUENCE %I.%I FROM %I',
              relation_row.nspname, relation_row.relname, '${roleName}'
            );
          ELSE
            EXECUTE pg_catalog.format(
              'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM %I',
              relation_row.nspname, relation_row.relname, '${roleName}'
            );
          END IF;
        END LOOP;
      END;
      $reset_owned_relation_acl$;

      DO $reset_owned_column_acl$
      DECLARE
        grant_row RECORD;
      BEGIN
        FOR grant_row IN
          SELECT namespace.nspname,
                 relation.relname,
                 privilege.privilege_type,
                 pg_catalog.string_agg(pg_catalog.format('%I', attribute.attname), ', ')
                   AS column_list
          FROM pg_catalog.pg_attribute AS attribute
          JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
          JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
          JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
          WHERE namespace.nspname = 'public'
            AND relation.relowner = (
              SELECT owner.oid FROM pg_catalog.pg_roles AS owner WHERE owner.rolname = CURRENT_USER
            )
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
            AND grantee.rolname = '${roleName}'
          GROUP BY namespace.nspname, relation.relname, privilege.privilege_type
        LOOP
          EXECUTE pg_catalog.format(
            'REVOKE %s (%s) ON TABLE %I.%I FROM %I',
            grant_row.privilege_type,
            grant_row.column_list,
            grant_row.nspname,
            grant_row.relname,
            '${roleName}'
          );
        END LOOP;
      END;
      $reset_owned_column_acl$;
    `;

    await migration.unsafe(`
      DO $remove_outgoing_memberships$
      DECLARE
        granted_role RECORD;
      BEGIN
        FOR granted_role IN
          SELECT granted.rolname
          FROM pg_catalog.pg_auth_members AS edge
          JOIN pg_catalog.pg_roles AS member ON member.oid = edge.member
          JOIN pg_catalog.pg_roles AS granted ON granted.oid = edge.roleid
          WHERE member.rolname = '${roleName}'
        LOOP
          EXECUTE pg_catalog.format(
            'REVOKE %I FROM %I',
            granted_role.rolname,
            '${roleName}'
          );
        END LOOP;
      END;
      $remove_outgoing_memberships$;

      REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${role};
      DO $remove_database_acl$
      BEGIN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I',
          pg_catalog.current_database(),
          '${roleName}'
        );
      END;
      $remove_database_acl$;

      ${resetOwnedAcl}
      SET ROLE pylva_general_app_runtime;
      ${resetOwnedAcl}
      RESET ROLE;

      GRANT ${role} TO ${migrator}
        WITH ADMIN FALSE, INHERIT FALSE, SET TRUE
        GRANTED BY ${migrator};
      SET ROLE ${role};
      DROP OWNED BY ${role};
      RESET ROLE;
      REVOKE ${role} FROM ${migrator} GRANTED BY ${migrator};
      DROP ROLE ${role};
    `);
  }

  async function cleanupFixture(names: FixtureNames): Promise<void> {
    // Drop a hostile-owned table first so its ACL dependency cannot pin the
    // disposable login during cleanup.
    await cleanupRole(names.hostile);
    await cleanupRole(names.target);
    await cleanupRole(names.decoy);
  }

  async function createLoginWithDecoyMembership(
    names: FixtureNames,
    oldPassword: string,
  ): Promise<void> {
    const target = quoteIdentifier(names.target);
    const decoy = quoteIdentifier(names.decoy);
    await migration.unsafe(`
      CREATE ROLE ${decoy} NOLOGIN;
      CREATE ROLE ${target} LOGIN PASSWORD '${oldPassword}' CONNECTION LIMIT 7;
      ALTER ROLE ${target} SET application_name TO 'bprov-original';
      GRANT ${decoy} TO ${target};
    `);
  }

  async function outgoingMemberships(roleName: string): Promise<string[]> {
    const rows = await migration<Array<{ granted_role: string }>>`
      SELECT granted.rolname AS granted_role
      FROM pg_catalog.pg_auth_members AS edge
      JOIN pg_catalog.pg_roles AS member ON member.oid = edge.member
      JOIN pg_catalog.pg_roles AS granted ON granted.oid = edge.roleid
      WHERE member.rolname = ${roleName}
      ORDER BY granted.rolname
    `;
    return rows.map((row) => row.granted_role);
  }

  async function roleMutationState(
    roleName: string,
  ): Promise<{ connectionLimit: number; settings: string[] }> {
    const [role] = await migration<Array<{ rolconfig: string[] | null; rolconnlimit: number }>>`
      SELECT role.rolconfig, role.rolconnlimit
      FROM pg_catalog.pg_roles AS role
      WHERE role.rolname = ${roleName}
    `;
    return {
      connectionLimit: role?.rolconnlimit ?? Number.NaN,
      settings: role?.rolconfig ?? [],
    };
  }

  it('cleans direct table and column ACL drift through both expected owners', async () => {
    const names = fixtureNames('owners');
    const oldPassword = `old-${crypto.randomBytes(12).toString('hex')}`;
    const newPassword = `new-${crypto.randomBytes(12).toString('hex')}`;
    const target = quoteIdentifier(names.target);

    try {
      await migration.unsafe(`
        CREATE ROLE ${target} LOGIN PASSWORD '${oldPassword}' CONNECTION LIMIT 7;
        ALTER ROLE ${target} SET application_name TO 'bprov-original';
      `);
      await migration.unsafe(`GRANT SELECT ON TABLE public.budget_accounts TO ${target};`);
      await migration.unsafe(`
        SET ROLE pylva_general_app_runtime;
        GRANT SELECT ON TABLE public.customer_pricing TO ${target};
        GRANT UPDATE (id) ON TABLE public.customer_pricing TO ${target};
        RESET ROLE;
      `);

      // Local initdb commonly uses trust authentication; hosted CI uses SCRAM.
      // Exercise the password verifier wherever HBA actually enforces it while
      // always proving transactional ALTER ROLE rollback through visible state.
      const passwordAuthenticationEnforced = !(await credentialWorks(
        runtimeUrl(names.target, newPassword),
        names.target,
      ));
      const result = runProvisioner(names.target, newPassword);
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('AUTHORITATIVE_BUDGET_RUNTIME_PROVISIONED');
      expect(await outgoingMemberships(names.target)).toEqual(['pylva_budget_control_runtime']);

      const [acl] = await migration<Array<{ safe: boolean }>>`
        SELECT NOT EXISTS (
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
        ) AS safe
      `;
      expect(acl?.safe).toBe(true);
      await expect(roleMutationState(names.target)).resolves.toEqual({
        connectionLimit: -1,
        settings: [],
      });
      await expect(
        credentialWorks(runtimeUrl(names.target, newPassword), names.target),
      ).resolves.toBe(true);
      if (passwordAuthenticationEnforced) {
        await expect(
          credentialWorks(runtimeUrl(names.target, oldPassword), names.target),
        ).resolves.toBe(false);
      }
    } finally {
      await cleanupFixture(names);
    }
  });

  it('rejects a hostile third-owner ACL and rolls back password and membership changes', async () => {
    const names = fixtureNames('hostile');
    const oldPassword = `old-${crypto.randomBytes(12).toString('hex')}`;
    const newPassword = `new-${crypto.randomBytes(12).toString('hex')}`;
    const hostile = quoteIdentifier(names.hostile);
    const table = quoteIdentifier(names.table);
    const target = quoteIdentifier(names.target);
    const migrator = quoteIdentifier(migrationUsername);

    try {
      await createLoginWithDecoyMembership(names, oldPassword);
      await migration.unsafe(`
        CREATE ROLE ${hostile} NOLOGIN;
        GRANT USAGE, CREATE ON SCHEMA public TO ${hostile};
        GRANT ${hostile} TO ${migrator}
          WITH ADMIN FALSE, INHERIT FALSE, SET TRUE
          GRANTED BY ${migrator};
        SET ROLE ${hostile};
        CREATE TABLE public.${table} (id pg_catalog.int4 PRIMARY KEY);
        GRANT SELECT ON TABLE public.${table} TO ${target};
        RESET ROLE;
      `);

      const passwordAuthenticationEnforced = !(await credentialWorks(
        runtimeUrl(names.target, newPassword),
        names.target,
      ));
      const result = runProvisioner(names.target, newPassword);
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        'provisioning transaction rolled back',
      );
      expect(result.stdout).not.toContain('AUTHORITATIVE_BUDGET_RUNTIME_PROVISIONED');
      expect(await outgoingMemberships(names.target)).toEqual([names.decoy]);
      await expect(roleMutationState(names.target)).resolves.toEqual({
        connectionLimit: 7,
        settings: ['application_name=bprov-original'],
      });
      await expect(
        credentialWorks(runtimeUrl(names.target, oldPassword), names.target),
      ).resolves.toBe(true);
      if (passwordAuthenticationEnforced) {
        await expect(
          credentialWorks(runtimeUrl(names.target, newPassword), names.target),
        ).resolves.toBe(false);
      }

      const [hostileAcl] = await migration<Array<{ present: boolean }>>`
        SELECT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_class AS relation
          JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          JOIN pg_catalog.pg_roles AS login ON login.rolname = ${names.target}
          CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS privilege
          WHERE namespace.nspname = 'public'
            AND relation.relname = ${names.table}
            AND privilege.grantee = login.oid
        ) AS present
      `;
      expect(hostileAcl?.present).toBe(true);
    } finally {
      await cleanupFixture(names);
    }
  });

  it('rolls back password and membership changes when the owner SET edge is unavailable', async () => {
    const names = fixtureNames('setfail');
    const oldPassword = `old-${crypto.randomBytes(12).toString('hex')}`;
    const newPassword = `new-${crypto.randomBytes(12).toString('hex')}`;
    const migrator = quoteIdentifier(migrationUsername);
    let ownerSetEdgeRemoved = false;

    try {
      await createLoginWithDecoyMembership(names, oldPassword);
      await migration.unsafe(`
        REVOKE pylva_general_app_runtime FROM ${migrator} GRANTED BY ${migrator};
      `);
      ownerSetEdgeRemoved = true;

      const passwordAuthenticationEnforced = !(await credentialWorks(
        runtimeUrl(names.target, newPassword),
        names.target,
      ));
      const result = runProvisioner(names.target, newPassword);
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        'permission denied to set role "pylva_general_app_runtime"',
      );
      expect(result.stdout).not.toContain('AUTHORITATIVE_BUDGET_RUNTIME_PROVISIONED');

      await migration.unsafe(`
        GRANT pylva_general_app_runtime TO ${migrator}
          WITH ADMIN FALSE, INHERIT FALSE, SET TRUE
          GRANTED BY ${migrator};
      `);
      ownerSetEdgeRemoved = false;

      expect(await outgoingMemberships(names.target)).toEqual([names.decoy]);
      await expect(roleMutationState(names.target)).resolves.toEqual({
        connectionLimit: 7,
        settings: ['application_name=bprov-original'],
      });
      await expect(
        credentialWorks(runtimeUrl(names.target, oldPassword), names.target),
      ).resolves.toBe(true);
      if (passwordAuthenticationEnforced) {
        await expect(
          credentialWorks(runtimeUrl(names.target, newPassword), names.target),
        ).resolves.toBe(false);
      }
    } finally {
      if (ownerSetEdgeRemoved) {
        await migration.unsafe(`
          GRANT pylva_general_app_runtime TO ${migrator}
            WITH ADMIN FALSE, INHERIT FALSE, SET TRUE
            GRANTED BY ${migrator};
        `);
      }
      await cleanupFixture(names);
    }
  });
});
