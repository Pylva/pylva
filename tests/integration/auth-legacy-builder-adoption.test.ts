import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { applyPostgresMigration } from '../../scripts/apply-postgres-migration.js';
import { runDbMigrate } from '../../scripts/db-migrate.js';
import { findOrCreateBuilderForUser } from '../../src/lib/auth/org.js';
import { upsertUserFromOAuth } from '../../src/lib/auth/oauth.js';
import { OAuthProvider } from '@pylva/shared';
import { applyMigrationsThrough, createScratchDb } from '../helpers/scratch-db.js';

const MIGRATIONS_DIR = path.resolve('db/migrations');
const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://pylva:pylva_dev@localhost:5432/pylva';
const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });

const createdEmails = new Set<string>();
const createdBuilderIds = new Set<string>();

function suffix(): string {
  return crypto.randomBytes(6).toString('hex');
}

async function insertBuilder(args: {
  email: string;
  slug: string;
  tier?: string;
  name?: string;
  sql?: Sql;
}): Promise<string> {
  const client = args.sql ?? sql;
  const [builder] = await client<{ id: string }[]>`
    INSERT INTO builders (email, name, tier, slug)
    VALUES (${args.email}, ${args.name ?? 'Legacy Builder'}, ${args.tier ?? 'scale'}, ${args.slug})
    RETURNING id
  `;
  if (!args.sql) {
    createdEmails.add(args.email);
    createdBuilderIds.add(builder!.id);
  }
  return builder!.id;
}

