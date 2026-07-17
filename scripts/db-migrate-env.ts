import * as v from 'valibot';
import { parseMigrationDatabaseEnv } from './migration-database-env.js';

const DbMigrateEnvSchema = v.object({
  MIGRATE_LOCK_TIMEOUT: v.optional(v.pipe(v.string(), v.regex(/^[0-9]+(ms|s|min)?$/))),
});

export interface DbMigrateEnv {
  databaseUrl: string;
  lockTimeout?: string;
}

export function parseDbMigrateEnv(source: Record<string, string | undefined>): DbMigrateEnv {
  const migrationDatabase = parseMigrationDatabaseEnv(source);

  const parsed = v.safeParse(DbMigrateEnvSchema, {
    MIGRATE_LOCK_TIMEOUT: source['MIGRATE_LOCK_TIMEOUT'],
  });

  if (!parsed.success) {
    throw new Error('MIGRATE_LOCK_TIMEOUT must match /^[0-9]+(ms|s|min)?$/');
  }

  if (parsed.output.MIGRATE_LOCK_TIMEOUT === undefined) {
    return { databaseUrl: migrationDatabase.databaseUrl };
  }

  return {
    databaseUrl: migrationDatabase.databaseUrl,
    lockTimeout: parsed.output.MIGRATE_LOCK_TIMEOUT,
  };
}

export function readDbMigrateEnv(): DbMigrateEnv {
  return parseDbMigrateEnv(process.env);
}
