import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  bootstrapAuthoritativeBudgetMigrationRole,
  parseBootstrapMigrationRoleConfig,
  type BootstrapSqlClient,
} from '../../scripts/ci/bootstrap-authoritative-budget-migration-role.js';

const ADMIN_URL = 'postgresql://pylva:pylva_test@localhost:5432/pylva_test';
const MIGRATION_URL =
  'postgresql://pylva_migration_ci:pylva_migration_ci_test@localhost:5432/pylva_test';

function roleRow(
  roleName: 'pylva' | 'pylva_migration_ci',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const admin = roleName === 'pylva';
  return {
    current_user_name: roleName,
    session_user_name: roleName,
    role_name: roleName,
    can_login: true,
    inherits_privileges: true,
    is_superuser: admin,
    can_create_database: true,
    can_create_role: true,
    can_replicate: admin,
    bypasses_rls: admin,
    connection_limit: -1,
    valid_until: admin ? null : 'infinity',
    role_config: null,
    ...overrides,
  };
}

function databaseRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    database_name: 'pylva_test',
    owner_name: 'pylva_migration_ci',
    can_connect: true,
    can_create: true,
    can_create_temporary: true,
    can_use_public_schema: true,
    can_create_in_public_schema: true,
    ...overrides,
  };
}

class FakeClient implements BootstrapSqlClient {
  readonly queries: string[] = [];
  readonly events: string[];
  readonly label: string;
  readonly responses: Array<ReadonlyArray<Record<string, unknown>>>;

  constructor(
    label: string,
    events: string[],
    responses: Array<ReadonlyArray<Record<string, unknown>>>,
  ) {
    this.label = label;
    this.events = events;
    this.responses = [...responses];
  }

  async unsafe(query: string): Promise<ReadonlyArray<Record<string, unknown>>> {
    this.queries.push(query);
    this.events.push(`${this.label}:query:${this.queries.length}`);
    const response = this.responses.shift();
    if (response === undefined) {
      throw new Error('unexpected fake query');
    }
    return response;
  }

  async end(): Promise<void> {
    this.events.push(`${this.label}:end`);
  }
}

function successfulClients(options?: {
  migrationRoleOverrides?: Record<string, unknown>;
  databaseOverrides?: Record<string, unknown>;
  adminAfterOverrides?: Record<string, unknown>;
}): {
  admin: FakeClient;
  migration: FakeClient;
  events: string[];
  factory: (url: string) => BootstrapSqlClient;
} {
  const events: string[] = [];
  const admin = new FakeClient('admin', events, [
    [roleRow('pylva')],
    [],
    [],
    [],
    [],
    [roleRow('pylva', options?.adminAfterOverrides)],
  ]);
  const migration = new FakeClient('migration', events, [
    [roleRow('pylva_migration_ci', options?.migrationRoleOverrides)],
    [databaseRow(options?.databaseOverrides)],
  ]);
  const factory = (url: string): BootstrapSqlClient => {
    events.push(url === ADMIN_URL ? 'factory:admin' : 'factory:migration');
    return url === ADMIN_URL ? admin : migration;
  };
  return { admin, migration, events, factory };
}

