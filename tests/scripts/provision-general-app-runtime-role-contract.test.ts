import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../../scripts/ci/provision-general-app-runtime.ts', import.meta.url),
  'utf8',
);

describe('general-app runtime role provisioner contract', () => {
  it('fails every ownership, ACL, membership, and default-ACL preflight before mutation', () => {
    const preflightStart = source.indexOf('const [preflight]');
    const mutationStart = source.indexOf('await sql.begin(');
    expect(preflightStart).toBeGreaterThanOrEqual(0);
    expect(mutationStart).toBeGreaterThan(preflightStart);

    const preflight = source.slice(preflightStart, mutationStart);
    for (const predicate of [
      'migrationRoleSafe',
      'fixedOwnerRoleSafe',
      'protectedAttributesSafe',
      'loginIdentitySafe',
      'loginMembershipsSafe',
      'loginHasNoMembers',
      'groupMembershipsSafe',
      'loginOwnershipSafe',
      'loginDefaultAclSafe',
      'directAclSafe',
      'routineAclSafe',
      'authorityAclSafe',
    ]) {
      expect(preflight, predicate).toContain(`preflight?.${predicate}`);
    }
    expect(preflight).toContain('database.datdba');
    expect(preflight).toContain('namespace.nspowner');
    expect(preflight).toContain('relation.relowner');
    expect(preflight).toContain('procedure.proowner');
    expect(preflight).toContain('default_acl.defaclrole');
    expect(preflight).toContain('pg_catalog.aclexplode(default_acl.defaclacl)');
    expect(preflight).toContain('login.oid = privilege.grantee');
  });

  it('allows only the unavoidable non-inheriting creator-admin reverse edge', () => {
    expect(source).toContain('member.rolname = CURRENT_USER');
    expect(source).toContain('member.rolcreaterole');
    expect(source).toContain('edge.admin_option');
    expect(source).toContain('NOT edge.inherit_option');
    expect(source).toContain('NOT edge.set_option');
    expect(source).toContain('pg_catalog.count(*) <= 1');
  });

  it('runs mutation and final posture in one rollback-capable transaction', () => {
    const transactionStart = source.indexOf('await sql.begin(async (transaction) => {');
    const mutation = source.indexOf('await transaction.unsafe(', transactionStart);
    const posture = source.indexOf('const [posture] = await transaction', mutation);
    const assertion = source.indexOf("'general-app runtime login posture is unsafe'", posture);
    const transactionEnd = source.indexOf('\n  });', assertion);

    expect(transactionStart).toBeGreaterThanOrEqual(0);
    expect(mutation).toBeGreaterThan(transactionStart);
    expect(posture).toBeGreaterThan(mutation);
    expect(assertion).toBeGreaterThan(posture);
    expect(transactionEnd).toBeGreaterThan(assertion);
  });

  it('attests no login ownership, direct ACL, unsafe default ACL, or authority access', () => {
    const posture = source.slice(source.indexOf('const [posture]'));
    expect(posture).toContain('database.datdba = login.oid');
    expect(posture).toContain('namespace.nspowner = login.oid');
    expect(posture).toContain('relation.relowner = login.oid');
    expect(posture).toContain('procedure.proowner = login.oid');
    expect(posture).toContain('default_acl.defaclrole = login.oid');
    expect(posture).toContain('privilege.grantee = login.oid');
    expect(posture).toContain('pg_catalog.has_table_privilege(');
    expect(posture).toContain('pg_catalog.has_column_privilege(');
    expect(posture).toContain('pg_catalog.has_sequence_privilege(');
    expect(posture).toContain('pylva_budget_projection_actionable_builders');
    expect(posture).toContain('pylva_budget_expiry_actionable_builders');
  });

  it('requires all four legacy CRUD privileges and SELECT-only schema status', () => {
    const posture = source.slice(source.indexOf('const [posture]'));
    for (const relation of ['public.builders', 'public.user_builder_memberships']) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        expect(posture).toMatch(
          new RegExp(`login\\.oid,\\s*'${relation.replace('.', '\\.')}',\\s*'${privilege}'`, 'u'),
        );
      }
    }
    expect(posture).toContain("'public.schema_migrations',\n          'SELECT'");
    expect(posture).toContain("'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'");
  });

  it('keeps migration, general-app, and fixed-owner identities separated', () => {
    expect(source).toContain("required('MIGRATION_DATABASE_URL')");
    expect(source).toContain("required('GENERAL_APP_DATABASE_URL')");
    expect(source).toContain('general-app and migration roles must be distinct');
    expect(source).toContain('general-app login and owner group must be distinct');
    expect(source).toContain('refusing to repurpose a group identity');
    expect(source).toContain("const GENERAL_APP_OWNER_ROLE = 'pylva_general_app_runtime'");
    expect(source).toContain('NOCREATEDB');
    expect(source).toContain('NOCREATEROLE');
    expect(source).toContain('WITH ADMIN FALSE, INHERIT TRUE, SET FALSE');
  });
});
