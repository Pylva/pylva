import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dockerfile = readFileSync('Dockerfile', 'utf8');
const migrateEntrypoint = readFileSync('docker-migrate-entrypoint.sh', 'utf8');

describe('Dockerfile migrations target', () => {
  it('copies the targeted Postgres migration runner into the migration image', () => {
    expect(dockerfile).toContain(
      'COPY scripts/apply-postgres-migration.ts scripts/apply-postgres-migration-env.ts scripts/db-migrate.ts scripts/db-migrate-core.ts scripts/db-migrate-env.ts scripts/migration-database-env.ts scripts/verify-physical-schema-contract.ts ./scripts/',
    );
  });

  it('copies only the migration credential assembler into the migration image', () => {
    const migrationStage = dockerfile.slice(
      dockerfile.indexOf('FROM deps AS migrations'),
      dockerfile.indexOf('FROM node:20-bookworm-slim AS runner'),
    );
    expect(migrationStage).toContain('COPY docker-migration-db-url.sh');
    expect(migrationStage).not.toContain('COPY docker-db-url.sh');
    expect(migrateEntrypoint).toContain('. /app/docker-migration-db-url.sh');
    expect(migrateEntrypoint).not.toContain('. /app/docker-db-url.sh');
  });

  it('defaults the migrations image to db:migrate', () => {
    expect(dockerfile).toContain('CMD ["pnpm", "db:migrate"]');
  });

  it('documents db:migrate as the entrypoint default command', () => {
    expect(migrateEntrypoint).toContain('pnpm db:migrate');
  });
});

describe('Dockerfile optional analytics configuration', () => {
  it('carries opt-in PostHog configuration through the build and runtime images', () => {
    expect(dockerfile.match(/ARG NEXT_PUBLIC_POSTHOG_KEY=/g)).toHaveLength(2);
    expect(dockerfile.match(/ARG NEXT_PUBLIC_POSTHOG_HOST=/g)).toHaveLength(2);
    expect(dockerfile.match(/NEXT_PUBLIC_POSTHOG_KEY=\$NEXT_PUBLIC_POSTHOG_KEY/g)).toHaveLength(2);
    expect(dockerfile.match(/NEXT_PUBLIC_POSTHOG_HOST=\$NEXT_PUBLIC_POSTHOG_HOST/g)).toHaveLength(
      2,
    );
  });

  it('keeps analytics disabled when no PostHog key is supplied', () => {
    expect(dockerfile).toContain('ARG NEXT_PUBLIC_POSTHOG_KEY=');
    expect(dockerfile).not.toMatch(/ARG NEXT_PUBLIC_POSTHOG_KEY=phc_/);
  });
});