describe('authoritative budget CI migration-role bootstrap', () => {
  it('pins separate admin and migration identities on the same target without exposing secrets', () => {
    expect(
      parseBootstrapMigrationRoleConfig({
        CI_POSTGRES_ADMIN_URL: ADMIN_URL,
        MIGRATION_DATABASE_URL: MIGRATION_URL,
      }),
    ).toEqual({
      adminUrl: ADMIN_URL,
      migrationUrl: MIGRATION_URL,
      adminUsername: 'pylva',
      migrationUsername: 'pylva_migration_ci',
      migrationPassword: 'pylva_migration_ci_test',
      database: 'pylva_test',
    });

    for (const [name, adminUrl, migrationUrl] of [
      ['admin password', 'postgresql://pylva@localhost:5432/pylva_test', MIGRATION_URL],
      [
        'migration password',
        ADMIN_URL,
        'postgresql://pylva_migration_ci@localhost:5432/pylva_test',
      ],
      [
        'admin identity',
        'postgresql://other:admin-secret@localhost:5432/pylva_test',
        MIGRATION_URL,
      ],
      [
        'migration identity',
        ADMIN_URL,
        'postgresql://other:migration-secret@localhost:5432/pylva_test',
      ],
      [
        'target host',
        ADMIN_URL,
        'postgresql://pylva_migration_ci:migration-secret@other:5432/pylva_test',
      ],
      [
        'target port',
        ADMIN_URL,
        'postgresql://pylva_migration_ci:migration-secret@localhost:5433/pylva_test',
      ],
      [
        'target database',
        ADMIN_URL,
        'postgresql://pylva_migration_ci:migration-secret@localhost:5432/other',
      ],
    ] as const) {
      expect(() =>
        parseBootstrapMigrationRoleConfig({
          CI_POSTGRES_ADMIN_URL: adminUrl,
          MIGRATION_DATABASE_URL: migrationUrl,
        }),
      ).toThrow();
      try {
        parseBootstrapMigrationRoleConfig({
          CI_POSTGRES_ADMIN_URL: adminUrl,
          MIGRATION_DATABASE_URL: migrationUrl,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message, name).not.toContain('admin-secret');
        expect(message, name).not.toContain('migration-secret');
        expect(message, name).not.toContain('postgresql://');
      }
    }
  });

  it('creates, normalizes, and transfers ownership before strict fresh-login attestation', async () => {
    const { admin, migration, events, factory } = successfulClients();

    await expect(
      bootstrapAuthoritativeBudgetMigrationRole(
        {
          CI_POSTGRES_ADMIN_URL: ADMIN_URL,
          MIGRATION_DATABASE_URL: MIGRATION_URL,
        },
        factory,
      ),
    ).resolves.toBeUndefined();

    expect(admin.queries).toHaveLength(6);
    expect(admin.queries[0]).toContain('FROM pg_catalog.pg_roles');
    expect(admin.queries[1]).toContain('CREATE ROLE "pylva_migration_ci" LOGIN');
    expect(admin.queries[2]).toContain('ALTER ROLE "pylva_migration_ci"');
    expect(admin.queries[2]).toContain('NOSUPERUSER');
    expect(admin.queries[2]).toContain('CREATEDB');
    expect(admin.queries[2]).toContain('CREATEROLE');
    expect(admin.queries[2]).toContain('NOREPLICATION');
    expect(admin.queries[2]).toContain('NOBYPASSRLS');
    expect(admin.queries[2]).toContain("PASSWORD 'pylva_migration_ci_test'");
    expect(admin.queries[3]).toContain('ALTER ROLE "pylva_migration_ci" RESET ALL');
    expect(admin.queries[4]).toContain('ALTER DATABASE "pylva_test" OWNER TO "pylva_migration_ci"');
    expect(admin.queries[5]).toContain('FROM pg_catalog.pg_roles');
    expect(migration.queries[0]).toContain('FROM pg_catalog.pg_roles');
    expect(migration.queries[1]).toContain('pg_catalog.has_database_privilege');
    expect(events).toEqual([
      'factory:admin',
      'admin:query:1',
      'admin:query:2',
      'admin:query:3',
      'admin:query:4',
      'admin:query:5',
      'admin:query:6',
      'admin:end',
      'factory:migration',
      'migration:query:1',
      'migration:query:2',
      'migration:end',
    ]);
  });

  it('is rerunnable after migration 052 creator-admin membership edges exist', async () => {
    const { factory } = successfulClients({
      migrationRoleOverrides: {
        unrelated_memberships: [
          'pylva_budget_projection_discovery_owner',
          'pylva_budget_expiry_discovery_owner',
          'pylva_budget_control_runtime',
        ],
      },
    });

    await expect(
      bootstrapAuthoritativeBudgetMigrationRole(
        {
          CI_POSTGRES_ADMIN_URL: ADMIN_URL,
          MIGRATION_DATABASE_URL: MIGRATION_URL,
        },
        factory,
      ),
    ).resolves.toBeUndefined();
  });

  it('refuses an unsafe admin before any role or ownership mutation', async () => {
    const events: string[] = [];
    const admin = new FakeClient('admin', events, [[roleRow('pylva', { is_superuser: false })]]);

    await expect(
      bootstrapAuthoritativeBudgetMigrationRole(
        {
          CI_POSTGRES_ADMIN_URL: ADMIN_URL,
          MIGRATION_DATABASE_URL: MIGRATION_URL,
        },
        () => admin,
      ),
    ).rejects.toThrow('admin identity or posture is unsafe');
    expect(admin.queries).toHaveLength(1);
    expect(events).toEqual(['admin:query:1', 'admin:end']);
  });

  it('redacts driver failures instead of propagating connection URLs or passwords', async () => {
    const leakingClient: BootstrapSqlClient = {
      unsafe: async () => {
        throw new Error(`connection failed: ${ADMIN_URL} / pylva_migration_ci_test`);
      },
      end: async () => undefined,
    };

    let message = '';
    try {
      await bootstrapAuthoritativeBudgetMigrationRole(
        {
          CI_POSTGRES_ADMIN_URL: ADMIN_URL,
          MIGRATION_DATABASE_URL: MIGRATION_URL,
        },
        () => leakingClient,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe('CI PostgreSQL admin pre-attestation query failed');
    expect(message).not.toContain('postgresql://');
    expect(message).not.toContain('pylva_migration_ci_test');
  });

  it('fails closed if the admin role changes during bootstrap', async () => {
    const { factory } = successfulClients({ adminAfterOverrides: { can_create_role: false } });

    await expect(
      bootstrapAuthoritativeBudgetMigrationRole(
        {
          CI_POSTGRES_ADMIN_URL: ADMIN_URL,
          MIGRATION_DATABASE_URL: MIGRATION_URL,
        },
        factory,
      ),
    ).rejects.toThrow('admin role changed');
  });

  it.each([
    ['LOGIN', { can_login: false }],
    ['INHERIT', { inherits_privileges: false }],
    ['NOSUPERUSER', { is_superuser: true }],
    ['CREATEDB', { can_create_database: false }],
    ['CREATEROLE', { can_create_role: false }],
    ['NOREPLICATION', { can_replicate: true }],
    ['NOBYPASSRLS', { bypasses_rls: true }],
    ['unlimited connections', { connection_limit: 1 }],
    ['non-expiring login', { valid_until: null }],
    ['empty role configuration', { role_config: '{search_path=public}' }],
    ['current identity', { current_user_name: 'pylva' }],
    ['session identity', { session_user_name: 'pylva' }],
  ])('fails closed when migration-role %s attestation drifts', async (_name, overrides) => {
    const { factory } = successfulClients({ migrationRoleOverrides: overrides });

    await expect(
      bootstrapAuthoritativeBudgetMigrationRole(
        {
          CI_POSTGRES_ADMIN_URL: ADMIN_URL,
          MIGRATION_DATABASE_URL: MIGRATION_URL,
        },
        factory,
      ),
    ).rejects.toThrow('strict attribute attestation');
  });

  it.each([
    ['owner', { owner_name: 'pylva' }],
    ['database', { database_name: 'other' }],
    ['CONNECT', { can_connect: false }],
    ['CREATE', { can_create: false }],
    ['TEMP', { can_create_temporary: false }],
    ['public USAGE', { can_use_public_schema: false }],
    ['public CREATE', { can_create_in_public_schema: false }],
  ])('fails closed when migration database %s attestation drifts', async (_name, overrides) => {
    const { factory } = successfulClients({ databaseOverrides: overrides });

    await expect(
      bootstrapAuthoritativeBudgetMigrationRole(
        {
          CI_POSTGRES_ADMIN_URL: ADMIN_URL,
          MIGRATION_DATABASE_URL: MIGRATION_URL,
        },
        factory,
      ),
    ).rejects.toThrow('database-owner attestation');
  });

  it('keeps the success marker after the awaited bootstrap and never prints database URLs', () => {
    const source = readFileSync(
      'scripts/ci/bootstrap-authoritative-budget-migration-role.ts',
      'utf8',
    );
    const awaitIndex = source.indexOf(
      'await bootstrapAuthoritativeBudgetMigrationRole(process.env);',
    );
    const markerIndex = source.indexOf('AUTHORITATIVE_BUDGET_MIGRATION_ROLE_BOOTSTRAPPED');

    expect(awaitIndex).toBeGreaterThan(-1);
    expect(markerIndex).toBeGreaterThan(awaitIndex);
    expect(source).not.toContain('console.log(config');
    expect(source).not.toContain('process.stdout.write(config');
    expect(source).not.toContain('process.stderr.write(config');
  });
});
