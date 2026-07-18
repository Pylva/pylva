import type { Sql } from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: {
    NODE_ENV: 'production',
    ENABLE_AUTHORITATIVE_BUDGET_CONTROL: true,
  },
  getBudgetControlClientMetadata: vi.fn(),
  getBudgetControlSql: vi.fn(),
  unsafe: vi.fn(),
}));

vi.mock('../../src/lib/config.js', () => ({ env: mocks.env }));
vi.mock('../../src/lib/budget-control/client.js', () => ({
  getBudgetControlClientMetadata: mocks.getBudgetControlClientMetadata,
  getBudgetControlSql: mocks.getBudgetControlSql,
}));

import { BudgetControlDatabaseConfigError } from '../../src/lib/budget-control/database-config.js';
import {
  BudgetControlRuntimeNotReadyError,
  _resetBudgetControlRuntimePostureForTests,
  assertBudgetControlRuntimeReadyForProduction,
  evaluateBudgetControlRuntimeAttestation,
  getBudgetControlProductionPosture,
  getReadyBudgetControlSql,
  type BudgetControlRuntimeAttestationRow,
} from '../../src/lib/budget-control/runtime-posture.js';

function healthyRow(
  overrides: Partial<BudgetControlRuntimeAttestationRow> = {},
): BudgetControlRuntimeAttestationRow {
  return {
    current_user_matches_login: true,
    login_role_safe: true,
    runtime_role_safe: true,
    has_runtime_membership: true,
    has_no_dangerous_membership: true,
    login_acl_safe: true,
    runtime_acl_safe: true,
    owns_no_protected_relations: true,
    protected_relations_complete: true,
    protected_relations_rls_enabled: true,
    authoritative_relations_force_rls: true,
    legacy_relations_not_force_rls: true,
    row_security_on: true,
    discovery_functions_safe: true,
    projection_discovery_executable: true,
    expiry_discovery_executable: true,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.env.NODE_ENV = 'production';
  mocks.env.ENABLE_AUTHORITATIVE_BUDGET_CONTROL = true;
  mocks.getBudgetControlClientMetadata.mockReset();
  mocks.getBudgetControlClientMetadata.mockReturnValue({
    expectedUsername: 'pylva_budget_login',
    source: 'dedicated',
  });
  mocks.unsafe.mockReset();
  mocks.unsafe.mockResolvedValue([healthyRow()]);
  mocks.getBudgetControlSql.mockReset();
  mocks.getBudgetControlSql.mockReturnValue({ unsafe: mocks.unsafe } as unknown as Sql);
  _resetBudgetControlRuntimePostureForTests();
});

describe('budget-control runtime attestation evaluation', () => {
  it('accepts only the complete safe role, ownership, RLS, and execute posture', () => {
    expect(evaluateBudgetControlRuntimeAttestation([healthyRow()])).toBeNull();
  });

  it.each([
    ['current_user_matches_login', 'unsafe_login_role'],
    ['login_role_safe', 'unsafe_login_role'],
    ['runtime_role_safe', 'unsafe_runtime_role'],
    ['has_runtime_membership', 'missing_runtime_membership'],
    ['has_no_dangerous_membership', 'dangerous_role_membership'],
    ['login_acl_safe', 'unsafe_login_acl'],
    ['runtime_acl_safe', 'unsafe_runtime_acl'],
    ['owns_no_protected_relations', 'protected_object_ownership'],
    ['protected_relations_complete', 'schema_incomplete'],
    ['protected_relations_rls_enabled', 'row_security_disabled'],
    ['authoritative_relations_force_rls', 'row_security_disabled'],
    ['legacy_relations_not_force_rls', 'row_security_disabled'],
    ['row_security_on', 'row_security_disabled'],
    ['discovery_functions_safe', 'unsafe_discovery_function'],
    ['projection_discovery_executable', 'missing_projection_discovery_execute'],
    ['expiry_discovery_executable', 'missing_expiry_discovery_execute'],
  ] as const)('maps a false %s attestation to %s', (field, reason) => {
    expect(evaluateBudgetControlRuntimeAttestation([healthyRow({ [field]: false })])).toBe(reason);
  });

  it('fails malformed, empty, and duplicate rows closed', () => {
    expect(evaluateBudgetControlRuntimeAttestation([])).toBe('invalid_attestation');
    expect(evaluateBudgetControlRuntimeAttestation([healthyRow(), healthyRow()])).toBe(
      'invalid_attestation',
    );
    expect(evaluateBudgetControlRuntimeAttestation([healthyRow({ row_security_on: 'true' })])).toBe(
      'invalid_attestation',
    );
  });
});

