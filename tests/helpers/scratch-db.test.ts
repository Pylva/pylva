import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const postgresMock = vi.hoisted(() => vi.fn());

vi.mock('postgres', () => ({
  default: postgresMock,
}));

import {
  createFreshInstallScratchDb,
  createScratchDb,
  FRESH_INSTALL_SCRATCH_BOOTSTRAP_GUIDANCE,
  resolveScratchDatabaseAdminUrl,
  TEST_DATABASE_ADMIN_URL_ENV,
} from './scratch-db.js';

const ORIGINAL_DATABASE_URL = process.env['DATABASE_URL'];
const ORIGINAL_TEST_DATABASE_ADMIN_URL = process.env[TEST_DATABASE_ADMIN_URL_ENV];

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function fakeClient(rows?: ReadonlyArray<Record<string, unknown>>) {
  return {
    unsafe: vi.fn(async (_query: string) => rows),
    end: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  postgresMock.mockReset();
  delete process.env[TEST_DATABASE_ADMIN_URL_ENV];
  delete process.env['DATABASE_URL'];
});

afterEach(() => {
  restoreEnvironment('DATABASE_URL', ORIGINAL_DATABASE_URL);
  restoreEnvironment(TEST_DATABASE_ADMIN_URL_ENV, ORIGINAL_TEST_DATABASE_ADMIN_URL);
});

describe('resolveScratchDatabaseAdminUrl', () => {
  it('prefers the test-only admin URL over the application DATABASE_URL', () => {
    expect(
      resolveScratchDatabaseAdminUrl({
        NODE_ENV: 'test',
        [TEST_DATABASE_ADMIN_URL_ENV]: 'postgresql://migration:secret@db.example/pylva',
        DATABASE_URL: 'postgresql://app:secret@db.example/pylva',
      }),
    ).toBe('postgresql://migration:secret@db.example/pylva');
  });

  it('falls back to DATABASE_URL when the test-only admin URL is absent or blank', () => {
    expect(
      resolveScratchDatabaseAdminUrl({
        NODE_ENV: 'test',
        [TEST_DATABASE_ADMIN_URL_ENV]: '  ',
        DATABASE_URL: 'postgresql://app:secret@db.example/pylva',
      }),
    ).toBe('postgresql://app:secret@db.example/pylva');
  });
});

describe('createScratchDb', () => {
  it('uses the admin URL to create, connect to, and drop the scratch database', async () => {
    const adminUrl = 'postgresql://migration:secret@db.example:5432/pylva_admin?sslmode=require';
    process.env[TEST_DATABASE_ADMIN_URL_ENV] = adminUrl;
    process.env['DATABASE_URL'] =
      'postgresql://general_app:secret@db.example:5432/pylva?sslmode=require';

    const createClient = fakeClient();
    const scratchClient = fakeClient();
    const dropClient = fakeClient();
    postgresMock
      .mockReturnValueOnce(createClient)
      .mockReturnValueOnce(scratchClient)
      .mockReturnValueOnce(dropClient);

    const scratch = await createScratchDb({ prefix: 'admin boundary' });

    expect(scratch.name).toMatch(/^admin_boundary_[a-f0-9]{12}$/);
    expect(scratch.url).toBe(adminUrl.replace('/pylva_admin?', `/${scratch.name}?`));
    expect(postgresMock).toHaveBeenNthCalledWith(1, adminUrl, {
      max: 1,
      onnotice: expect.any(Function),
    });
    expect(postgresMock).toHaveBeenNthCalledWith(2, scratch.url, {
      max: 1,
      onnotice: expect.any(Function),
    });
    expect(createClient.unsafe).toHaveBeenCalledWith(`CREATE DATABASE "${scratch.name}"`);
    expect(createClient.end).toHaveBeenCalledTimes(1);

    await scratch.drop();

    expect(scratchClient.end).toHaveBeenCalledTimes(1);
    expect(postgresMock).toHaveBeenNthCalledWith(3, adminUrl, {
      max: 1,
      onnotice: expect.any(Function),
    });
    expect(dropClient.unsafe).toHaveBeenCalledWith(
      `DROP DATABASE IF EXISTS "${scratch.name}" WITH (FORCE)`,
    );
    expect(dropClient.end).toHaveBeenCalledTimes(1);
  });
});

describe('createFreshInstallScratchDb', () => {
  const safePosture = {
    current_user_name: 'pylva_migration_ci',
    session_user_name: 'pylva_migration_ci',
    can_login: true,
    inherits_privileges: true,
    can_create_database: true,
    can_create_role: true,
    is_superuser: false,
    bypasses_rls: false,
    can_replicate: false,
    owns_current_database: true,
  };

  it('attests the fixed scoped migrator and keeps cleanup database-scoped', async () => {
    process.env[TEST_DATABASE_ADMIN_URL_ENV] =
      'postgresql://pylva_migration_ci:secret@db.example:5432/postgres';
    const createClient = fakeClient();
    const scratchClient = fakeClient([safePosture]);
    const dropClient = fakeClient();
    postgresMock
      .mockReturnValueOnce(createClient)
      .mockReturnValueOnce(scratchClient)
      .mockReturnValueOnce(dropClient);

    const scratch = await createFreshInstallScratchDb({ prefix: 'fresh owner' });

    expect(scratchClient.unsafe).toHaveBeenCalledWith(
      expect.stringContaining('FROM pg_catalog.pg_roles AS role'),
    );
    await scratch.drop();
    expect(dropClient.unsafe).toHaveBeenCalledWith(
      expect.stringContaining(`DROP DATABASE IF EXISTS "${scratch.name}"`),
    );
    expect(
      dropClient.unsafe.mock.calls.some(([query]) => String(query).includes('DROP ROLE')),
    ).toBe(false);
  });

  it('drops the disposable database and emits exact bootstrap guidance for an unsafe owner', async () => {
    process.env[TEST_DATABASE_ADMIN_URL_ENV] =
      'postgresql://pylva:secret@db.example:5432/postgres';
    const createClient = fakeClient();
    const scratchClient = fakeClient([
      {
        ...safePosture,
        current_user_name: 'pylva',
        session_user_name: 'pylva',
        is_superuser: true,
      },
    ]);
    const dropClient = fakeClient();
    postgresMock
      .mockReturnValueOnce(createClient)
      .mockReturnValueOnce(scratchClient)
      .mockReturnValueOnce(dropClient);

    await expect(
      createFreshInstallScratchDb({ prefix: 'unsafe owner' }),
    ).rejects.toThrow(FRESH_INSTALL_SCRATCH_BOOTSTRAP_GUIDANCE);
    expect(scratchClient.end).toHaveBeenCalledTimes(1);
    expect(dropClient.unsafe).toHaveBeenCalledWith(
      expect.stringContaining('DROP DATABASE IF EXISTS "unsafe_owner_'),
    );
  });
});