async function insertUser(email: string): Promise<string> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, auth_provider)
    VALUES (${email}, 'magic_link')
    RETURNING id
  `;
  createdEmails.add(email);
  return user!.id;
}

async function membershipRows(builderId: string, userId?: string) {
  if (userId === undefined) {
    return sql<{ user_id: string; builder_id: string; role: string }[]>`
      SELECT user_id, builder_id, role
      FROM user_builder_memberships
      WHERE builder_id = ${builderId}
      ORDER BY created_at
    `;
  }
  return sql<{ user_id: string; builder_id: string; role: string }[]>`
    SELECT user_id, builder_id, role
    FROM user_builder_memberships
    WHERE builder_id = ${builderId}
      AND user_id = ${userId}
    ORDER BY created_at
  `;
}

async function upsertOAuthUser(email: string): Promise<string> {
  const user = await upsertUserFromOAuth({
    avatarUrl: 'https://cdn.example.com/avatar.png',
    displayName: 'OAuth Owner',
    email,
    provider: OAuthProvider.GITHUB,
  });
  createdEmails.add(email);
  return user.userId;
}

async function cleanup(): Promise<void> {
  if (createdBuilderIds.size > 0) {
    await sql`DELETE FROM builders WHERE id IN ${sql([...createdBuilderIds])}`;
  }
  if (createdEmails.size > 0) {
    await sql`DELETE FROM users WHERE lower(email::text) IN ${sql([...createdEmails].map((email) => email.toLowerCase()))}`;
  }
  createdBuilderIds.clear();
  createdEmails.clear();
}

describe('legacy builder auth adoption', () => {
  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await sql.end();
  });

  it('adopts a builder-only legacy row after OAuth creates the matching user', async () => {
    const testSuffix = suffix();
    const email = `legacy-builder-${testSuffix}@example.com`;
    const builderId = await insertBuilder({
      email,
      slug: `legacy-builder-${testSuffix}`,
      tier: 'scale',
    });
    await sql`
      INSERT INTO api_keys (key_id, builder_id, key_hash, scope, label)
      VALUES (${crypto.randomBytes(4).toString('hex')}, ${builderId}, 'hash', 'agent_sdk', 'legacy key')
    `;

    const userId = await upsertOAuthUser(email);
    const org = await findOrCreateBuilderForUser({
      avatarUrl: 'https://cdn.example.com/avatar.png',
      displayName: 'OAuth Owner',
      email,
      userId,
    });

    expect(org).toEqual({
      builderId,
      isNew: false,
      role: 'owner',
      slug: `legacy-builder-${testSuffix}`,
      tier: 'scale',
    });
    expect(await membershipRows(builderId, userId)).toEqual([
      { builder_id: builderId, role: 'owner', user_id: userId },
    ]);
    const keyRows = await sql<{ count: string }[]>`
      SELECT count(*)::text FROM api_keys WHERE builder_id = ${builderId}
    `;
    expect(keyRows[0]!.count).toBe('1');
  });

  it('keeps repeated sign-ins idempotent for the adopted builder', async () => {
    const testSuffix = suffix();
    const email = `repeat-legacy-${testSuffix}@example.com`;
    const builderId = await insertBuilder({
      email,
      slug: `repeat-legacy-${testSuffix}`,
      tier: 'pro',
    });
    const userId = await upsertOAuthUser(email);

    const first = await findOrCreateBuilderForUser({
      avatarUrl: null,
      displayName: 'Repeat Owner',
      email,
      userId,
    });
    const second = await findOrCreateBuilderForUser({
      avatarUrl: null,
      displayName: 'Repeat Owner',
      email,
      userId,
    });

    expect(first.builderId).toBe(builderId);
    expect(second.builderId).toBe(builderId);
    expect(await membershipRows(builderId, userId)).toHaveLength(1);
  });

  it('links an existing user and same-email builder that have no membership', async () => {
    const testSuffix = suffix();
    const email = `existing-user-${testSuffix}@example.com`;
    const builderId = await insertBuilder({
      email,
      slug: `existing-user-${testSuffix}`,
      tier: 'enterprise',
    });
    const userId = await insertUser(email);

    const org = await findOrCreateBuilderForUser({
      avatarUrl: null,
      displayName: null,
      email,
      userId,
    });

    expect(org.builderId).toBe(builderId);
    expect(org.tier).toBe('enterprise');
    expect(org.isNew).toBe(false);
    expect(await membershipRows(builderId, userId)).toEqual([
      { builder_id: builderId, role: 'owner', user_id: userId },
    ]);
  });

  it('matches existing builder emails case-insensitively', async () => {
    const testSuffix = suffix();
    const builderEmail = `Mixed-${testSuffix}@Example.COM`;
    const loginEmail = builderEmail.toLowerCase();
    const builderId = await insertBuilder({
      email: builderEmail,
      slug: `mixed-${testSuffix}`,
      tier: 'scale',
    });
    const userId = await upsertOAuthUser(loginEmail);

    const org = await findOrCreateBuilderForUser({
      avatarUrl: null,
      displayName: 'Mixed Owner',
      email: loginEmail,
      userId,
    });

    expect(org.builderId).toBe(builderId);
    expect(org.slug).toBe(`mixed-${testSuffix}`);
    expect(await membershipRows(builderId, userId)).toHaveLength(1);
  });

  it('still creates a new free builder for a brand-new email', async () => {
    const testSuffix = suffix();
    const email = `brand-new-${testSuffix}@example.com`;
    const userId = await upsertOAuthUser(email);

    const org = await findOrCreateBuilderForUser({
      avatarUrl: null,
      displayName: 'Brand New',
      email,
      userId,
    });
    createdBuilderIds.add(org.builderId);

    expect(org.isNew).toBe(true);
    expect(org.role).toBe('owner');
    expect(org.tier).toBe('free');
    expect(await membershipRows(org.builderId, userId)).toEqual([
      { builder_id: org.builderId, role: 'owner', user_id: userId },
    ]);
    const builders = await sql<{ email: string }[]>`
      SELECT email FROM builders WHERE id = ${org.builderId}
    `;
    expect(builders[0]!.email).toBe(email);
  });
});

describe('legacy builder membership migration and CLI provisioning', () => {
  it('backfills memberships only for existing matching user and builder emails', async () => {
    const scratch = await createScratchDb({ prefix: 'auth_legacy_backfill' });
    try {
      await applyMigrationsThrough(scratch, '048');
      const baselineExit = await runDbMigrate(
        { mode: 'baseline', through: '048_universal_api_key_scope.sql', yes: true, json: false },
        {
          error: () => undefined,
          log: () => undefined,
          migrationsDir: MIGRATIONS_DIR,
          sql: scratch.sql,
        },
      );
      expect(baselineExit).toBe(0);

      const testSuffix = suffix();
      const matchingEmail = `backfill-${testSuffix}@example.com`;
      const unmatchedEmail = `unmatched-${testSuffix}@example.com`;
      const matchingBuilderId = await insertBuilder({
        email: matchingEmail,
        slug: `backfill-${testSuffix}`,
        sql: scratch.sql,
      });
      const unmatchedBuilderId = await insertBuilder({
        email: unmatchedEmail,
        slug: `unmatched-${testSuffix}`,
        sql: scratch.sql,
      });
      const [user] = await scratch.sql<{ id: string }[]>`
        INSERT INTO users (email, auth_provider)
        VALUES (${matchingEmail.toUpperCase()}, 'oauth_github')
        RETURNING id
      `;

      await applyPostgresMigration({
        migrationPath: 'db/migrations/049_backfill_builder_owner_memberships.sql',
        sqlClient: scratch.sql,
      });
      await applyPostgresMigration({
        force: true,
        migrationPath: 'db/migrations/049_backfill_builder_owner_memberships.sql',
        sqlClient: scratch.sql,
      });

      const matchingMemberships = await scratch.sql<{ user_id: string; role: string }[]>`
        SELECT user_id, role
        FROM user_builder_memberships
        WHERE builder_id = ${matchingBuilderId}
      `;
      expect(matchingMemberships).toEqual([{ role: 'owner', user_id: user!.id }]);

      const unmatchedMemberships = await scratch.sql<{ count: string }[]>`
        SELECT count(*)::text FROM user_builder_memberships
        WHERE builder_id = ${unmatchedBuilderId}
      `;
      expect(unmatchedMemberships[0]!.count).toBe('0');
    } finally {
      await scratch.drop();
    }
  });

  it('makes create-builder idempotent for builder, user, and owner membership provisioning', async () => {
    const scratch = await createScratchDb({ prefix: 'auth_cli_builder' });
    try {
      await applyMigrationsThrough(scratch, '049');
      const testSuffix = suffix();
      const email = `cli-owner-${testSuffix}@example.com`;
      const scriptPath = path.resolve('scripts/cli/create-builder.ts');

      for (const tier of ['pro', 'scale']) {
        const result = spawnSync(
          'pnpm',
          ['exec', 'tsx', scriptPath, '--email', email.toUpperCase(), '--tier', tier, '--no-key'],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              DATABASE_URL: scratch.url,
            },
          },
        );
        expect(`${result.stdout}\n${result.stderr}`).toContain('Owner user:');
        expect(result.status).toBe(0);
      }

      const rows = await scratch.sql<
        {
          builder_count: string;
          user_count: string;
          membership_count: string;
          tier: string;
          email: string;
        }[]
      >`
        SELECT
          (SELECT count(*)::text FROM builders WHERE lower(email) = ${email}) AS builder_count,
          (SELECT count(*)::text FROM users WHERE lower(email::text) = ${email}) AS user_count,
          (
            SELECT count(*)::text
            FROM user_builder_memberships m
            JOIN builders b ON b.id = m.builder_id
            JOIN users u ON u.id = m.user_id
            WHERE lower(b.email) = ${email}
              AND lower(u.email::text) = ${email}
          ) AS membership_count,
          (SELECT tier FROM builders WHERE lower(email) = ${email}) AS tier,
          (SELECT email FROM builders WHERE lower(email) = ${email}) AS email
      `;

      expect(rows[0]).toMatchObject({
        builder_count: '1',
        email,
        membership_count: '1',
        tier: 'scale',
        user_count: '1',
      });
    } finally {
      await scratch.drop();
    }
  });
});
