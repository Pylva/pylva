import * as v from 'valibot';

const ApplyMigrationEnvSchema = v.object({
  DATABASE_URL: v.pipe(v.string(), v.minLength(1)),
});

export interface ApplyMigrationEnv {
  databaseUrl: string;
}

export function parseApplyMigrationEnv(
  source: Record<string, string | undefined>,
): ApplyMigrationEnv {
  const parsed = v.safeParse(ApplyMigrationEnvSchema, {
    DATABASE_URL: source['DATABASE_URL'],
  });

  if (!parsed.success) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  return { databaseUrl: parsed.output.DATABASE_URL };
}

export function readApplyMigrationEnv(): ApplyMigrationEnv {
  return parseApplyMigrationEnv(process.env);
}
