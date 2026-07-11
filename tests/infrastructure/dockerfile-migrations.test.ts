import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dockerfile = readFileSync('Dockerfile', 'utf8');
const migrateEntrypoint = readFileSync('docker-migrate-entrypoint.sh', 'utf8');

describe('Dockerfile migrations target', () => {
  it('copies the targeted Postgres migration runner into the migration image', () => {
    expect(dockerfile).toContain(
      'COPY scripts/apply-postgres-migration.ts scripts/apply-postgres-migration-env.ts scripts/db-migrate.ts scripts/db-migrate-core.ts scripts/db-migrate-env.ts ./scripts/',
    );
  });

  it('defaults the migrations image to db:migrate', () => {
    expect(dockerfile).toContain('CMD ["pnpm", "db:migrate"]');
  });

  it('documents db:migrate as the entrypoint default command', () => {
    expect(migrateEntrypoint).toContain('pnpm db:migrate');
  });
});
