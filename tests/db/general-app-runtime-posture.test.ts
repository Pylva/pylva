import type { Sql } from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: { NODE_ENV: 'production' },
  unsafe: vi.fn(),
}));

vi.mock('../../src/lib/config.js', () => ({ env: mocks.env }));
vi.mock('../../src/lib/db/client.js', () => ({
  sql: { unsafe: mocks.unsafe } as unknown as Sql,
}));

import {
  GeneralAppRuntimeNotReadyError,
  _resetGeneralAppRuntimePostureForTests,
  assertGeneralAppRuntimeReadyForProduction,
  evaluateGeneralAppRuntimeAttestation,
  getGeneralAppProductionPosture,
  type GeneralAppRuntimeAttestationRow,
} from '../../src/lib/db/general-app-runtime-posture.js';

function healthyRow(
  overrides: Partial<GeneralAppRuntimeAttestationRow> = {},
): GeneralAppRuntimeAttestationRow {
  return {
    ambient_access_ready: true,
    authority_access_denied: true,
    current_user_matches_login: true,
    legacy_crud_available: true,
    login_direct_acl_safe: true,
    login_ownership_safe: true,
    login_role_safe: true,
    membership_graph_safe: true,
    runtime_ownership_safe: true,
    runtime_role_safe: true,
    schema_migrations_select_only: true,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.env.NODE_ENV = 'production';
  mocks.unsafe.mockReset();
  mocks.unsafe.mockResolvedValue([healthyRow()]);
  _resetGeneralAppRuntimePostureForTests();
});

describe('general application runtime attestation evaluation', () => {
  it('accepts only the complete role, membership, ACL, and access posture', () => {
    expect(evaluateGeneralAppRuntimeAttestation([healthyRow()])).toBeNull();
  });

  it.each([
    ['current_user_matches_login', 'identity_mismatch'],
    ['login_role_safe', 'unsafe_login_role'],
    ['runtime_role_safe', 'unsafe_runtime_role'],
    ['runtime_ownership_safe', 'unsafe_runtime_ownership'],
    ['membership_graph_safe', 'unsafe_membership_graph'],
    ['login_ownership_safe', 'unsafe_login_ownership'],
    ['login_direct_acl_safe', 'unsafe_login_acl'],
    ['authority_access_denied', 'authority_access_exposed'],
    ['schema_migrations_select_only', 'migration_ledger_access_invalid'],
    ['legacy_crud_available', 'legacy_access_missing'],
    ['ambient_access_ready', 'ambient_access_missing'],
  ] as const)('maps a false %s attestation to %s', (field, reason) => {
    expect(evaluateGeneralAppRuntimeAttestation([healthyRow({ [field]: false })])).toBe(reason);
  });

  it('rejects malformed, empty, and duplicate rows', () => {
    expect(evaluateGeneralAppRuntimeAttestation([])).toBe('invalid_attestation');
    expect(evaluateGeneralAppRuntimeAttestation([healthyRow(), healthyRow()])).toBe(
      'invalid_attestation',
    );
    expect(
      evaluateGeneralAppRuntimeAttestation([healthyRow({ membership_graph_safe: 'true' })]),
    ).toBe('invalid_attestation');
  });
});