describe('production budget-control posture', () => {
  it('attests once, caches success, and exposes no URL or role name', async () => {
    const first = await getBudgetControlProductionPosture();
    const second = await getBudgetControlProductionPosture();
    expect(first).toEqual({
      ready: true,
      reason: null,
      attested: true,
      credential_source: 'dedicated',
    });
    expect(second).toEqual(first);
    expect(mocks.unsafe).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first)).not.toContain('pylva_budget_login');
    expect(JSON.stringify(first)).not.toContain('postgresql://');
    expect(mocks.unsafe.mock.calls[0]?.[0]).toContain('pylva_budget_control_runtime');
    expect(mocks.unsafe.mock.calls[0]?.[0]).toContain('pylva_budget_expiry_actionable_builders');
  });

  it('returns a safe disabled posture for missing or reused credentials', async () => {
    mocks.getBudgetControlClientMetadata.mockImplementation(() => {
      throw new BudgetControlDatabaseConfigError(
        'credential_reuse',
        'test message must not escape',
      );
    });
    await expect(getBudgetControlProductionPosture()).resolves.toEqual({
      ready: false,
      reason: 'credential_isolation_failed',
      attested: false,
      credential_source: null,
    });
  });

  it('retries a transient attestation query failure but caches deterministic refusal', async () => {
    mocks.unsafe.mockRejectedValueOnce(new Error('connection details must not escape'));
    await expect(getBudgetControlProductionPosture()).resolves.toMatchObject({
      ready: false,
      reason: 'attestation_query_failed',
    });
    await expect(getBudgetControlProductionPosture()).resolves.toMatchObject({ ready: true });
    expect(mocks.unsafe).toHaveBeenCalledTimes(2);

    _resetBudgetControlRuntimePostureForTests();
    mocks.unsafe.mockResolvedValue([healthyRow({ row_security_on: false })]);
    await getBudgetControlProductionPosture();
    await getBudgetControlProductionPosture();
    expect(mocks.unsafe).toHaveBeenCalledTimes(3);
  });

  it('makes the default client path fail before mutation when attestation is unsafe', async () => {
    mocks.unsafe.mockResolvedValue([healthyRow({ login_role_safe: false })]);
    await expect(getReadyBudgetControlSql()).rejects.toEqual(
      expect.objectContaining<Partial<BudgetControlRuntimeNotReadyError>>({
        name: 'BudgetControlRuntimeNotReadyError',
        reason: 'unsafe_login_role',
        status: 503,
        code: 'INTERNAL_ERROR',
      }),
    );
  });

  it('uses explicit local/test configuration without pretending it was role-attested', async () => {
    mocks.env.NODE_ENV = 'test';
    _resetBudgetControlRuntimePostureForTests();
    await expect(getBudgetControlProductionPosture()).resolves.toEqual({
      ready: true,
      reason: null,
      attested: false,
      credential_source: 'dedicated',
    });
    expect(mocks.unsafe).not.toHaveBeenCalled();
  });

  it('attests at production boot even while new authoritative reservations are disabled', async () => {
    mocks.env.ENABLE_AUTHORITATIVE_BUDGET_CONTROL = false;
    await expect(assertBudgetControlRuntimeReadyForProduction()).resolves.toBeUndefined();
    expect(mocks.getBudgetControlSql).toHaveBeenCalledTimes(1);
  });

  it('fails production boot with the feature flag off when the dedicated credential is missing', async () => {
    mocks.env.ENABLE_AUTHORITATIVE_BUDGET_CONTROL = false;
    mocks.getBudgetControlClientMetadata.mockImplementation(() => {
      throw new BudgetControlDatabaseConfigError('missing_url', 'sensitive detail');
    });

    await expect(assertBudgetControlRuntimeReadyForProduction()).rejects.toEqual(
      expect.objectContaining<Partial<BudgetControlRuntimeNotReadyError>>({
        name: 'BudgetControlRuntimeNotReadyError',
        reason: 'credential_missing',
        status: 503,
      }),
    );
    expect(mocks.getBudgetControlSql).not.toHaveBeenCalled();
  });

  it('does not require a production role attestation in local/test processes', async () => {
    mocks.env.NODE_ENV = 'test';
    await expect(assertBudgetControlRuntimeReadyForProduction()).resolves.toBeUndefined();
    expect(mocks.getBudgetControlSql).not.toHaveBeenCalled();
  });
});
