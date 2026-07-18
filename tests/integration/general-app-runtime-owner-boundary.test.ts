import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import postgres, { type Sql } from 'postgres';
import { sql } from '../../src/lib/db/client.js';
import { withRLS } from '../../src/lib/db/rls.js';
import { customers } from '../../src/lib/db/schema.js';
import { getSchemaStatus } from '../../src/lib/db/schema-status.js';
import { findOrCreateBuilderForUser, resolveSlugForUser } from '../../src/lib/auth/org.js';
import { generateApiKey, validateApiKey } from '../../src/lib/auth/api-key.js';
import { auditLogPartitionSpecs, isValidPartitionSpec } from '../../src/lib/db/audit-partitions.js';
import { env } from '../../src/lib/config.js';
import { POST as ensureAuditPartitions } from '../../src/app/api/cron/ensure-audit-partitions/route.js';

const generalAppUrl = process.env['GENERAL_APP_DATABASE_URL'];
const migrationUrl = process.env['MIGRATION_DATABASE_URL'];
const shouldRun = Boolean(generalAppUrl && migrationUrl);

interface CredentialTarget {
  database: string;
  host: string;
  port: string;
  username: string;
}

function target(value: string): CredentialTarget {
  const url = new URL(value);
  return {
    database: url.pathname,
    host: url.hostname,
    port: url.port || '5432',
    username: decodeURIComponent(url.username),
  };
}

const suite = shouldRun ? describe : describe.skip;

suite('general-app runtime owner boundary (real PostgreSQL login)', () => {
  const suffix = crypto.randomBytes(6).toString('hex');
  const userId = crypto.randomUUID();
  const email = `general-owner-${suffix}@example.com`;
  let builderId = '';
  let slug = '';
  let boundaryProbe: Sql;

  beforeAll(async () => {
    const runtimeTarget = target(process.env['DATABASE_URL']!);
    const provisionTarget = target(generalAppUrl!);
    const migratorTarget = target(migrationUrl!);

    expect(runtimeTarget).toEqual(provisionTarget);
    expect(migratorTarget).toMatchObject({
      database: runtimeTarget.database,
      host: runtimeTarget.host,
      port: runtimeTarget.port,
    });
    expect(migratorTarget.username).not.toBe(runtimeTarget.username);
    boundaryProbe = postgres(generalAppUrl!, { max: 1 });

    await sql`
      INSERT INTO public.users (
        id, email, display_name, auth_provider, last_login_at
      )
      VALUES (
        ${userId}::UUID, ${email}, ${`General Owner ${suffix}`}, 'magic_link', NOW()
      )
    `;
  });

  afterAll(async () => {
    if (builderId) {
      await sql`DELETE FROM public.builders WHERE id = ${builderId}::UUID`;
    }
    await sql`DELETE FROM public.users WHERE id = ${userId}::UUID`;
    await boundaryProbe?.end({ timeout: 5 });
  });

  it('uses the non-admin login and completes the real pre-GUC auth bootstrap path', async () => {
    const [identity] = await sql<
      Array<{
        budget_member: boolean;
        general_member: boolean;
        general_set: boolean;
        session_user: string;
      }>
    >`
      SELECT SESSION_USER AS session_user,
             pg_catalog.pg_has_role(
               SESSION_USER,
               'pylva_general_app_runtime',
               'MEMBER'
             ) AS general_member,
             pg_catalog.pg_has_role(
               SESSION_USER,
               'pylva_general_app_runtime',
               'SET'
             ) AS general_set,
             pg_catalog.pg_has_role(
               SESSION_USER,
               'pylva_budget_control_runtime',
               'MEMBER'
             ) AS budget_member
    `;
    expect(identity).toMatchObject({
      session_user: target(generalAppUrl!).username,
      general_member: true,
      general_set: false,
      budget_member: false,
    });

    const created = await findOrCreateBuilderForUser({
      userId,
      email,
      displayName: `General Owner ${suffix}`,
      avatarUrl: null,
    });
    expect(created).toMatchObject({ isNew: true, role: 'owner', tier: 'free' });
    builderId = created.builderId;
    slug = created.slug;

    await expect(
      findOrCreateBuilderForUser({
        userId,
        email,
        displayName: `General Owner ${suffix}`,
        avatarUrl: null,
      }),
    ).resolves.toMatchObject({ builderId, slug, isNew: false, role: 'owner' });
    await expect(resolveSlugForUser({ slug, userId })).resolves.toMatchObject({
      builderId,
      role: 'owner',
      tier: 'free',
    });
  });

  it('performs tenant CRUD and real API-key authentication', async () => {
    const externalId = `general-owner-customer-${suffix}`;
    const customerId = await withRLS(builderId, async (tx) => {
      const [inserted] = await tx
        .insert(customers)
        .values({ builder_id: builderId, external_id: externalId })
        .returning({ id: customers.id });
      return inserted?.id;
    });
    expect(customerId).toBeTypeOf('string');

    const generated = await generateApiKey(builderId, 'general-owner-boundary');
    await expect(validateApiKey(generated.plaintextKey)).resolves.toEqual({
      builderId,
      scope: 'universal',
      keyId: generated.keyId,
    });
    const replacement = generated.plaintextKey.endsWith('0') ? '1' : '0';
    await expect(
      validateApiKey(`${generated.plaintextKey.slice(0, -1)}${replacement}`),
    ).resolves.toBeNull();

    await withRLS(builderId, async (tx) => {
      await tx.delete(customers).where(eq(customers.id, customerId!));
    });
  });

  it('reads SELECT-only schema status while direct authority access remains denied', async () => {
    await expect(getSchemaStatus(sql)).resolves.toMatchObject({
      applied_head: '054_general_app_runtime_owner_boundary.sql',
      pending_count: 0,
      state: 'in_sync',
    });

    await expect(
      boundaryProbe`SELECT builder_id FROM public.budget_accounts LIMIT 1`,
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      boundaryProbe`SELECT pg_catalog.nextval(
        'public.pylva_budget_authority_order_seq'::REGCLASS
      )`,
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('recreates a missing audit partition through the real route as the fixed owner', async () => {
    const partition = auditLogPartitionSpecs(new Date()).at(-1)!;
    expect(isValidPartitionSpec(partition)).toBe(true);

    await sql.unsafe(`DROP TABLE IF EXISTS public.\"${partition.name}\"`);
    const request = new Request('http://localhost/api/cron/ensure-audit-partitions', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.CRON_SECRET}` },
    });
    const response = await ensureAuditPartitions(
      request as unknown as import('next/server.js').NextRequest,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ failed: 0, invalid: 0, created: 1 });

    const [partitionPosture] = await sql<
      Array<{ app_owned_relations: number; is_direct_child: boolean; owner: string }>
    >`
      SELECT pg_catalog.pg_get_userbyid(child.relowner) AS owner,
             EXISTS (
               SELECT 1
               FROM pg_catalog.pg_inherits AS inheritance
               WHERE inheritance.inhrelid = child.oid
                 AND inheritance.inhparent = 'public.audit_log'::REGCLASS
             ) AS is_direct_child,
             (
               SELECT pg_catalog.count(*)::INT
               FROM pg_catalog.pg_class AS relation
               WHERE relation.relowner = SESSION_USER::REGROLE
             ) AS app_owned_relations
      FROM pg_catalog.pg_class AS child
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = child.relnamespace
      WHERE namespace.nspname = 'public'
        AND child.relname = ${partition.name}
    `;
    expect(partitionPosture).toEqual({
      owner: 'pylva_general_app_runtime',
      is_direct_child: true,
      app_owned_relations: 0,
    });
  });
});
