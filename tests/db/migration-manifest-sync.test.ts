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
const AUTHORITATIVE_BUDGET_LEDGER_MIGRATION = '050_authoritative_budget_control_ledger.sql';
const AUTHORITATIVE_BUDGET_RUNTIME_MIGRATION = '051_authoritative_budget_control_runtime.sql';
const AUTHORITATIVE_BUDGET_RUNTIME_ROLES_MIGRATION =
  '052_authoritative_budget_control_runtime_roles.sql';
const AUTHORITATIVE_BUDGET_LEGACY_RLS_COMPATIBILITY_MIGRATION =
  '053_legacy_catalog_owner_rls_compatibility.sql';
const GENERAL_APP_RUNTIME_OWNER_BOUNDARY_MIGRATION = '054_general_app_runtime_owner_boundary.sql';
const FROZEN_LEDGER_SHA256 = '3bd8b69ef1b09814e6cc0645b2eb188504fc84b4e15abbe5e42ddf704619218e';
const FROZEN_RUNTIME_SHA256 = '3fabbc1236e562eddd1b83e4c8826abfb61d0eca73b8e4773b10d94599055af8';
const FROZEN_RUNTIME_ROLES_SHA256 =
  '3cc7efe258ceb49e9fd56789c3fdb9a0f6cd76e990d5f5681ecc24cde4172be6';
const LEGACY_RLS_COMPATIBILITY_SHA256 =
  'ba598fab2d79316926ebce3e853c61a1408dae14cd4bb40a0a572f0a90bb431f';
const GENERAL_APP_RUNTIME_OWNER_BOUNDARY_SHA256 =
  'f6e3be6b0a190f00a2f620fdacbacbb34cdbfcc522a9d138a59e1142b7cd8dbb';

function checkedInManifest(): MigrationManifest {
  return {
    entries: EXPECTED_MIGRATIONS.map((entry) => ({
      filename: entry.filename,
      sha256: entry.sha256,
      phase: entry.phase,
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

  it('keeps the frozen authoritative ledger byte-identical in the manifest', async () => {
    const entry = EXPECTED_MIGRATIONS.find(
      (migration) => migration.filename === AUTHORITATIVE_BUDGET_LEDGER_MIGRATION,
    );
    expect(entry).toBeDefined();
    if (entry === undefined) {
      throw new Error(`Missing manifest entry for ${AUTHORITATIVE_BUDGET_LEDGER_MIGRATION}`);
    }

    const content = await fs.readFile(path.join(MIGRATIONS_DIR, entry.filename), 'utf8');
    expect(entry).toMatchObject({ phase: 'pre_roll' });
    expect(entry.sha256).toBe(computeChecksum(content));
    expect(entry.sha256).toBe(FROZEN_LEDGER_SHA256);
  });

  it('tracks the additive authoritative runtime migration', async () => {
    const entry = EXPECTED_MIGRATIONS.find(
      (migration) => migration.filename === AUTHORITATIVE_BUDGET_RUNTIME_MIGRATION,
    );
    expect(entry).toBeDefined();
    if (entry === undefined) {
      throw new Error(`Missing manifest entry for ${AUTHORITATIVE_BUDGET_RUNTIME_MIGRATION}`);
    }

    const content = await fs.readFile(path.join(MIGRATIONS_DIR, entry.filename), 'utf8');
    expect(entry).toMatchObject({ phase: 'pre_roll' });
    expect(entry.sha256).toBe(computeChecksum(content));
    expect(entry.sha256).toBe(FROZEN_RUNTIME_SHA256);
  });

  it('keeps the authoritative runtime-role migration byte-identical', async () => {
    const entry = EXPECTED_MIGRATIONS.find(
      (migration) => migration.filename === AUTHORITATIVE_BUDGET_RUNTIME_ROLES_MIGRATION,
    );
    expect(entry).toBeDefined();
    if (entry === undefined) {
      throw new Error(`Missing manifest entry for ${AUTHORITATIVE_BUDGET_RUNTIME_ROLES_MIGRATION}`);
    }

    const content = await fs.readFile(path.join(MIGRATIONS_DIR, entry.filename), 'utf8');
    expect(entry).toMatchObject({ phase: 'pre_roll' });
    expect(entry.sha256).toBe(computeChecksum(content));
    expect(entry.sha256).toBe(FROZEN_RUNTIME_ROLES_SHA256);
  });

  it('keeps the forward-only legacy RLS compatibility migration byte-identical', async () => {
    const entry = EXPECTED_MIGRATIONS.find(
      (migration) => migration.filename === AUTHORITATIVE_BUDGET_LEGACY_RLS_COMPATIBILITY_MIGRATION,
    );
    expect(entry).toBeDefined();
    if (entry === undefined) {
      throw new Error(
        `Missing manifest entry for ${AUTHORITATIVE_BUDGET_LEGACY_RLS_COMPATIBILITY_MIGRATION}`,
      );
    }

    const content = await fs.readFile(path.join(MIGRATIONS_DIR, entry.filename), 'utf8');
    expect(entry).toMatchObject({ phase: 'pre_roll' });
    expect(entry.sha256).toBe(computeChecksum(content));
    expect(entry.sha256).toBe(LEGACY_RLS_COMPATIBILITY_SHA256);
  });

  it('tracks the fixed general-app owner boundary as the schema head', async () => {
    const entry = EXPECTED_MIGRATIONS.find(
      (migration) => migration.filename === GENERAL_APP_RUNTIME_OWNER_BOUNDARY_MIGRATION,
    );
    expect(entry).toBeDefined();
    if (entry === undefined) {
      throw new Error(`Missing manifest entry for ${GENERAL_APP_RUNTIME_OWNER_BOUNDARY_MIGRATION}`);
    }

    const content = await fs.readFile(path.join(MIGRATIONS_DIR, entry.filename), 'utf8');
    expect(entry).toMatchObject({ phase: 'pre_roll' });
    expect(entry.sha256).toBe(computeChecksum(content));
    expect(entry.sha256).toBe(GENERAL_APP_RUNTIME_OWNER_BOUNDARY_SHA256);
    expect(EXPECTED_SCHEMA_HEAD).toBe(GENERAL_APP_RUNTIME_OWNER_BOUNDARY_MIGRATION);
  });

  it('marks only migration 048 as post_roll and defaults every other migration to pre_roll', () => {
    const postRoll = EXPECTED_MIGRATIONS.filter((migration) => migration.phase === 'post_roll');

    expect(postRoll.map((migration) => migration.filename)).toEqual([
      '048_universal_api_key_scope.sql',
    ]);
    expect(
      EXPECTED_MIGRATIONS.filter((migration) => migration.filename !== postRoll[0]?.filename).every(
        (migration) => migration.phase === 'pre_roll',
      ),
    ).toBe(true);
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
