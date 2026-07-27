import crypto from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ensureLedger,
  type MigrateSqlClient,
} from '../../scripts/db-migrate-core.js';
import {
  applyMigrationsThrough,
  createScratchDb,
  type ScratchDb,
} from '../helpers/scratch-db.js';

type ProvisionMagic = typeof import('../../src/lib/auth/org.js').provisionMagicLinkUserAndBuilder;

let scratch: ScratchDb;
let sql: Sql;
let provisionMagicLinkUserAndBuilder: ProvisionMagic;
let closeDb: () => Promise<void>;
let runtimeDatabaseUrl: string;
let originalDatabaseUrl: string | undefined;
let originalDeploymentMode: string | undefined;

function suffix(): string {
  return crypto.randomBytes(6).toString('hex');
}

async function insertUser(email: string): Promise<string> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, auth_provider)
    VALUES (${email}, 'magic_link')
    RETURNING id
  `;
  return user!.id;
}

async function insertBuilder(input: {
  email: string;
  slug: string;
  plan: 'pro' | 'scale';
}): Promise<string> {
  const [builder] = await sql<{ id: string }[]>`
    INSERT INTO builders (
      email,
      name,
      tier,
      access_state,
      entitlement_source,
      slug
    )
    VALUES (
      ${input.email},
      'Invited Workspace',
      ${input.plan},
      'active',
      'admin',
      ${input.slug}
    )
    RETURNING id
  `;
  return builder!.id;
}

async function insertInvite(input: {
  builderId: string;
  email: string;
  invitedByUserId: string;
  token: string;
}): Promise<string> {
  const [invite] = await sql<{ id: string }[]>`
    INSERT INTO invites (
      builder_id,
      email,
      role,
      token,
      expires_at,
      invited_by_user_id
    )
    VALUES (
      ${input.builderId},
      ${input.email},
      'member',
      ${input.token},
      NOW() + INTERVAL '1 hour',
      ${input.invitedByUserId}
    )
    RETURNING id
  `;
  return invite!.id;
}

describe.sequential('invite-first authentication atomicity (real PostgreSQL)', () => {
  beforeAll(async () => {
    scratch = await createScratchDb({ prefix: 'auth_invite_first_atomic' });
    await ensureLedger(scratch.sql as unknown as MigrateSqlClient);
    await applyMigrationsThrough(scratch, '058');
    await scratch.sql.unsafe('SET ROLE pylva_general_app_runtime');
    sql = scratch.sql;

    originalDatabaseUrl = process.env['DATABASE_URL'];
    originalDeploymentMode = process.env['PYLVA_DEPLOYMENT_MODE'];
    const runtimeUrl = new URL(scratch.url);
    runtimeUrl.searchParams.set('options', '-c role=pylva_general_app_runtime');
    runtimeDatabaseUrl = runtimeUrl.toString();
    process.env['DATABASE_URL'] = runtimeDatabaseUrl;
    process.env['PYLVA_DEPLOYMENT_MODE'] = 'hosted';
    vi.resetModules();
    ({ provisionMagicLinkUserAndBuilder } = await import('../../src/lib/auth/org.js'));
    ({ closeDb } = await import('../../src/lib/db/client.js'));
  }, 30_000);

  afterAll(async () => {
    await closeDb?.();
    if (originalDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = originalDatabaseUrl;
    if (originalDeploymentMode === undefined) delete process.env['PYLVA_DEPLOYMENT_MODE'];
    else process.env['PYLVA_DEPLOYMENT_MODE'] = originalDeploymentMode;
    await scratch?.drop();
  });

  it('creates the user and claims a valid email invitation without an explicit token', async () => {
    const testSuffix = suffix();
    const inviteeEmail = `generic-invitee-${testSuffix}@example.com`;
    const inviterId = await insertUser(`generic-inviter-${testSuffix}@example.com`);
    const builderId = await insertBuilder({
      email: `generic-workspace-${testSuffix}@example.com`,
      slug: `generic-invited-${testSuffix}`,
      plan: 'scale',
    });
    const inviteId = await insertInvite({
      builderId,
      email: inviteeEmail.toUpperCase(),
      invitedByUserId: inviterId,
      token: crypto.randomBytes(32).toString('hex'),
    });

    const { org, user } = await provisionMagicLinkUserAndBuilder({
      avatarUrl: null,
      displayName: 'Generic Invitee',
      email: inviteeEmail,
    });

    expect(user).toMatchObject({ email: inviteeEmail, isNewUser: true });
    expect(org).toMatchObject({
      acceptedInviteId: inviteId,
      builderId,
      isNew: false,
      role: 'member',
      slug: `generic-invited-${testSuffix}`,
    });
    const memberships = await sql<
      Array<{ builder_id: string; role: string; user_id: string }>
    >`
      SELECT builder_id, role, user_id
      FROM user_builder_memberships
      WHERE user_id = ${user.userId}
    `;
    expect(memberships).toEqual([
      { builder_id: builderId, role: 'member', user_id: user.userId },
    ]);
    const [personal] = await sql<{ count: string }[]>`
      SELECT count(*)::text
      FROM builders
      WHERE lower(email) = ${inviteeEmail}
    `;
    expect(personal!.count).toBe('0');
  });

  it('serializes explicit-invite and generic callbacks before user or workspace provisioning', async () => {
    const testSuffix = suffix();
    const inviteeEmail = `concurrent-invitee-${testSuffix}@example.com`;
    const token = crypto.randomBytes(32).toString('hex');
    const inviterId = await insertUser(`concurrent-inviter-${testSuffix}@example.com`);
    const builderId = await insertBuilder({
      email: `concurrent-workspace-${testSuffix}@example.com`,
      slug: `concurrent-invited-${testSuffix}`,
      plan: 'pro',
    });
    const inviteId = await insertInvite({
      builderId,
      email: inviteeEmail,
      invitedByUserId: inviterId,
      token,
    });

    const blocker = postgres(runtimeDatabaseUrl, { max: 1, onnotice: () => undefined });
    let releaseLock!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let lockReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      lockReady = resolve;
    });
    const heldTransaction = blocker.begin(async (tx) => {
      await tx`
        SELECT pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(
            pg_catalog.concat('pylva-auth-first-login:', ${inviteeEmail}::TEXT),
            ${50_620_260_723}::BIGINT
          )
        )
      `;
      lockReady();
      await release;
    });

    await ready;
    let settled = 0;
    const generic = provisionMagicLinkUserAndBuilder({
      avatarUrl: null,
      displayName: 'Concurrent Invitee',
      email: inviteeEmail,
    }).finally(() => {
      settled += 1;
    });
    const explicit = provisionMagicLinkUserAndBuilder({
      avatarUrl: null,
      displayName: 'Concurrent Invitee',
      email: inviteeEmail,
      pendingInviteToken: token,
    }).finally(() => {
      settled += 1;
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(settled).toBe(0);
    } finally {
      releaseLock();
      await heldTransaction;
      await blocker.end();
    }

    const results = await Promise.all([generic, explicit]);
    expect(results.map((result) => result.org.builderId)).toEqual([builderId, builderId]);
    expect(
      results.every((result) => result.user.userId === results[0]!.user.userId),
    ).toBe(true);
    expect(
      results.filter((result) => result.org.acceptedInviteId === inviteId),
    ).toHaveLength(1);

    const inviteeId = results[0]!.user.userId;
    const memberships = await sql<
      Array<{ builder_id: string; role: string; user_id: string }>
    >`
      SELECT builder_id, role, user_id
      FROM user_builder_memberships
      WHERE user_id = ${inviteeId}
      ORDER BY builder_id
    `;
    expect(memberships).toEqual([
      { builder_id: builderId, role: 'member', user_id: inviteeId },
    ]);
    const [personal] = await sql<{ count: string }[]>`
      SELECT count(*)::text
      FROM builders
      WHERE lower(email) = ${inviteeEmail}
    `;
    expect(personal!.count).toBe('0');
  });

  it('rolls back the new user and invite claim when membership insertion fails', async () => {
    const testSuffix = suffix();
    const inviteeEmail = `atomic-invitee-${testSuffix}@example.com`;
    const inviterId = await insertUser(`atomic-inviter-${testSuffix}@example.com`);
    const builderId = await insertBuilder({
      email: `atomic-workspace-${testSuffix}@example.com`,
      slug: `atomic-invited-${testSuffix}`,
      plan: 'pro',
    });
    const token = crypto.randomBytes(32).toString('hex');
    const inviteId = await insertInvite({
      builderId,
      email: inviteeEmail,
      invitedByUserId: inviterId,
      token,
    });
    const triggerName = `auth_membership_fail_${testSuffix}`;
    const functionName = `auth_membership_fail_fn_${testSuffix}`;

    await sql.unsafe(`
      CREATE FUNCTION "${functionName}"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.builder_id = '${builderId}'::UUID THEN
          RAISE EXCEPTION 'forced auth membership failure';
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER "${triggerName}"
      BEFORE INSERT ON user_builder_memberships
      FOR EACH ROW
      EXECUTE FUNCTION "${functionName}"();
    `);
    try {
      await expect(
        provisionMagicLinkUserAndBuilder({
          avatarUrl: null,
          displayName: 'Atomic Invitee',
          email: inviteeEmail,
          pendingInviteToken: token,
        }),
      ).rejects.toMatchObject({ stage: 'org_create' });

      const [state] = await sql<
        Array<{
          accepted_at: Date | null;
          membership_count: string;
          user_count: string;
        }>
      >`
        SELECT
          (SELECT accepted_at FROM invites WHERE id = ${inviteId}) AS accepted_at,
          (
            SELECT count(*)::text
            FROM user_builder_memberships
            WHERE builder_id = ${builderId}
          ) AS membership_count,
          (
            SELECT count(*)::text
            FROM users
            WHERE lower(email::text) = ${inviteeEmail}
          ) AS user_count
      `;
      expect(state).toEqual({
        accepted_at: null,
        membership_count: '0',
        user_count: '0',
      });
    } finally {
      await sql.unsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON user_builder_memberships`);
      await sql.unsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
    }
  });
});
