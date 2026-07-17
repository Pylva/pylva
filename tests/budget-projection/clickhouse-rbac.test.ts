import { describe, expect, it } from 'vitest';
import {
  authoritativeBudgetInsertRevoke,
  authoritativeBudgetInsertRevokeAllExcept,
  buildAuthoritativeBudgetClickHouseRbacStatements,
  exactGrantLines,
  expectedAuthoritativeBudgetClickHouseGrants,
} from '../../src/lib/budget-projection/clickhouse-rbac.js';
import { provisionAuthoritativeBudgetClickHouseRbac } from '../../scripts/provision-authoritative-budget-clickhouse-rbac.js';

const IDENTITY = {
  database: 'pylva_prod',
  generalUsername: 'pylva_app',
  projectorUsername: 'pylva_projector',
};

describe('authoritative ClickHouse RBAC provisioning artifact', () => {
  it('replaces all direct/inherited grants before applying the exact two-role contract', () => {
    expect(buildAuthoritativeBudgetClickHouseRbacStatements(IDENTITY)).toEqual([
      'CREATE ROLE IF NOT EXISTS "pylva_authoritative_budget_projector"',
      'CREATE ROLE IF NOT EXISTS "pylva_general_app_runtime"',
      'REVOKE ALL ON *.* FROM "pylva_authoritative_budget_projector"',
      'REVOKE ALL FROM "pylva_authoritative_budget_projector"',
      'REVOKE ALL ON *.* FROM "pylva_general_app_runtime"',
      'REVOKE ALL FROM "pylva_general_app_runtime"',
      'REVOKE ALL ON *.* FROM "pylva_projector"',
      'REVOKE ALL FROM "pylva_projector"',
      'REVOKE ALL ON *.* FROM "pylva_app"',
      'REVOKE ALL FROM "pylva_app"',
      'GRANT SELECT, INSERT ON "pylva_prod"."budget_cost_events" TO "pylva_authoritative_budget_projector"',
      'GRANT SELECT ON "pylva_prod".* TO "pylva_general_app_runtime"',
      'GRANT INSERT ON "pylva_prod"."cost_events" TO "pylva_general_app_runtime"',
      'GRANT ALTER UPDATE(cost_usd, pricing_status) ON "pylva_prod"."cost_events" TO "pylva_general_app_runtime"',
      'GRANT "pylva_authoritative_budget_projector" TO "pylva_projector"',
      'GRANT "pylva_general_app_runtime" TO "pylva_app"',
      'SET DEFAULT ROLE "pylva_authoritative_budget_projector" TO "pylva_projector"',
      'SET DEFAULT ROLE "pylva_general_app_runtime" TO "pylva_app"',
    ]);
  });

  it('contains no URL or password parameter and safely quotes every operator identifier', () => {
    const statements = buildAuthoritativeBudgetClickHouseRbacStatements({
      database: 'prod-db',
      generalRole: 'general role',
      generalUsername: 'general-user',
      projectorRole: 'projector role',
      projectorUsername: 'projector-user',
    });
    const sql = statements.join('\n');
    expect(sql).toContain('"prod-db"."budget_cost_events"');
    expect(sql).toContain('"projector role"');
    expect(sql).toContain('"general-user"');
    expect(sql).not.toMatch(/password|https?:\/\//iu);
  });

  it('rejects role or user identity collapse', () => {
    expect(() =>
      buildAuthoritativeBudgetClickHouseRbacStatements({
        ...IDENTITY,
        generalUsername: IDENTITY.projectorUsername,
      }),
    ).toThrow(/users must be distinct/);
    expect(() =>
      buildAuthoritativeBudgetClickHouseRbacStatements({
        ...IDENTITY,
        generalRole: 'shared',
        projectorRole: 'shared',
      }),
    ).toThrow(/roles must be distinct/);
  });

  it('defines exact user and fixed-role validation output compatible with ClickHouse 24.8', () => {
    const expected = expectedAuthoritativeBudgetClickHouseGrants(IDENTITY);
    expect(expected).toEqual({
      projectorDirect: ['GRANT pylva_authoritative_budget_projector TO pylva_projector'],
      projectorRole: [
        'GRANT SELECT, INSERT ON pylva_prod.budget_cost_events TO pylva_authoritative_budget_projector',
      ],
      generalDirect: ['GRANT pylva_general_app_runtime TO pylva_app'],
      generalRole: [
        'GRANT SELECT ON pylva_prod.* TO pylva_general_app_runtime',
        'GRANT INSERT, ALTER UPDATE(cost_usd, pricing_status) ON pylva_prod.cost_events TO pylva_general_app_runtime',
      ],
    });
    expect(exactGrantLines([...expected.generalRole].reverse(), expected.generalRole)).toBe(true);
    expect(
      exactGrantLines(
        [...expected.generalRole, 'GRANT ALTER ON *.* TO pylva_general_app_runtime'],
        expected.generalRole,
      ),
    ).toBe(false);
  });

  it('builds a narrow partial revoke for every non-projector writer', () => {
    expect(authoritativeBudgetInsertRevoke('prod-db', 'hostile writer')).toBe(
      'REVOKE INSERT ON "prod-db"."budget_cost_events" FROM "hostile writer"',
    );
    expect(
      authoritativeBudgetInsertRevokeAllExcept('prod-db', ['projector role', 'break-glass']),
    ).toBe(
      'REVOKE INSERT ON "prod-db"."budget_cost_events" FROM ALL EXCEPT "projector role", "break-glass"',
    );
    expect(() => authoritativeBudgetInsertRevokeAllExcept('prod-db', [])).toThrow(/at least one/);
  });

  it('rejects insecure or credential-free production admin URLs before connecting', async () => {
    const applicationUrls = {
      CLICKHOUSE_URL: 'https://general:general-secret@clickhouse.internal:8443/pylva_prod',
      BUDGET_PROJECTION_CLICKHOUSE_URL:
        'https://projector:projector-secret@clickhouse.internal:8443/pylva_prod',
    };
    await expect(
      provisionAuthoritativeBudgetClickHouseRbac({
        ...applicationUrls,
        CLICKHOUSE_ADMIN_URL: 'http://admin:admin-secret@clickhouse.internal:8123/pylva_prod',
      }),
    ).rejects.toThrow('CLICKHOUSE_ADMIN_URL must use https:// transport');
    await expect(
      provisionAuthoritativeBudgetClickHouseRbac({
        ...applicationUrls,
        CLICKHOUSE_ADMIN_URL: 'https://clickhouse.internal:8443/pylva_prod',
      }),
    ).rejects.toThrow('CLICKHOUSE_ADMIN_URL must contain a non-default username and credential');
  });
});
