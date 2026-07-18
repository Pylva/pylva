import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(
  path.resolve('scripts/ci/provision-database-test-identities.ts'),
  'utf8',
);

describe('CI database test identities provisioner contract', () => {
  it('keeps fixture and RLS assertion credentials distinct and non-administrative', () => {
    expect(source).toContain("const FIXTURE_ROLE = 'pylva_fixture_ci'");
    expect(source).toContain("const RLS_TEST_ROLE = 'pylva_rls_test'");
    expect(source).toContain("const CI_DATABASE = 'pylva_test'");
    expect(source).toContain('LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE');
    expect(source).toContain('NOREPLICATION ${rlsAttribute}');
    expect(source).toContain("'PYLVA_TEST_DATABASE_URL', FIXTURE_ROLE, true");
    expect(source).toContain(
      "loginFromEnvironment('PYLVA_RLS_TEST_DATABASE_URL', RLS_TEST_ROLE, false)",
    );
    expect(source).not.toMatch(/GRANT\s+.*CREATEROLE/iu);
  });

  it('limits both logins to general-app-owned relations and denies authority reads', () => {
    expect(source).toContain("const GENERAL_APP_OWNER_ROLE = 'pylva_general_app_runtime'");
    expect(source).toContain('owner.rolname = ${quoteLiteral(GENERAL_APP_OWNER_ROLE)}');
    expect(source).toContain("'public.budget_control_cutovers', 'SELECT'");
    expect(source).toContain("'public.budget_rule_revisions', 'SELECT'");
    expect(source).toContain('authorityDenied: true');
    expect(source).not.toMatch(/GRANT\s+[^;]*ON\s+ALL\s+TABLES/iu);
  });
});
