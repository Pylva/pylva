import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dockerfile = readFileSync('Dockerfile', 'utf8');
const runtimeEntrypoint = readFileSync('docker-entrypoint.sh', 'utf8');

function runShell(command: string, env: Record<string, string>): ReturnType<typeof spawnSync> {
  return spawnSync('/bin/sh', ['-eu', '-c', command], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', NODE_ENV: 'test', ...env },
  });
}

describe('database credential shell isolation', () => {
  it('assembles a production migration URL only from MIGRATION_DB_*', () => {
    const result = runShell('. ./docker-migration-db-url.sh; printf %s "$MIGRATION_DATABASE_URL"', {
      NODE_ENV: 'production',
      MIGRATION_DB_HOST: 'db.internal',
      MIGRATION_DB_NAME: 'pylva',
      MIGRATION_DB_USERNAME: 'migration owner',
      MIGRATION_DB_PASSWORD: 'safe test password',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      'postgresql://migration%20owner:safe%20test%20password@db.internal:5432/pylva?sslmode=require',
    );
  });

  it('rejects mixing a migration URL with any migration URL part', () => {
    for (const [name, value] of [
      ['MIGRATION_DB_HOST', 'db.internal'],
      ['MIGRATION_DB_PORT', '5432'],
      ['MIGRATION_DB_NAME', 'pylva'],
      ['MIGRATION_DB_SSLMODE', 'require'],
      ['MIGRATION_DB_USERNAME', 'owner'],
      ['MIGRATION_DB_PASSWORD', 'test-only'],
    ] as const) {
      const result = runShell('. ./docker-migration-db-url.sh', {
        MIGRATION_DATABASE_URL: 'postgresql://migration@db/pylva',
        [name]: value,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('not both');
    }
  });

  it('rejects general or budget-control credentials in the production migration task', () => {
    for (const [name, value] of [
      ['DATABASE_URL', 'postgresql://runtime@db/pylva'],
      ['DB_HOST', 'runtime-db.internal'],
      ['DB_PORT', '5432'],
      ['DB_NAME', 'pylva'],
      ['DB_USERNAME', 'runtime'],
      ['DB_PASSWORD', 'test-only'],
      ['DB_MASTER_USER_SECRET_ARN', 'arn:test:general-master'],
      ['BUDGET_CONTROL_DATABASE_URL', 'postgresql://budget@db/pylva'],
      ['BUDGET_CONTROL_DB_RUNTIME_USER_SECRET_ARN', 'arn:test:budget'],
    ] as const) {
      const result = runShell('. ./docker-migration-db-url.sh', {
        NODE_ENV: 'production',
        MIGRATION_DATABASE_URL: 'postgresql://migration@db/pylva',
        [name]: value,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('received runtime database credentials');
    }
  });

  it('rejects migration credentials and exact credential reuse in the runtime guard', () => {
    for (const [name, value] of [
      ['MIGRATION_DATABASE_URL', 'postgresql://migration@db/pylva'],
      ['MIGRATION_DB_HOST', 'db.internal'],
      ['MIGRATION_DB_PORT', '5432'],
      ['MIGRATION_DB_NAME', 'pylva'],
      ['MIGRATION_DB_SSLMODE', 'require'],
      ['MIGRATION_DB_USERNAME', 'owner'],
      ['MIGRATION_DB_PASSWORD', 'test-only'],
      ['MIGRATION_DB_MASTER_USER_SECRET_ARN', 'arn:test:migration-master'],
      ['MIGRATION_DB_RUNTIME_USER_SECRET_ARN', 'arn:test:migration-runtime'],
      ['MIGRATION_DATABASE_SECRET_ARN', 'arn:test:migration'],
    ] as const) {
      const migrationLeak = runShell(
        '. ./docker-runtime-db-guard.sh; assert_runtime_database_isolation',
        { [name]: value },
      );
      expect(migrationLeak.status).not.toBe(0);
      expect(migrationLeak.stderr).toContain('must never be injected');
    }

    const urlReuse = runShell('. ./docker-runtime-db-guard.sh; assert_runtime_database_isolation', {
      DATABASE_URL: 'postgresql://shared@db/pylva',
      BUDGET_CONTROL_DATABASE_URL: 'postgresql://shared@db/pylva',
    });
    expect(urlReuse.status).not.toBe(0);
    expect(urlReuse.stderr).toContain('must not reuse DATABASE_URL');

    const secretReuse = runShell(
      '. ./docker-runtime-db-guard.sh; assert_runtime_database_isolation',
      {
        DB_MASTER_USER_SECRET_ARN: 'arn:test:master',
        BUDGET_CONTROL_DB_RUNTIME_USER_SECRET_ARN: 'arn:test:master',
      },
    );
    expect(secretReuse.status).not.toBe(0);
    expect(secretReuse.stderr).toContain('must not reuse');

    const clickhouseReuse = runShell(
      '. ./docker-runtime-db-guard.sh; assert_runtime_database_isolation',
      {
        CLICKHOUSE_URL: 'http://reader:password@clickhouse:8123',
        BUDGET_PROJECTION_CLICKHOUSE_URL: 'http://reader:password@clickhouse:8123',
      },
    );
    expect(clickhouseReuse.status).not.toBe(0);
    expect(clickhouseReuse.stderr).toContain('must not reuse CLICKHOUSE_URL');
  });

  it('keeps migration helpers out of the Next.js runner image and guards before startup', () => {
    const runnerStage = dockerfile.slice(dockerfile.indexOf('AS runner'));
    expect(runnerStage).toContain('docker-runtime-db-guard.sh');
    expect(runnerStage).not.toContain('docker-migration-db-url.sh');
    expect(runtimeEntrypoint.indexOf('assert_runtime_database_isolation')).toBeLessThan(
      runtimeEntrypoint.indexOf('JWT_KEY_DIR='),
    );
  });
});
