import crypto from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyPostgresMigration } from '../../scripts/apply-postgres-migration.js';
import { runDbMigrate } from '../../scripts/db-migrate.js';
import { applyMigrationsThrough, createScratchDb } from '../helpers/scratch-db.js';

const MIGRATIONS_DIR = path.resolve('db/migrations');
const THROUGH_040 = '040_audit_log_partition_runway.sql';
const THROUGH_045 = '045_flexible_provider_model_identifiers.sql';
const THROUGH_048 = '048_universal_api_key_scope.sql';

describe('migration 041 api key scopes', () => {
  it('remaps a legacy api_keys table, refuses implicit reapply, and allows forced rerun', async () => {
    const scratch = await createScratchDb({ prefix: 'api_key_scope_migration' });
    try {
      await applyMigrationsThrough(scratch, THROUGH_040);

      const baselineExit = await runDbMigrate(
        { mode: 'baseline', through: THROUGH_040, yes: true, json: false },
        {
          sql: scratch.sql,
          migrationsDir: MIGRATIONS_DIR,
          log: () => undefined,
          error: () => undefined,
        },
      );
      expect(baselineExit).toBe(0);

      const [builder] = await scratch.sql<{ id: string }[]>`
        INSERT INTO builders (email, name, slug)
        VALUES ('scope-migration@example.com', 'Scope Migration Test', 'scope-migration-test')
        RETURNING id
      `;
      const builderId = builder!.id;

      await scratch.sql`
        INSERT INTO api_keys (key_id, builder_id, key_hash, scope)
        VALUES
          ('legacy001', ${builderId}, 'hash', 'telemetry'),
          ('legacy002', ${builderId}, 'hash', 'pricing_admin'),
          ('legacy003', ${builderId}, 'hash', 'cost_sources_write')
      `;

      await applyPostgresMigration({
        migrationPath: 'db/migrations/041_rename_api_key_scopes.sql',
        sqlClient: scratch.sql,
      });

      await expect(
        applyPostgresMigration({
          migrationPath: 'db/migrations/041_rename_api_key_scopes.sql',
          sqlClient: scratch.sql,
        }),
      ).rejects.toThrow(/already recorded in schema_migrations/);

      await applyPostgresMigration({
        migrationPath: 'db/migrations/041_rename_api_key_scopes.sql',
        sqlClient: scratch.sql,
        force: true,
      });

      const rows = await scratch.sql<{ scope: string }[]>`
        SELECT scope FROM api_keys ORDER BY scope
      `;
      expect(rows.map((row) => row.scope)).toEqual(['admin_api', 'agent_sdk', 'data_import']);

      const constraints = await scratch.sql<{ conname: string; def: string }[]>`
        SELECT conname, pg_get_constraintdef(oid) AS def
        FROM pg_constraint
        WHERE conrelid = 'api_keys'::regclass
          AND conname LIKE 'api_keys_scope%'
        ORDER BY conname
      `;
      expect(constraints).toEqual([
        {
          conname: 'api_keys_scope_check',
          def: expect.stringContaining('agent_sdk'),
        },
      ]);
      expect(constraints[0]!.def).toContain('admin_api');
      expect(constraints[0]!.def).toContain('data_import');
      expect(constraints[0]!.def).not.toContain('telemetry');

      await expect(
        scratch.sql`
          INSERT INTO api_keys (key_id, builder_id, key_hash, scope)
          VALUES ('legacy004', ${builderId}, 'hash', 'not_a_scope')
        `,
      ).rejects.toThrow(/api_keys_scope_check/);
    } finally {
      await scratch.drop();
    }
  });

  it('accepts the renamed scopes plus universal in a schema migrated through 048', async () => {
    const scratch = await createScratchDb({ prefix: 'api_key_scope_final' });
    const suffix = crypto.randomBytes(6).toString('hex');
    const builderEmail = `scope-migration-${suffix}@example.com`;
    const builderSlug = `scope-migration-${suffix}`;
    try {
      await applyMigrationsThrough(scratch, THROUGH_048);

      const [builder] = await scratch.sql<{ id: string }[]>`
        INSERT INTO builders (email, name, slug)
        VALUES (${builderEmail}, 'Scope Migration Test', ${builderSlug})
        RETURNING id
      `;
      const builderId = builder!.id;

      // Legacy values stay insertable (previous-release straggler tolerance)
      // alongside the canonical universal scope.
      for (const scope of ['agent_sdk', 'admin_api', 'data_import', 'universal']) {
        await scratch.sql`
          INSERT INTO api_keys (key_id, builder_id, key_hash, scope, label)
          VALUES (${crypto.randomBytes(4).toString('hex')}, ${builderId}, 'hash', ${scope}, 'scope-test')
        `;
      }

      await expect(
        scratch.sql`
          INSERT INTO api_keys (key_id, builder_id, key_hash, scope, label)
          VALUES (${crypto.randomBytes(4).toString('hex')}, ${builderId}, 'hash', 'not_a_scope', 'scope-test')
        `,
      ).rejects.toThrow(/api_keys_scope_check/);

      const constraints = await scratch.sql<{ conname: string; def: string }[]>`
        SELECT conname, pg_get_constraintdef(oid) AS def
        FROM pg_constraint
        WHERE conrelid = 'api_keys'::regclass
          AND conname LIKE 'api_keys_scope%'
        ORDER BY conname
      `;
      expect(constraints.map((row) => row.conname)).toEqual(['api_keys_scope_check']);
      expect(constraints[0]!.def).toContain('agent_sdk');
      expect(constraints[0]!.def).toContain('admin_api');
      expect(constraints[0]!.def).toContain('data_import');
      expect(constraints[0]!.def).toContain('universal');
    } finally {
      await scratch.drop();
    }
  });
});