describe('production general application posture', () => {
  it('attests the general DATABASE_URL session once and caches success', async () => {
    const first = await getGeneralAppProductionPosture();
    const second = await getGeneralAppProductionPosture();

    expect(first).toEqual({ ready: true, reason: null, attested: true });
    expect(second).toEqual(first);
    expect(mocks.unsafe).toHaveBeenCalledTimes(1);
    const query = mocks.unsafe.mock.calls[0]?.[0];
    expect(query).toContain('CURRENT_USER = SESSION_USER');
    expect(query).toContain('pylva_general_app_runtime');
    expect(query).toContain('pylva_budget_authority_order_seq');
    expect(query).toContain('pylva_budget_projection_actionable_builders');
    expect(query).toContain('pylva_budget_expiry_actionable_builders');
    expect(query).toContain('user_builder_memberships');
    expect(query).toContain('SELECT pg_catalog.count(*) = 3');
    expect(query).toContain('FROM runtime_migrator');
    expect(query).toContain('complete_expected_runtime_relations');
    expect(query).toContain('procedure.prosecdef');
    expect(query).toContain("procedure.provolatile = 'v'");
    expect(query).toContain('pg_catalog.cardinality(procedure.proconfig) = 2');
    expect(query).toContain("'search_path=pg_catalog'");
    expect(query).toContain("setting.value LIKE 'TimeZone=%'");
    expect(query).toContain("privilege.privilege_type = 'EXECUTE'");
    expect(query).toMatch(
      /FROM legacy_crud_relations AS relation\s+CROSS JOIN LATERAL \(VALUES\s+\('SELECT'\), \('INSERT'\), \('UPDATE'\), \('DELETE'\)\s+\) AS candidate\(privilege_type\)\s+WHERE NOT pg_catalog\.has_table_privilege/u,
    );
    expect(query).toMatch(
      /HAVING pg_catalog\.count\(\*\) = 2\s+AND pg_catalog\.count\(\*\) FILTER \(\s+WHERE edge\.admin_option AND NOT edge\.set_option\s+\) = 1\s+AND pg_catalog\.count\(\*\) FILTER \(\s+WHERE NOT edge\.admin_option AND edge\.set_option\s+\) = 1/u,
    );
    expect(query).toMatch(
      /FROM complete_expected_runtime_relations\s+EXCEPT\s+SELECT schema_name, relation_name, relation_kind\s+FROM actual_runtime_relations/u,
    );
    expect(query).toMatch(
      /FROM actual_runtime_relations\s+EXCEPT\s+SELECT schema_name, relation_name, relation_kind\s+FROM complete_expected_runtime_relations/u,
    );
    expect(query).not.toContain("'SELECT,INSERT,UPDATE,DELETE'");
    expect(JSON.stringify(first)).not.toContain('postgresql://');
  });

  it('retries a query failure but caches deterministic refusal', async () => {
    mocks.unsafe.mockRejectedValueOnce(new Error('connection detail must not escape'));
    await expect(getGeneralAppProductionPosture()).resolves.toEqual({
      ready: false,
      reason: 'attestation_query_failed',
      attested: false,
    });
    await expect(getGeneralAppProductionPosture()).resolves.toMatchObject({ ready: true });
    expect(mocks.unsafe).toHaveBeenCalledTimes(2);

    _resetGeneralAppRuntimePostureForTests();
    mocks.unsafe.mockResolvedValue([healthyRow({ authority_access_denied: false })]);
    await getGeneralAppProductionPosture();
    await getGeneralAppProductionPosture();
    expect(mocks.unsafe).toHaveBeenCalledTimes(3);
  });

  it('fails production startup with a stable non-secret error', async () => {
    mocks.unsafe.mockResolvedValue([healthyRow({ login_direct_acl_safe: false })]);

    await expect(assertGeneralAppRuntimeReadyForProduction()).rejects.toEqual(
      expect.objectContaining<Partial<GeneralAppRuntimeNotReadyError>>({
        name: 'GeneralAppRuntimeNotReadyError',
        reason: 'unsafe_login_acl',
        status: 503,
        code: 'INTERNAL_ERROR',
      }),
    );
  });

  it('does not query catalog posture outside production', async () => {
    mocks.env.NODE_ENV = 'test';
    _resetGeneralAppRuntimePostureForTests();

    await expect(assertGeneralAppRuntimeReadyForProduction()).resolves.toBeUndefined();
    await expect(getGeneralAppProductionPosture()).resolves.toEqual({
      ready: true,
      reason: null,
      attested: false,
    });
    expect(mocks.unsafe).not.toHaveBeenCalled();
  });
});
