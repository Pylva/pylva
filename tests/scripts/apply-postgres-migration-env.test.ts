import { describe, expect, it } from 'vitest';
import { parseApplyMigrationEnv } from '../../scripts/apply-postgres-migration-env.js';

describe('parseApplyMigrationEnv', () => {
  it('accepts a non-empty DATABASE_URL', () => {
    expect(
      parseApplyMigrationEnv({
        DATABASE_URL: 'postgresql://operator.example/pylva',
      }),
    ).toEqual({
      databaseUrl: 'postgresql://operator.example/pylva',
    });
  });

  it('rejects missing or empty DATABASE_URL', () => {
    expect(() => parseApplyMigrationEnv({})).toThrow(
      /DATABASE_URL environment variable is required/,
    );
    expect(() => parseApplyMigrationEnv({ DATABASE_URL: '' })).toThrow(
      /DATABASE_URL environment variable is required/,
    );
  });
});