describe('migration 048 universal api key scope', () => {
  it('upgrades every legacy scope to universal with a rollback backup, idempotent rerun', async () => {
    const scratch = await createScratchDb({ prefix: 'universal_scope_migration' });
    try {
      await applyMigrationsThrough(scratch, THROUGH_045);

      const baselineExit = await runDbMigrate(
        { mode: 'baseline', through: THROUGH_045, yes: true, json: false },
        {
          sql: scratch.sql,
          migrationsDir: MIGRATIONS_DIR,
          log: () => undefined,
          error: () => undefined,
        },
      );
      expect(baselineExit).toBe(0);

      const [builder] = await scratch.sql<{ id: string }[]>`
        INSERT INTO builders (email, name, slug)
        VALUES ('universal-migration@example.com', 'Universal Migration Test', 'universal-migration-test')
        RETURNING id
      `;
      const builderId = builder!.id;

      await scratch.sql`
        INSERT INTO api_keys (key_id, builder_id, key_hash, scope)
        VALUES
          ('preaaaa1', ${builderId}, 'hash', 'agent_sdk'),
          ('preaaaa2', ${builderId}, 'hash', 'admin_api'),
          ('preaaaa3', ${builderId}, 'hash', 'data_import')
      `;

      await applyPostgresMigration({
        migrationPath: 'db/migrations/048_universal_api_key_scope.sql',
        sqlClient: scratch.sql,
      });

      // Every key is universal; key_id/key_hash untouched.
      const rows = await scratch.sql<{ key_id: string; scope: string; key_hash: string }[]>`
        SELECT key_id, scope, key_hash FROM api_keys ORDER BY key_id
      `;
      expect(rows.map((row) => row.scope)).toEqual(['universal', 'universal', 'universal']);
      expect(rows.map((row) => row.key_hash)).toEqual(['hash', 'hash', 'hash']);

      // Backup table preserves the pre-048 scopes for the documented rollback.
      const backup = await scratch.sql<{ key_id: string; scope: string }[]>`
        SELECT key_id, scope FROM _048_api_keys_scope_backup ORDER BY key_id
      `;
      expect(backup).toEqual([
        { key_id: 'preaaaa1', scope: 'agent_sdk' },
        { key_id: 'preaaaa2', scope: 'admin_api' },
        { key_id: 'preaaaa3', scope: 'data_import' },
      ]);

      // Widened constraint: same name, universal added, garbage still rejected,
      // legacy values still insertable for previous-release stragglers.
      const constraints = await scratch.sql<{ conname: string; def: string }[]>`
        SELECT conname, pg_get_constraintdef(oid) AS def
        FROM pg_constraint
        WHERE conrelid = 'api_keys'::regclass
          AND conname LIKE 'api_keys_scope%'
        ORDER BY conname
      `;
      expect(constraints.map((row) => row.conname)).toEqual(['api_keys_scope_check']);
      expect(constraints[0]!.def).toContain('universal');
      await expect(
        scratch.sql`
          INSERT INTO api_keys (key_id, builder_id, key_hash, scope)
          VALUES ('preaaaa4', ${builderId}, 'hash', 'not_a_scope')
        `,
      ).rejects.toThrow(/api_keys_scope_check/);
      await scratch.sql`
        INSERT INTO api_keys (key_id, builder_id, key_hash, scope)
        VALUES ('straggle', ${builderId}, 'hash', 'agent_sdk')
      `;
      await scratch.sql`DELETE FROM api_keys WHERE key_id = 'straggle'`;

      // Forced rerun is idempotent and does not clobber the backup.
      await applyPostgresMigration({
        migrationPath: 'db/migrations/048_universal_api_key_scope.sql',
        sqlClient: scratch.sql,
        force: true,
      });
      const backupAfterRerun = await scratch.sql<{ key_id: string }[]>`
        SELECT key_id FROM _048_api_keys_scope_backup ORDER BY key_id
      `;
      expect(backupAfterRerun.map((row) => row.key_id)).toEqual([
        'preaaaa1',
        'preaaaa2',
        'preaaaa3',
      ]);

      // Rollback smoke: the documented restore path brings the original
      // scopes back under the widened constraint.
      await scratch.sql`
        UPDATE api_keys k SET scope = b.scope
        FROM _048_api_keys_scope_backup b WHERE k.key_id = b.key_id
      `;
      const restored = await scratch.sql<{ scope: string }[]>`
        SELECT scope FROM api_keys ORDER BY key_id
      `;
      expect(restored.map((row) => row.scope)).toEqual([
        'agent_sdk',
        'admin_api',
        'data_import',
      ]);

      // Roll forward again (forced) to end in the shipped state.
      await applyPostgresMigration({
        migrationPath: 'db/migrations/048_universal_api_key_scope.sql',
        sqlClient: scratch.sql,
        force: true,
      });
      const rolledForward = await scratch.sql<{ scope: string }[]>`
        SELECT DISTINCT scope FROM api_keys
      `;
      expect(rolledForward.map((row) => row.scope)).toEqual(['universal']);
    } finally {
      await scratch.drop();
    }
  });
});
