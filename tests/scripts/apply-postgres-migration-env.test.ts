import { describe, expect, it } from 'vitest';
import { parseApplyMigrationEnv } from '../../scripts/apply-postgres-migration-env.js';

describe('parseApplyMigrationEnv', () => {
  it('accepts a non-empty MIGRATION_DATABASE_URL', () => {
    expect(
      parseApplyMigrationEnv({
        MIGRATION_DATABASE_URL: 'postgresql://operator.example/pylva',
      }),
    ).toEqual({
      databaseUrl: 'postgresql://operator.example/pylva',
    });
  });

  it('rejects missing or empty migration credentials without an explicit fallback', () => {
    expect(() => parseApplyMigrationEnv({})).toThrow(/MIGRATION_DATABASE_URL is required/);
    expect(() => parseApplyMigrationEnv({ MIGRATION_DATABASE_URL: '' })).toThrow(
      /MIGRATION_DATABASE_URL is required/,
    );
  });
});
