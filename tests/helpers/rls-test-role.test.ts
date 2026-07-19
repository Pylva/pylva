import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureRlsTestRole,
  RLS_TEST_USER,
  rlsDatabaseUrl,
  rlsTestPassword,
} from './rls-test-role.js';

const originalPassword = process.env['RLS_TEST_PASSWORD'];
const originalCiUrl = process.env['PYLVA_RLS_TEST_DATABASE_URL'];

beforeEach(() => {
  delete process.env['PYLVA_RLS_TEST_DATABASE_URL'];
});

afterEach(() => {
  if (originalPassword === undefined) {
    delete process.env['RLS_TEST_PASSWORD'];
  } else {
    process.env['RLS_TEST_PASSWORD'] = originalPassword;
  }
  if (originalCiUrl === undefined) {
    delete process.env['PYLVA_RLS_TEST_DATABASE_URL'];
  } else {
    process.env['PYLVA_RLS_TEST_DATABASE_URL'] = originalCiUrl;
  }
  vi.restoreAllMocks();
});

describe('rls test role credentials', () => {
  it('uses the safe local default when RLS_TEST_PASSWORD is unset', () => {
    delete process.env['RLS_TEST_PASSWORD'];

    const url = new URL(rlsDatabaseUrl('postgresql://app:secret@localhost:5432/pylva'));

    expect(rlsTestPassword()).toBe('pylva_rls_test');
    expect(url.username).toBe(RLS_TEST_USER);
    expect(url.password).toBe('pylva_rls_test');
  });

  it('uses RLS_TEST_PASSWORD when building RLS-scoped database URLs', () => {
    process.env['RLS_TEST_PASSWORD'] = 'shared-dev-cluster-password';

    const url = new URL(rlsDatabaseUrl('postgresql://app:secret@localhost:5432/pylva'));

    expect(rlsTestPassword()).toBe('shared-dev-cluster-password');
    expect(url.username).toBe(RLS_TEST_USER);
    expect(url.password).toBe('shared-dev-cluster-password');
  });

  it('uses the separately provisioned CI login only for its exact database target', () => {
    process.env['PYLVA_RLS_TEST_DATABASE_URL'] =
      'postgresql://pylva_rls_test:isolated@db.example:5432/pylva_test';

    expect(rlsDatabaseUrl('postgresql://pylva_app_ci:app@db.example:5432/pylva_test')).toBe(
      'postgresql://pylva_rls_test:isolated@db.example:5432/pylva_test',
    );

    const scratch = new URL(
      rlsDatabaseUrl('postgresql://scratch:secret@db.example:5432/scratch_db'),
    );
    expect(scratch.pathname).toBe('/scratch_db');
    expect(scratch.username).toBe(RLS_TEST_USER);
    expect(scratch.password).toBe('isolated');
  });

  it('validates the pre-provisioned role only after confirming the exact CI database', async () => {
    process.env['PYLVA_RLS_TEST_DATABASE_URL'] =
      'postgresql://pylva_rls_test:isolated@db.example:5432/pylva_test';
    const unsafe = vi
      .fn()
      .mockResolvedValueOnce([{ database: 'pylva_test' }])
      .mockResolvedValueOnce([
        {
          authority_denied: true,
          memberships_safe: true,
          ordinary_access_ready: true,
          role_safe: true,
        },
      ]);
    const sql = { unsafe } as unknown as Parameters<typeof ensureRlsTestRole>[0];

    await ensureRlsTestRole(sql);

    expect(unsafe).toHaveBeenCalledTimes(2);
    expect(unsafe.mock.calls[0]?.[0]).toContain('current_database() AS database');
    expect(unsafe.mock.calls[1]?.[0]).toContain('has_table_privilege');
  });

  it('does not inspect later-migration tables while provisioning a scratch database', async () => {
    process.env['PYLVA_RLS_TEST_DATABASE_URL'] =
      'postgresql://pylva_rls_test:isolated@db.example:5432/pylva_test';
    const unsafe = vi.fn().mockResolvedValueOnce([{ database: 'scratch_db' }]);
    const sql = { unsafe } as unknown as Parameters<typeof ensureRlsTestRole>[0];

    await ensureRlsTestRole(sql);

    expect(unsafe.mock.calls[0]?.[0]).toContain('current_database() AS database');
    expect(unsafe.mock.calls.some(([statement]) => statement.includes('has_table_privilege'))).toBe(
      false,
    );
    expect(unsafe.mock.calls.some(([statement]) => statement.includes('CREATE ROLE'))).toBe(true);
  });

  it('escapes RLS_TEST_PASSWORD before embedding it in role-management SQL', async () => {
    process.env['RLS_TEST_PASSWORD'] = "shared'cluster";
    const unsafe = vi.fn(async () => undefined);
    const sql = { unsafe } as unknown as Parameters<typeof ensureRlsTestRole>[0];

    await ensureRlsTestRole(sql);

    expect(unsafe).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("PASSWORD 'shared''cluster'"),
    );
    expect(unsafe).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("PASSWORD 'shared''cluster' NOBYPASSRLS"),
    );
  });
});
