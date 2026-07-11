import * as v from 'valibot';

const DbMigrateEnvSchema = v.object({
  DATABASE_URL: v.pipe(v.string(), v.minLength(1)),
  MIGRATE_LOCK_TIMEOUT: v.optional(v.pipe(v.string(), v.regex(/^[0-9]+(ms|s|min)?$/))),
});

export interface DbMigrateEnv {
  databaseUrl: string;
  lockTimeout?: string;
}

export function parseDbMigrateEnv(source: Record<string, string | undefined>): DbMigrateEnv {
  if (!source['DATABASE_URL']) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  const parsed = v.safeParse(DbMigrateEnvSchema, {
    DATABASE_URL: source['DATABASE_URL'],
    MIGRATE_LOCK_TIMEOUT: source['MIGRATE_LOCK_TIMEOUT'],
  });

  if (!parsed.success) {
    throw new Error('MIGRATE_LOCK_TIMEOUT must match /^[0-9]+(ms|s|min)?$/');
  }

  if (parsed.output.MIGRATE_LOCK_TIMEOUT === undefined) {
    return { databaseUrl: parsed.output.DATABASE_URL };
  }

  return {
    databaseUrl: parsed.output.DATABASE_URL,
    lockTimeout: parsed.output.MIGRATE_LOCK_TIMEOUT,
  };
}

export function readDbMigrateEnv(): DbMigrateEnv {
  return parseDbMigrateEnv(process.env);
}
