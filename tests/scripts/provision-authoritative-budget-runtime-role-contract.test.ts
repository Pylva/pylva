import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const SCRIPT_PATH = path.resolve('scripts/ci/provision-authoritative-budget-runtime.ts');

function scriptSource(): string {
  return fs.readFileSync(SCRIPT_PATH, 'utf8');
}

function requiredMatch(source: string, pattern: RegExp, label: string): string {
  const match = source.match(pattern)?.[0];
  if (!match) throw new Error(`Missing ${label} in ${SCRIPT_PATH}`);
  return match;
}

describe('authoritative budget runtime CI role provisioning contract', () => {
  it('fails closed on protected role-attribute drift before its first mutation', () => {
    const source = scriptSource();
    const preflightIndex = source.indexOf('const [protectedPosture]');
    const firstMutationIndex = source.indexOf('await sql.begin(');

    expect(preflightIndex).toBeGreaterThan(-1);
    expect(firstMutationIndex).toBeGreaterThan(preflightIndex);

    const preflight = source.slice(preflightIndex, firstMutationIndex);
    expect(preflight).toContain('login.rolsuper');
    expect(preflight).toContain('login.rolreplication');
    expect(preflight).toContain('login.rolbypassrls');
    expect(preflight).toContain('assert.equal(');
    expect(preflight).toContain('protected role-attribute drift');
  });

  it('refuses direct routine ACL drift instead of requiring sealed routine ownership', () => {
    const source = scriptSource();
    const preflightIndex = source.indexOf('const [protectedPosture]');
    const firstMutationIndex = source.indexOf('await sql.begin(');
    const preflight = source.slice(preflightIndex, firstMutationIndex);

    expect(preflight).toContain('pg_catalog.pg_proc');
    expect(preflight).toContain('pg_catalog.aclexplode(procedure.proacl)');
    expect(preflight).toContain('privilege.grantee = login.oid');
    expect(preflight).toContain('routineAclSafe');
    expect(preflight).toContain('direct routine ACL drift');
    expect(source).not.toContain('ON ALL FUNCTIONS IN SCHEMA public FROM ${role}');
    expect(source).not.toContain('ON ALL PROCEDURES IN SCHEMA public FROM ${role}');
  });

  it('creates absent roles with safe defaults and alters only CREATEROLE-safe attributes', () => {
    const source = scriptSource();
    const create = requiredMatch(
      source,
      /CREATE ROLE \$\{role\} LOGIN;/u,
      'safe-default runtime role creation',
    );
    const alter = requiredMatch(
      source,
      /ALTER ROLE \$\{role\}[\s\S]*?VALID UNTIL 'infinity';/u,
      'runtime role alteration',
    );

    expect(create).not.toMatch(/(?:NO)?(?:SUPERUSER|REPLICATION|BYPASSRLS)/u);
    expect(alter).toContain('LOGIN');
    expect(alter).toContain('INHERIT');
    expect(alter).toContain('NOCREATEDB');
    expect(alter).toContain('NOCREATEROLE');
    expect(alter).toContain('CONNECTION LIMIT -1');
    expect(alter).toContain('PASSWORD ${password}');
    expect(alter).not.toMatch(/(?:NO)?(?:SUPERUSER|REPLICATION|BYPASSRLS)/u);
    expect(source).toContain('ALTER ROLE ${role} RESET ALL;');
  });

  it('keeps every mutation and the complete postcondition in one transaction', () => {
    const source = scriptSource();
    const transactionStart = source.indexOf('await sql.begin(async (transaction) => {');
    const successOutput = source.indexOf(
      "process.stdout.write('AUTHORITATIVE_BUDGET_RUNTIME_PROVISIONED\\n')",
    );

    expect(transactionStart).toBeGreaterThan(-1);
    expect(source.match(/await sql\.begin\(/gu)).toHaveLength(1);
    expect(source).not.toContain('await sql.unsafe(');
    expect(successOutput).toBeGreaterThan(transactionStart);

    const transaction = source.slice(transactionStart, successOutput);
    expect(transaction.match(/await transaction\.unsafe\(/gu)).toHaveLength(3);
    expect(transaction).toContain('const [posture] = await transaction');
    expect(transaction).toContain('provisioning transaction rolled back');
    expect(transaction).toContain('CREATE ROLE ${role} LOGIN;');
    expect(transaction).toContain('PASSWORD ${password}');
    expect(transaction).toContain('DO $reset_runtime_memberships$');
    expect(transaction).toContain('GRANT pylva_budget_control_runtime TO ${role}');
  });

  it('attests exact role, membership, ownership, default ACL, and direct ACL closure', () => {
    const source = scriptSource();
    const attestation = requiredMatch(
      source,
      /const \[posture\][\s\S]*?CI runtime login posture is unsafe/u,
      'strict final runtime posture attestation',
    );

    expect(attestation).toContain('NOT login.rolsuper');
    expect(attestation).toContain('NOT login.rolreplication');
    expect(attestation).toContain('NOT login.rolbypassrls');
    expect(attestation).toContain("'pylva_budget_control_runtime'");
    expect(attestation).toContain('login.rolconnlimit = -1');
    expect(attestation).toContain("login.rolvaliduntil = 'infinity'");
    expect(attestation).toContain('pg_catalog.cardinality(login.rolconfig)');
    expect(attestation).toContain('edge.inherit_option');
    expect(attestation).toContain('edge.set_option');
    expect(attestation).toContain('reachable_roles');
    expect(attestation).toContain('pg_catalog.pg_shdepend');
    expect(attestation).toContain("dependency.deptype = 'o'");
    expect(attestation).toContain('pg_catalog.pg_default_acl');
    expect(attestation).toContain('pg_catalog.pg_class');
    expect(attestation).toContain('pg_catalog.pg_attribute');
    expect(attestation).toContain('pg_catalog.pg_proc');
    expect(attestation).toContain('pg_catalog.pg_namespace');
    expect(attestation).toContain('direct_database_acl');
    expect(attestation).toContain("privilege.privilege_type = 'CONNECT'");
    expect(attestation).toContain('NOT privilege.is_grantable');
  });

  it('cleans direct relation ACLs through both post-054 object owners', () => {
    const source = scriptSource();

    expect(source).toContain('relation.relowner = (');
    expect(source).toContain('owner.rolname = CURRENT_USER');
    expect(source).toContain("const GENERAL_APP_OWNER_ROLE = 'pylva_general_app_runtime'");
    expect(source).toContain('SET ROLE ${GENERAL_APP_OWNER_ROLE};');
    expect(source).toContain('${resetRuntimeRelationAclForCurrentOwner}');
    expect(source.match(/\$\{resetRuntimeRelationAclForCurrentOwner\}/gu)).toHaveLength(2);
    expect(source).toContain('RESET ROLE;');
    expect(source).not.toContain(
      'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${role}',
    );
    expect(source).not.toContain(
      'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${role}',
    );
  });
});
