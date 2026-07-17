import { parseMigrationDatabaseEnv } from './migration-database-env.js';

export interface ApplyMigrationEnv {
  databaseUrl: string;
}

export function parseApplyMigrationEnv(
  source: Record<string, string | undefined>,
): ApplyMigrationEnv {
  return { databaseUrl: parseMigrationDatabaseEnv(source).databaseUrl };
}

export function readApplyMigrationEnv(): ApplyMigrationEnv {
  return parseApplyMigrationEnv(process.env);
}
