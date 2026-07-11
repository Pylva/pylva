import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensureRlsTestRole, RLS_TEST_USER, rlsDatabaseUrl, rlsTestPassword } from './rls-test-role.js';

const originalPassword = process.env['RLS_TEST_PASSWORD'];

afterEach(() => {
  if (originalPassword === undefined) {
    delete process.env['RLS_TEST_PASSWORD'];
  } else {
    process.env['RLS_TEST_PASSWORD'] = originalPassword;
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

  it('escapes RLS_TEST_PASSWORD before embedding it in role-management SQL', async () => {
    process.env['RLS_TEST_PASSWORD'] = "shared'cluster";
    const unsafe = vi.fn(async () => undefined);
    const sql = { unsafe } as unknown as Parameters<typeof ensureRlsTestRole>[0];

    await ensureRlsTestRole(sql);

    expect(unsafe).toHaveBeenNthCalledWith(1, expect.stringContaining("PASSWORD 'shared''cluster'"));
    expect(unsafe).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("PASSWORD 'shared''cluster' NOBYPASSRLS"),
    );
  });
});
