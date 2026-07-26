import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import postgres, { type Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { ensureLedger, type MigrateSqlClient } from '../../scripts/db-migrate-core.js';
import { applyMigrationsThrough, createScratchDb, type ScratchDb } from '../helpers/scratch-db.js';

const EXPAND = 'db/migrations/056_workspace_access_state_expand.sql';
const CONTRACT = 'db/migrations/058_remove_free_plan_contract.sql';
const HAS_HOSTED_COMPANION = existsSync(
  path.resolve('db/migrations/057_hosted_workspace_entitlements.sql'),
);
const TEST_TIMEOUT_MS = 180_000;

async function assumeRuntimeRole(scratch: ScratchDb): Promise<void> {
  await scratch.sql.unsafe('SET ROLE pylva_general_app_runtime');
}

async function applyMigrationWithClient(sql: Sql, migrationPath: string): Promise<void> {
  const content = await readFile(path.resolve(migrationPath), 'utf8');
  await sql.begin((tx) => tx.unsafe(content));
}

async function applyMigration(scratch: ScratchDb, migrationPath: string): Promise<void> {
  await applyMigrationWithClient(scratch.sql, migrationPath);
}

function identity(label: string): { email: string; slug: string } {
  const suffix = crypto.randomBytes(5).toString('hex');
  return {
    email: `${label}-${suffix}@example.com`,
    slug: `${label}-${suffix}`,
  };
}

describe('workspace access-state migrations', () => {
  it(
    'narrows budget runtime builder access while preserving tenant-scoped lifecycle row locks',
    async () => {
      const scratch = await createScratchDb({ prefix: 'access_state_budget_acl' });
      try {
        await ensureLedger(scratch.sql as unknown as MigrateSqlClient);
        await applyMigrationsThrough(scratch, '055');
        await assumeRuntimeRole(scratch);
        const selected = identity('budget-selected');
        const other = identity('budget-other');
        const inserted = await scratch.sql<Array<{ id: string }>>`
          INSERT INTO builders (email, slug, tier)
          VALUES
            (${selected.email}, ${selected.slug}, 'pro'),
            (${other.email}, ${other.slug}, 'scale')
          RETURNING id
        `;
        const selectedId = inserted[0]!.id;
        const otherId = inserted[1]!.id;

        await applyMigration(scratch, EXPAND);

        const directAcl = await scratch.sql<
          Array<{
            column_name: string;
            privilege_type: string;
          }>
        >`
          SELECT attribute.attname AS column_name,
                 privilege.privilege_type
          FROM pg_catalog.pg_attribute AS attribute
          CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
          JOIN pg_catalog.pg_roles AS grantee
            ON grantee.oid = privilege.grantee
          WHERE attribute.attrelid = 'public.builders'::pg_catalog.regclass
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
            AND grantee.rolname = 'pylva_budget_control_runtime'
          ORDER BY attribute.attname, privilege.privilege_type
        `;
        expect(directAcl).toEqual([
          { column_name: 'access_state', privilege_type: 'SELECT' },
          { column_name: 'entitlement_source', privilege_type: 'SELECT' },
          { column_name: 'id', privilege_type: 'SELECT' },
          { column_name: 'id', privilege_type: 'UPDATE' },
          { column_name: 'tier', privilege_type: 'SELECT' },
        ]);
        const [tableAcl] = await scratch.sql<
          Array<{ has_table_select: boolean; has_table_update: boolean }>
        >`
          SELECT pg_catalog.has_table_privilege(
                   'pylva_budget_control_runtime',
                   'public.builders',
                   'SELECT'
                 ) AS has_table_select,
                 pg_catalog.has_table_privilege(
                   'pylva_budget_control_runtime',
                   'public.builders',
                   'UPDATE'
                 ) AS has_table_update
        `;
        expect(tableAcl).toEqual({
          has_table_select: false,
          has_table_update: false,
        });

        const visible = await scratch.sql.begin(async (transaction) => {
          await transaction.unsafe('SET LOCAL ROLE pylva_budget_control_runtime');
          await transaction`
            SELECT pg_catalog.set_config(
              'app.builder_id', ${selectedId}::UUID::TEXT, TRUE
            )
          `;
          return transaction<
            Array<{
              access_state: string | null;
              entitlement_source: string | null;
              id: string;
              tier: string | null;
            }>
          >`
            SELECT id, tier, access_state, entitlement_source
            FROM public.builders
            WHERE id IN (${selectedId}::UUID, ${otherId}::UUID)
            FOR SHARE
          `;
        });
        expect(visible).toHaveLength(1);
        expect(visible[0]).toMatchObject({ id: selectedId });

        await expect(
          scratch.sql.begin(async (transaction) => {
            await transaction.unsafe('SET LOCAL ROLE pylva_budget_control_runtime');
            await transaction`
              SELECT pg_catalog.set_config(
                'app.builder_id', ${selectedId}::UUID::TEXT, TRUE
              )
            `;
            await transaction`
              SELECT email
              FROM public.builders
              WHERE id = ${selectedId}::UUID
            `;
          }),
        ).rejects.toMatchObject({ code: '42501' });

        await expect(
          scratch.sql.begin(async (transaction) => {
            await transaction.unsafe('SET LOCAL ROLE pylva_budget_control_runtime');
            await transaction`
              SELECT pg_catalog.set_config(
                'app.builder_id', ${selectedId}::UUID::TEXT, TRUE
              )
            `;
            await transaction`
              UPDATE public.builders
              SET tier = 'scale'
              WHERE id = ${selectedId}::UUID
            `;
          }),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await scratch.sql.unsafe('RESET ROLE').catch(() => undefined);
        await scratch.drop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it.skipIf(HAS_HOSTED_COMPANION)(
    'aborts on self-hosted Free rows, then converts non-Free rows to planless self-host access',
    async () => {
      const scratch = await createScratchDb({ prefix: 'access_state_self_hosted' });
      try {
        await ensureLedger(scratch.sql as unknown as MigrateSqlClient);
        await applyMigrationsThrough(scratch, '055');
        await assumeRuntimeRole(scratch);
        const free = identity('legacy-free');
        const pro = identity('legacy-pro');
        const [freeRow] = await scratch.sql<Array<{ id: string }>>`
          INSERT INTO builders (email, slug, tier)
          VALUES
            (${free.email}, ${free.slug}, 'free'),
            (${pro.email}, ${pro.slug}, 'pro')
          RETURNING id
        `;

        const expandError = await applyMigration(scratch, EXPAND).catch(
          (error: unknown) => error,
        );
        expect(expandError).toBeInstanceOf(Error);
        expect(expandError).toMatchObject({
          message: expect.stringMatching(/1 Free workspace\(s\) remain/),
          detail: expect.stringContaining(freeRow!.id),
        });
        await assumeRuntimeRole(scratch);
        const freeRowsAfterAbort = await scratch.sql<Array<{ id: string; tier: string }>>`
          SELECT id, tier
          FROM builders
          WHERE email = ${free.email}
        `;
        expect(freeRowsAfterAbort).toEqual([{ id: freeRow!.id, tier: 'free' }]);

        await scratch.sql`DELETE FROM builders WHERE email = ${free.email}`;
        await applyMigration(scratch, EXPAND);
        await assumeRuntimeRole(scratch);
        const rows = await scratch.sql<
          Array<{
            access_state: string;
            entitlement_source: string;
            tier: string | null;
          }>
        >`
          SELECT tier, access_state, entitlement_source
          FROM builders
          WHERE email = ${pro.email}
          ORDER BY email
        `;

        expect(rows).toEqual([
          { access_state: 'active', entitlement_source: 'self_hosted', tier: null },
        ]);

        // During expand, an undrained old binary still omits tier. The legacy
        // default remains observable as Free, but the temporary validated
        // constraint rejects the write immediately.
        const oldWriter = identity('old-writer');
        await expect(
          scratch.sql`
            INSERT INTO builders (email, slug)
            VALUES (${oldWriter.email}, ${oldWriter.slug})
          `,
        ).rejects.toMatchObject({
          code: '23514',
          constraint_name: 'builders_no_new_free_during_expand_check',
        });
        const [oldWriterCount] = await scratch.sql<Array<{ count: number }>>`
          SELECT count(*)::INT AS count
          FROM builders
          WHERE email = ${oldWriter.email}
        `;
        expect(oldWriterCount).toEqual({ count: 0 });

        await applyMigration(scratch, CONTRACT);
        await assumeRuntimeRole(scratch);

        const checkout = identity('checkout');
        await expect(
          scratch.sql`
            INSERT INTO builders (
              email,
              slug,
              tier,
              access_state,
              entitlement_source
            )
            VALUES (${checkout.email}, ${checkout.slug}, NULL, 'checkout_required', NULL)
          `,
        ).resolves.toBeDefined();

        const invalid = identity('invalid-free');
        await expect(
          scratch.sql`
            INSERT INTO builders (
              email,
              slug,
              tier,
              access_state,
              entitlement_source
            )
            VALUES (${invalid.email}, ${invalid.slug}, 'free', 'active', 'admin')
          `,
        ).rejects.toMatchObject({ code: '23514' });
      } finally {
        await scratch.drop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'defers hosted rows to the private companion and refuses contraction without it',
    async () => {
      const scratch = await createScratchDb({ prefix: 'access_state_hosted' });
      try {
        await ensureLedger(scratch.sql as unknown as MigrateSqlClient);
        await applyMigrationsThrough(scratch, '055');
        await assumeRuntimeRole(scratch);
        const [subscriptionTable] = await scratch.sql<
          Array<{ relation_name: string | null }>
        >`
          SELECT to_regclass('public.builder_subscriptions')::text AS relation_name
        `;
        if (subscriptionTable?.relation_name === null) {
          await scratch.sql`
            CREATE TABLE builder_subscriptions (
              builder_id UUID PRIMARY KEY REFERENCES builders(id) ON DELETE CASCADE,
              status TEXT NOT NULL,
              grace_expires_at TIMESTAMPTZ
            )
          `;
        }

        const legacyFree = identity('hosted-free');
        const paid = identity('hosted-paid');
        await scratch.sql`
          INSERT INTO builders (email, slug, tier)
          VALUES
            (${legacyFree.email}, ${legacyFree.slug}, 'free'),
            (${paid.email}, ${paid.slug}, 'pro')
        `;

        await expect(applyMigration(scratch, EXPAND)).rejects.toThrow(
          /Free workspace\(s\) remain/,
        );
        await scratch.sql`DELETE FROM builders WHERE email = ${legacyFree.email}`;
        await applyMigration(scratch, EXPAND);
        await assumeRuntimeRole(scratch);
        const rejectedOldWriter = identity('hosted-old-writer');
        await expect(
          scratch.sql`
            INSERT INTO builders (email, slug)
            VALUES (${rejectedOldWriter.email}, ${rejectedOldWriter.slug})
          `,
        ).rejects.toMatchObject({
          code: '23514',
          constraint_name: 'builders_no_new_free_during_expand_check',
        });
        const rows = await scratch.sql<
          Array<{
            access_state: string | null;
            email: string;
            entitlement_source: string | null;
            tier: string | null;
          }>
        >`
          SELECT email, tier, access_state, entitlement_source
          FROM builders
          WHERE email = ${paid.email}
          ORDER BY email
        `;
        const byEmail = new Map(rows.map((row) => [row.email, row]));

        expect(byEmail.get(paid.email)).toMatchObject({
          tier: 'pro',
          access_state: null,
          entitlement_source: null,
        });

        await expect(applyMigration(scratch, CONTRACT)).rejects.toThrow(/have no access_state/);
      } finally {
        await scratch.drop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'serializes expand behind an overlapping old writer, then rejects every later legacy Free write',
    async () => {
      const scratch = await createScratchDb({ prefix: 'access_state_concurrent_writer' });
      const writerSql = postgres(scratch.url, {
        max: 1,
        onnotice: () => undefined,
      });
      const migrationSql = postgres(scratch.url, {
        max: 1,
        onnotice: () => undefined,
      });
      let releaseWriter = (): void => undefined;

      try {
        await ensureLedger(scratch.sql as unknown as MigrateSqlClient);
        await applyMigrationsThrough(scratch, '055');

        let markInserted = (): void => undefined;
        const inserted = new Promise<void>((resolve) => {
          markInserted = resolve;
        });
        const holdWriter = new Promise<void>((resolve) => {
          releaseWriter = resolve;
        });
        const oldWriter = identity('concurrent-old-writer');
        const writer = writerSql.begin(async (tx) => {
          await tx.unsafe('SET LOCAL ROLE pylva_general_app_runtime');
          await tx`
            INSERT INTO builders (email, slug)
            VALUES (${oldWriter.email}, ${oldWriter.slug})
          `;
          markInserted();
          await holdWriter;
        });

        await inserted;
        let expandSettled = false;
        const expand = applyMigrationWithClient(migrationSql, EXPAND)
          .then(() => null)
          .catch((error: unknown) => error)
          .finally(() => {
            expandSettled = true;
          });

        // ALTER TABLE requires an exclusive lock and must not overtake the
        // transaction that began under the legacy schema.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(expandSettled).toBe(false);

        releaseWriter();
        await writer;
        const expandError = await expand;
        expect(expandError).toMatchObject({
          message: expect.stringMatching(/1 Free workspace\(s\) remain/),
        });

        await assumeRuntimeRole(scratch);
        const [row] = await scratch.sql<
          Array<{ tier: string | null }>
        >`
          SELECT tier
          FROM builders
          WHERE email = ${oldWriter.email}
        `;
        expect(row).toEqual({ tier: 'free' });
        await scratch.sql`
          DELETE FROM builders
          WHERE email = ${oldWriter.email}
        `;

        await applyMigration(scratch, EXPAND);
        await assumeRuntimeRole(scratch);

        const rejectedAfterExpand = identity('rejected-after-expand');
        await expect(
          scratch.sql`
            INSERT INTO builders (email, slug)
            VALUES (${rejectedAfterExpand.email}, ${rejectedAfterExpand.slug})
          `,
        ).rejects.toMatchObject({
          code: '23514',
          constraint_name: 'builders_no_new_free_during_expand_check',
        });

        const [defaultRow] = await scratch.sql<Array<{ default_expression: string | null }>>`
          SELECT pg_get_expr(defaults.adbin, defaults.adrelid) AS default_expression
          FROM pg_catalog.pg_attribute AS attribute
          LEFT JOIN pg_catalog.pg_attrdef AS defaults
            ON defaults.adrelid = attribute.attrelid
           AND defaults.adnum = attribute.attnum
          WHERE attribute.attrelid = 'public.builders'::regclass
            AND attribute.attname = 'tier'
        `;
        expect(defaultRow?.default_expression).toContain('free');

        await applyMigration(scratch, CONTRACT);
      } finally {
        releaseWriter();
        await Promise.allSettled([writerSql.end(), migrationSql.end()]);
        await scratch.drop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
