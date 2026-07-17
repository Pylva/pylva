import { describe, expect, it } from 'vitest';
import {
  LOCAL_MIGRATION_FALLBACK_ENV,
  parseMigrationDatabaseEnv,
} from '../../scripts/migration-database-env.js';

const RUNTIME_URL = 'postgresql://runtime:runtime-pass@db.example/pylva';
const MIGRATION_URL = 'postgresql://migration:migration-pass@db.example/pylva';

describe('parseMigrationDatabaseEnv', () => {
  it('uses the dedicated migration URL', () => {
    expect(parseMigrationDatabaseEnv({ MIGRATION_DATABASE_URL: MIGRATION_URL })).toEqual({
      databaseUrl: MIGRATION_URL,
      source: 'migration',
    });
  });

  it('allows a deliberate local/CI DATABASE_URL fallback only with the exact opt-in', () => {
    expect(
      parseMigrationDatabaseEnv({
        DATABASE_URL: RUNTIME_URL,
        NODE_ENV: 'test',
        [LOCAL_MIGRATION_FALLBACK_ENV]: 'true',
      }),
    ).toEqual({ databaseUrl: RUNTIME_URL, source: 'local_ci_fallback' });

    expect(() =>
      parseMigrationDatabaseEnv({ DATABASE_URL: RUNTIME_URL, NODE_ENV: 'test' }),
    ).toThrow(LOCAL_MIGRATION_FALLBACK_ENV);
  });

  it('rejects shared URLs outside production unless the local/CI reuse is explicit', () => {
    expect(() =>
      parseMigrationDatabaseEnv({
        DATABASE_URL: RUNTIME_URL,
        MIGRATION_DATABASE_URL: RUNTIME_URL,
        NODE_ENV: 'test',
      }),
    ).toThrow('must not reuse DATABASE_URL');
  });

  it('never accepts DATABASE_URL in a production migration task', () => {
    expect(() =>
      parseMigrationDatabaseEnv({
        DATABASE_URL: RUNTIME_URL,
        MIGRATION_DATABASE_URL: MIGRATION_URL,
        NODE_ENV: 'production',
      }),
    ).toThrow('must not be injected');

    expect(() =>
      parseMigrationDatabaseEnv({
        DATABASE_URL: RUNTIME_URL,
        NODE_ENV: 'production',
        [LOCAL_MIGRATION_FALLBACK_ENV]: 'true',
      }),
    ).toThrow('must not be injected');
  });

  it('requires the dedicated URL in production', () => {
    expect(() => parseMigrationDatabaseEnv({ NODE_ENV: 'production' })).toThrow(
      'MIGRATION_DATABASE_URL is required in production',
    );
  });
});
