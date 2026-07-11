// Cross-tenant API key revocation — regression test for the missing builder_id
// predicate in DELETE /api/v1/settings/api-keys/[id].
//
// Root cause: the app connects as the table-OWNER role and no table sets
// FORCE ROW LEVEL SECURITY, so RLS policies are bypassed for the app's own
// queries in production (the tenant-isolation suite uses a separate
// NOBYPASSRLS role precisely because the app role does not enforce them).
// Therefore the real isolation boundary is the explicit `WHERE builder_id`
// predicate in every query — not withRLS().
//
// The DELETE handler looked up the key row by id alone:
//     .where(eq(apiKeys.id, id))
// which, with RLS effectively off, let an owner of builder A revoke (and read
// the key_id/scope of) builder B's API key by its row id — a client-exposed
// UUID returned by GET /api/v1/settings/api-keys. The fix adds
// `eq(apiKeys.builder_id, ctx.builderId)`, matching every sibling [id] route.
//
// Requires real Postgres (runs under vitest.integration.config.ts). Redis is
// not required: revokeApiKey swallows pub/sub failures.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import argon2 from 'argon2';
import crypto from 'node:crypto';
import { NextRequest } from 'next/server.js';
import { Role } from '@pylva/shared';

import { DELETE as deleteApiKey } from '../../src/app/api/v1/settings/api-keys/[id]/route.js';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://pylva:pylva_dev@localhost:5432/pylva';
const ARGON2_SECRET = process.env['ARGON2_SECRET'] ?? 'dev-secret-change-in-prod';

let sql: ReturnType<typeof postgres>;
let attackerBuilderId = ''; // builder A — the caller
let victimBuilderId = ''; // builder B — owns the target key
let attackerUserId = '';
let victimKeyRowId = ''; // api_keys.id (UUID) of B's key — the IDOR handle
let victimKeyId = ''; // api_keys.key_id of B's key
let ownKeyRowId = ''; // api_keys.id (UUID) of A's own key — happy-path target
let ownKeyId = ''; // api_keys.key_id of A's own key

const suffix = crypto.randomBytes(4).toString('hex');
const builderIdsToCleanup: string[] = [];
const userIdsToCleanup: string[] = [];
const keyIdsToCleanup: string[] = [];

function dashboardDeleteRequest(builderId: string, userId: string): NextRequest {
  return new NextRequest('http://localhost/api/v1/settings/api-keys/x', {
    method: 'DELETE',
    headers: {
      'x-builder-id': builderId,
      'x-user-id': userId,
      'x-user-role': Role.OWNER,
    },
  } as ConstructorParameters<typeof NextRequest>[1]);
}

