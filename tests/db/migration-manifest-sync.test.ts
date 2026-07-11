import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXPECTED_MIGRATIONS, EXPECTED_SCHEMA_HEAD } from '../../src/lib/db/migration-manifest.js';
import {
  buildMigrationManifest,
  renderMigrationManifestModule,
  type MigrationManifest,
} from '../../scripts/generate-migration-manifest.js';
import { computeChecksum } from '../../scripts/db-migrate-core.js';

const REPO_ROOT = path.resolve(__dirname, '../..');
const MANIFEST_PATH = path.resolve(REPO_ROOT, 'src/lib/db/migration-manifest.ts');
const MIGRATIONS_DIR = path.resolve(REPO_ROOT, 'db/migrations');
const STALE_MESSAGE = 'Migration manifest is stale; run pnpm db:manifest.';

function checkedInManifest(): MigrationManifest {
  return {
    entries: EXPECTED_MIGRATIONS.map((entry) => ({
      filename: entry.filename,
      sha256: entry.sha256,
    })),
    head: EXPECTED_SCHEMA_HEAD,
  };
}

describe('migration manifest sync', () => {
  it('matches the live migration files', async () => {
    const liveManifest = await buildMigrationManifest(REPO_ROOT);

    expect(liveManifest, STALE_MESSAGE).toEqual(checkedInManifest());
  });

  it('sets the expected schema head to the lexicographically-last migration', () => {
    const lastFilename = [...EXPECTED_MIGRATIONS]
      .sort((left, right) => left.filename.localeCompare(right.filename))
      .at(-1)?.filename;

    expect(EXPECTED_SCHEMA_HEAD).toBe(lastFilename);
  });

  it('keeps the generated module bundleable in the db-less app image', async () => {
    const source = await fs.readFile(MANIFEST_PATH, 'utf8');

    expect(source).not.toContain('node:');
    expect(source).not.toContain('postgres');
    expect(source).not.toContain('./client');
  });

  it('uses the same sha256 hashing as the migration ledger', async () => {
    const spotFilenames = ['001_foundation.sql', EXPECTED_SCHEMA_HEAD];

    for (const filename of spotFilenames) {
      const entry = EXPECTED_MIGRATIONS.find((migration) => migration.filename === filename);
      expect(entry).toBeDefined();
      if (entry === undefined) {
        throw new Error(`Missing manifest entry for ${filename}`);
      }

      const content = await fs.readFile(path.join(MIGRATIONS_DIR, entry.filename), 'utf8');
      expect(entry.sha256).toBe(computeChecksum(content));
    }
  });

  it('is byte-identical to the generator output', async () => {
    const source = await fs.readFile(MANIFEST_PATH, 'utf8');

    expect(renderMigrationManifestModule(checkedInManifest()), STALE_MESSAGE).toBe(source);
  });
});
