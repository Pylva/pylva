export const LOCAL_MIGRATION_FALLBACK_ENV = 'ALLOW_MIGRATION_DATABASE_URL_FALLBACK' as const;

export type MigrationDatabaseSource = 'migration' | 'local_ci_fallback';

export interface MigrationDatabaseEnv {
  databaseUrl: string;
  source: MigrationDatabaseSource;
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve the credential used by schema-changing tools.
 *
 * Production never accepts DATABASE_URL: the migration task must receive its
 * own MIGRATION_DATABASE_URL (normally assembled from MIGRATION_DB_* by the
 * container entrypoint). Local and CI callers may deliberately reuse their
 * throwaway DATABASE_URL, but only through the explicit opt-in flag.
 */
export function parseMigrationDatabaseEnv(
  source: Record<string, string | undefined>,
): MigrationDatabaseEnv {
  const migrationDatabaseUrl = nonBlank(source['MIGRATION_DATABASE_URL']);
  const runtimeDatabaseUrl = nonBlank(source['DATABASE_URL']);
  const production = source['NODE_ENV'] === 'production';
  const allowLocalFallback = source[LOCAL_MIGRATION_FALLBACK_ENV] === 'true';

  if (production) {
    if (runtimeDatabaseUrl !== undefined) {
      throw new Error(
        'DATABASE_URL must not be injected into a production migration task; use MIGRATION_DATABASE_URL only',
      );
    }
    if (migrationDatabaseUrl === undefined) {
      throw new Error('MIGRATION_DATABASE_URL is required in production');
    }
    return { databaseUrl: migrationDatabaseUrl, source: 'migration' };
  }

  if (migrationDatabaseUrl !== undefined) {
    if (runtimeDatabaseUrl === migrationDatabaseUrl && !allowLocalFallback) {
      throw new Error(
        `MIGRATION_DATABASE_URL must not reuse DATABASE_URL unless ${LOCAL_MIGRATION_FALLBACK_ENV}=true outside production`,
      );
    }
    return { databaseUrl: migrationDatabaseUrl, source: 'migration' };
  }

  if (allowLocalFallback && runtimeDatabaseUrl !== undefined) {
    return { databaseUrl: runtimeDatabaseUrl, source: 'local_ci_fallback' };
  }

  throw new Error(
    `MIGRATION_DATABASE_URL is required; local/CI may explicitly set ${LOCAL_MIGRATION_FALLBACK_ENV}=true to reuse DATABASE_URL`,
  );
}