beforeAll(async () => {
  sql = postgres(DATABASE_URL);

  const [a] = await sql<{ id: string }[]>`
    INSERT INTO builders (email, name, tier, slug)
    VALUES (${`xtenant-attacker-${suffix}@test.com`}, 'Attacker A', 'free', ${`xtenant-attacker-${suffix}`})
    RETURNING id
  `;
  attackerBuilderId = a!.id;
  builderIdsToCleanup.push(attackerBuilderId);

  const [b] = await sql<{ id: string }[]>`
    INSERT INTO builders (email, name, tier, slug)
    VALUES (${`xtenant-victim-${suffix}@test.com`}, 'Victim B', 'free', ${`xtenant-victim-${suffix}`})
    RETURNING id
  `;
  victimBuilderId = b!.id;
  builderIdsToCleanup.push(victimBuilderId);

  const [u] = await sql<{ id: string }[]>`
    INSERT INTO users (email, auth_provider)
    VALUES (${`xtenant-user-${suffix}@test.com`}, 'magic_link')
    RETURNING id
  `;
  attackerUserId = u!.id;
  userIdsToCleanup.push(attackerUserId);

  await sql`
    INSERT INTO user_builder_memberships (user_id, builder_id, role)
    VALUES (${attackerUserId}, ${attackerBuilderId}, 'owner')
  `;

  // Victim builder B's API key — the cross-tenant target.
  victimKeyId = crypto.randomBytes(4).toString('hex');
  const keyHash = await argon2.hash(`pv_live_${victimKeyId}_secret`, {
    secret: Buffer.from(ARGON2_SECRET),
  });
  const [k] = await sql<{ id: string }[]>`
    INSERT INTO api_keys (key_id, builder_id, key_hash, scope)
    VALUES (${victimKeyId}, ${victimBuilderId}, ${keyHash}, 'agent_sdk')
    RETURNING id
  `;
  victimKeyRowId = k!.id;
  keyIdsToCleanup.push(victimKeyId);

  // Attacker builder A's own API key — the same-tenant happy path. Confirms the
  // fix does not over-correct into rejecting legitimate revokes.
  ownKeyId = crypto.randomBytes(4).toString('hex');
  const ownHash = await argon2.hash(`pv_live_${ownKeyId}_secret`, {
    secret: Buffer.from(ARGON2_SECRET),
  });
  const [ok] = await sql<{ id: string }[]>`
    INSERT INTO api_keys (key_id, builder_id, key_hash, scope)
    VALUES (${ownKeyId}, ${attackerBuilderId}, ${ownHash}, 'agent_sdk')
    RETURNING id
  `;
  ownKeyRowId = ok!.id;
  keyIdsToCleanup.push(ownKeyId);
});

afterAll(async () => {
  if (!sql) return;

  try {
    if (keyIdsToCleanup.length > 0) {
      await sql`DELETE FROM api_keys WHERE key_id IN ${sql(keyIdsToCleanup)}`;
    }
    if (builderIdsToCleanup.length > 0) {
      await sql`DELETE FROM api_keys WHERE builder_id IN ${sql(builderIdsToCleanup)}`;
      await sql`DELETE FROM audit_log WHERE builder_id IN ${sql(builderIdsToCleanup)}`;
      await sql`DELETE FROM user_builder_memberships WHERE builder_id IN ${sql(builderIdsToCleanup)}`;
    }
    if (userIdsToCleanup.length > 0) {
      await sql`DELETE FROM users WHERE id IN ${sql(userIdsToCleanup)}`;
    }
    if (builderIdsToCleanup.length > 0) {
      await sql`DELETE FROM builders WHERE id IN ${sql(builderIdsToCleanup)}`;
    }
  } finally {
    await sql.end();
  }
});

describe('DELETE /api/v1/settings/api-keys/[id] — cross-tenant isolation', () => {
  it('an owner of builder A cannot revoke the API key of builder B by its row id', async () => {
    const request = dashboardDeleteRequest(attackerBuilderId, attackerUserId);
    const response = await deleteApiKey(request, {
      params: Promise.resolve({ id: victimKeyRowId }),
    });

    // The target belongs to another builder → must look not-found, not 200.
    expect(response.status).toBe(404);

    // And the victim's key must remain usable (revoked_at still NULL).
    const [row] = await sql<{ revoked_at: string | null }[]>`
      SELECT revoked_at FROM api_keys WHERE key_id = ${victimKeyId}
    `;
    expect(row).toBeDefined();
    expect(row!.revoked_at).toBeNull();

    const [auditCount] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM audit_log
      WHERE builder_id = ${attackerBuilderId}
        AND action = 'api_key.revoke'
        AND resource_id = ${victimKeyId}
    `;
    expect(auditCount!.count).toBe('0');
  });

  it('an owner can still revoke their own API key (same-tenant happy path)', async () => {
    const request = dashboardDeleteRequest(attackerBuilderId, attackerUserId);
    const response = await deleteApiKey(request, {
      params: Promise.resolve({ id: ownKeyRowId }),
    });

    expect(response.status).toBe(200);

    const [row] = await sql<{ revoked_at: string | null }[]>`
      SELECT revoked_at FROM api_keys WHERE key_id = ${ownKeyId}
    `;
    expect(row).toBeDefined();
    expect(row!.revoked_at).not.toBeNull();
  });
});
