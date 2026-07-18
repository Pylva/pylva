import { describe, expect, it } from 'vitest';
import {
  BudgetControlDatabaseConfigError,
  LOCAL_BUDGET_CONTROL_FALLBACK_ENV,
  resolveBudgetControlDatabaseConfig,
  sameDatabasePrincipal,
} from '../../src/lib/budget-control/database-config.js';

const GENERAL_URL = 'postgresql://app:app-password@db.example:5432/pylva';
const BUDGET_URL = 'postgresql://budget:budget-password@db.example:5432/pylva';
const MIGRATION_URL = 'postgresql://owner:owner-password@db.example:5432/pylva';

describe('budget-control database configuration', () => {
  it('resolves a distinct dedicated production login', () => {
    expect(
      resolveBudgetControlDatabaseConfig({
        NODE_ENV: 'production',
        DATABASE_URL: GENERAL_URL,
        BUDGET_CONTROL_DATABASE_URL: BUDGET_URL,
      }),
    ).toEqual({
      databaseUrl: BUDGET_URL,
      expectedUsername: 'budget',
      source: 'dedicated',
    });
  });

  it('requires the dedicated URL in production even when DATABASE_URL exists', () => {
    expect(() =>
      resolveBudgetControlDatabaseConfig({ NODE_ENV: 'production', DATABASE_URL: GENERAL_URL }),
    ).toThrow('BUDGET_CONTROL_DATABASE_URL is required in production');
  });

  it('permits general DB reuse only through the explicit non-production flag', () => {
    expect(
      resolveBudgetControlDatabaseConfig({
        NODE_ENV: 'test',
        DATABASE_URL: GENERAL_URL,
        [LOCAL_BUDGET_CONTROL_FALLBACK_ENV]: 'true',
      }),
    ).toMatchObject({
      databaseUrl: GENERAL_URL,
      expectedUsername: 'app',
      source: 'local_ci_fallback',
    });
    expect(() =>
      resolveBudgetControlDatabaseConfig({ NODE_ENV: 'test', DATABASE_URL: GENERAL_URL }),
    ).toThrow(LOCAL_BUDGET_CONTROL_FALLBACK_ENV);
  });

  it('compares cluster-wide principals independently of password, URL, and host aliases', () => {
    expect(
      sameDatabasePrincipal(
        'postgres://budget:old@DB.EXAMPLE/pylva',
        'postgresql://budget:new@db.example:5432/pylva',
      ),
    ).toBe(true);
    expect(
      sameDatabasePrincipal(
        'postgresql://budget:one@db.example/application',
        'postgresql://budget:two@db.example/budget_control',
      ),
    ).toBe(true);
    expect(
      sameDatabasePrincipal(
        'postgresql://budget:one@writer.db.example/application',
        'postgresql://budget:two@cluster-alias.internal/budget_control',
      ),
    ).toBe(true);
    expect(
      sameDatabasePrincipal(
        'postgresql://budget:one@db.example/application',
        'postgresql://budget:two@db.example,failover.example/budget_control',
      ),
    ).toBe(true);
    expect(sameDatabasePrincipal(BUDGET_URL, GENERAL_URL)).toBe(false);
  });

  it('rejects production reuse of the general login even with a different password', () => {
    expect(() =>
      resolveBudgetControlDatabaseConfig({
        NODE_ENV: 'production',
        DATABASE_URL: GENERAL_URL,
        BUDGET_CONTROL_DATABASE_URL: 'postgresql://app:a-rotated-password@db.example:5432/pylva',
      }),
    ).toThrow('login distinct from DATABASE_URL');

    expect(() =>
      resolveBudgetControlDatabaseConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://shared:app@db.example:5432/application',
        BUDGET_CONTROL_DATABASE_URL: 'postgresql://shared:budget@db.example:5432/budget_control',
      }),
    ).toThrow('login distinct from DATABASE_URL');
  });

  it('rejects every migration credential form from the production runtime', () => {
    for (const [name, value] of [
      ['MIGRATION_DATABASE_URL', MIGRATION_URL],
      ['MIGRATION_DB_HOST', 'db.example'],
      ['MIGRATION_DB_PORT', '5432'],
      ['MIGRATION_DB_NAME', 'pylva'],
      ['MIGRATION_DB_SSLMODE', 'require'],
      ['MIGRATION_DB_USERNAME', 'owner'],
      ['MIGRATION_DB_PASSWORD', 'owner-password'],
      ['MIGRATION_DB_MASTER_USER_SECRET_ARN', 'arn:test:migration-master'],
      ['MIGRATION_DB_RUNTIME_USER_SECRET_ARN', 'arn:test:migration-runtime'],
      ['MIGRATION_DATABASE_SECRET_ARN', 'arn:test:migration'],
    ] as const) {
      expect(() =>
        resolveBudgetControlDatabaseConfig({
          NODE_ENV: 'production',
          DATABASE_URL: GENERAL_URL,
          BUDGET_CONTROL_DATABASE_URL: BUDGET_URL,
          [name]: value,
        }),
      ).toThrow('must never be injected');
    }
  });

  it('rejects migration principal reuse outside production', () => {
    expect(() =>
      resolveBudgetControlDatabaseConfig({
        NODE_ENV: 'test',
        BUDGET_CONTROL_DATABASE_URL: MIGRATION_URL,
        MIGRATION_DATABASE_URL: MIGRATION_URL,
      }),
    ).toThrow('distinct from MIGRATION_DATABASE_URL');
  });

  it('rejects reuse of the general or migration secret ARN', () => {
    for (const privilegedSecretName of [
      'DB_MASTER_USER_SECRET_ARN',
      'DB_RUNTIME_USER_SECRET_ARN',
      'MIGRATION_DB_MASTER_USER_SECRET_ARN',
      'MIGRATION_DB_RUNTIME_USER_SECRET_ARN',
      'MIGRATION_DATABASE_SECRET_ARN',
    ]) {
      expect(() =>
        resolveBudgetControlDatabaseConfig({
          NODE_ENV: privilegedSecretName.startsWith('MIGRATION_') ? 'test' : 'production',
          DATABASE_URL: GENERAL_URL,
          BUDGET_CONTROL_DATABASE_URL: BUDGET_URL,
          BUDGET_CONTROL_DB_RUNTIME_USER_SECRET_ARN: 'arn:test:shared',
          [privilegedSecretName]: 'arn:test:shared',
        }),
      ).toThrow('must not reuse');
    }
  });

  it('rejects invalid or anonymous URLs with a typed safe error', () => {
    for (const candidate of ['https://budget@db.example/pylva', 'postgresql://db.example/pylva']) {
      try {
        resolveBudgetControlDatabaseConfig({ BUDGET_CONTROL_DATABASE_URL: candidate });
      } catch (error) {
        expect(error).toBeInstanceOf(BudgetControlDatabaseConfigError);
        expect((error as BudgetControlDatabaseConfigError).code).toBe('invalid_url');
        continue;
      }
      throw new Error('expected invalid URL to be rejected');
    }
  });
});
