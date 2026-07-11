// Live (real Postgres) coverage for the API key settings routes and the
// one-universal-key contract (migration 048):
//   - POST mints a universal pv_live_* key from a label-only body; legacy
//     bodies (scope/confirm_email) are ignored and still mint universal.
//   - Hash-only persistence; plaintext appears exactly once, never in GET.
//   - Audit rows on create/revoke carry scope 'universal'.
//   - Member mutations 403.
//   - THE HEADLINE: one route-minted key authenticates every machine route
//     family through the real edge middleware (events, rules, pricing,
//     budget sync, custom pricing, cost sources via BOTH auth headers), and
//     a legacy pv_cli_* key does too. Revocation kills all of it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import argon2 from 'argon2';
import crypto from 'node:crypto';
import postgres from 'postgres';
import { NextRequest } from 'next/server.js';
import { ApiKeyScope, Role, type Role as RoleType } from '@pylva/shared';

import { DELETE as deleteApiKey } from '../../src/app/api/v1/settings/api-keys/[id]/route.js';
import {
  GET as getApiKeys,
  POST as postApiKey,
} from '../../src/app/api/v1/settings/api-keys/route.js';
import { POST as postCostSource } from '../../src/app/api/v1/cost-sources/route.js';
import { middleware } from '../../src/middleware.js';
import { validateApiKey } from '../../src/lib/auth/api-key.js';
import { createApiKey, createTestBuilder } from '../helpers/builder-factory.js';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://pylva:pylva_dev@localhost:5432/pylva';
const ARGON2_SECRET = process.env['ARGON2_SECRET'] ?? 'dev-secret-change-in-prod';

interface CreateApiKeyResponseBody {
  key: {
    key_id: string;
    plaintext: string;
    scope: string;
    label: string | null;
  };
}

interface ListApiKeysResponseBody {
  keys: Array<{
    id: string;
    key_id: string;
    scope: string;
    label: string | null;
    created_at: string;
    expires_at: string | null;
    revoked_at: string | null;
  }>;
}

interface ApiKeyRow {
  id: string;
  key_hash: string;
  scope: string;
  label: string | null;
  revoked_at: string | null;
}

interface AuditRow {
  builder_id: string;
  actor_id: string;
  actor_user_id: string | null;
  action: string;
  resource_id: string | null;
  details: unknown;
}

let sql: ReturnType<typeof postgres>;
let builderId = '';
let otherBuilderId = '';
let ownerUserId = '';
let memberUserId = '';
let ownerEmail = '';
let memberEmail = '';

function detailsRecord(details: unknown): Record<string, unknown> {
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    return details as Record<string, unknown>;
  }
  return {};
}

function dashboardRequest(args: {
  method?: string;
  body?: unknown;
  builderId?: string;
  userId?: string;
  role?: RoleType;
}): NextRequest {
  const headers: Record<string, string> = {
    'x-builder-id': args.builderId ?? builderId,
    'x-user-id': args.userId ?? ownerUserId,
    'x-user-role': args.role ?? Role.OWNER,
  };
  const init: ConstructorParameters<typeof NextRequest>[1] = {
    method: args.method ?? 'GET',
    headers,
  };
  if (args.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(args.body);
  }
  return new NextRequest('http://localhost/api/v1/settings/api-keys', init);
}

async function createKeyViaRoute(
  args: { label?: string; body?: Record<string, unknown> } = {},
): Promise<CreateApiKeyResponseBody> {
  const body: Record<string, unknown> = args.body ?? {};
  if (args.label !== undefined) body['label'] = args.label;

  const response = await postApiKey(
    dashboardRequest({
      method: 'POST',
      body,
    }),
  );
  expect(response.status).toBe(201);
  return (await response.json()) as CreateApiKeyResponseBody;
}

async function keyRow(keyId: string): Promise<ApiKeyRow> {
  const [row] = await sql<ApiKeyRow[]>`
    SELECT id, key_hash, scope, label, revoked_at
    FROM api_keys
    WHERE key_id = ${keyId}
  `;
  expect(row).toBeDefined();
  return row!;
}

/**
 * Drive the REAL edge middleware with a machine request and return the
 * trusted context it forwards to the handler (or null on auth failure).
 * Next encodes forwarded request headers as `x-middleware-request-<name>`.
 */
async function middlewareContext(args: {
  path: string;
  method: string;
  headers: Record<string, string>;
}): Promise<{ builderId: string | null; keyId: string | null; status: number }> {
  const response = await middleware(
    new NextRequest(`http://localhost${args.path}`, {
      method: args.method,
      headers: args.headers,
    } as ConstructorParameters<typeof NextRequest>[1]),
  );
  return {
    builderId: response.headers.get('x-middleware-request-x-builder-id'),
    keyId: response.headers.get('x-middleware-request-x-key-id'),
    status: response.status,
  };
}

/** Every machine route family × the auth header each consumer really sends. */
function machineMatrix(key: string): Array<{
  name: string;
  path: string;
  method: string;
  headers: Record<string, string>;
}> {
  return [
    { name: 'events ingest', path: '/api/v1/events', method: 'POST', headers: { 'X-Pylva-Key': key } },
    { name: 'rules fetch', path: '/api/v1/rules', method: 'GET', headers: { 'X-Pylva-Key': key } },
    { name: 'pricing fetch', path: '/api/v1/pricing', method: 'GET', headers: { 'X-Pylva-Key': key } },
    { name: 'budget sync', path: '/api/v1/budget/sync', method: 'POST', headers: { 'X-Pylva-Key': key } },
    { name: 'custom pricing list', path: '/api/v1/custom-pricing', method: 'GET', headers: { authorization: `Bearer ${key}` } },
    { name: 'custom pricing create', path: '/api/v1/custom-pricing', method: 'POST', headers: { authorization: `Bearer ${key}` } },
    { name: 'cost sources via Bearer', path: '/api/v1/cost-sources', method: 'POST', headers: { authorization: `Bearer ${key}` } },
    { name: 'cost sources via X-Pylva-Key', path: '/api/v1/cost-sources', method: 'POST', headers: { 'X-Pylva-Key': key } },
  ];
}

beforeAll(async () => {
  sql = postgres(DATABASE_URL);
  const suffix = crypto.randomBytes(6).toString('hex');
  ownerEmail = `settings-owner-${suffix}@test.com`;
  memberEmail = `settings-member-${suffix}@test.com`;

  builderId = (await createTestBuilder({ sql })).id;
  otherBuilderId = (await createTestBuilder({ sql })).id;

  const [owner] = await sql<{ id: string }[]>`
    INSERT INTO users (email, auth_provider)
    VALUES (${ownerEmail}, 'magic_link')
    RETURNING id
  `;
  ownerUserId = owner!.id;

  const [member] = await sql<{ id: string }[]>`
    INSERT INTO users (email, auth_provider)
    VALUES (${memberEmail}, 'magic_link')
    RETURNING id
  `;
  memberUserId = member!.id;

  await sql`
    INSERT INTO user_builder_memberships (user_id, builder_id, role)
    VALUES
      (${ownerUserId}, ${builderId}, 'owner'),
      (${memberUserId}, ${builderId}, 'member')
  `;
});

afterAll(async () => {
  if (!sql) return;
  await sql`DELETE FROM cost_sources WHERE builder_id IN (${builderId}, ${otherBuilderId})`;
  await sql`DELETE FROM audit_log WHERE builder_id IN (${builderId}, ${otherBuilderId})`;
  await sql`DELETE FROM user_builder_memberships WHERE builder_id IN (${builderId}, ${otherBuilderId})`;
  await sql`DELETE FROM api_keys WHERE builder_id IN (${builderId}, ${otherBuilderId})`;
  await sql`DELETE FROM users WHERE id IN (${ownerUserId}, ${memberUserId})`;
  await sql`DELETE FROM builders WHERE id IN (${builderId}, ${otherBuilderId})`;
  await sql.end();
});

describe('POST /api/v1/settings/api-keys live persistence', () => {
  it('creates a universal pv_live key with hash-only persistence', async () => {
    const body = await createKeyViaRoute({ label: 'Production SDK' });

    expect(body.key.scope).toBe(ApiKeyScope.UNIVERSAL);
    expect(body.key.label).toBe('Production SDK');
    expect(body.key.plaintext).toMatch(/^pv_live_[a-f0-9]{8}_[a-f0-9]{32}$/);
    expect(body.key.plaintext).toContain(`_${body.key.key_id}_`);

    const row = await keyRow(body.key.key_id);
    expect(row.scope).toBe(ApiKeyScope.UNIVERSAL);
    expect(row.label).toBe('Production SDK');
    expect(row.key_hash).toMatch(/^\$argon2/);
    expect(row.key_hash).not.toBe(body.key.plaintext);
    expect(row.key_hash).not.toContain(body.key.plaintext);
    await expect(
      argon2.verify(row.key_hash, body.key.plaintext, {
        secret: Buffer.from(ARGON2_SECRET),
      }),
    ).resolves.toBe(true);

    const listResponse = await getApiKeys(dashboardRequest({}));
    expect(listResponse.status).toBe(200);
    const listText = JSON.stringify(await listResponse.json());
    expect(listText).not.toContain(body.key.plaintext);
    expect(listText).not.toContain(row.key_hash);
    expect(listText).not.toContain('key_hash');
    expect(listText).not.toContain('plaintext');
  });

  it.each([
    [{ scope: 'agent_sdk' }],
    [{ scope: 'admin_api' }],
    [{ scope: 'data_import', label: 'importer' }],
    [{ scope: 'admin_api', confirm_email: 'anything@example.com' }],
  ])('ignores the legacy body %j and still mints a universal key', async (legacyBody) => {
    const body = await createKeyViaRoute({ body: { ...legacyBody } });

    expect(body.key.scope).toBe(ApiKeyScope.UNIVERSAL);
    expect(body.key.plaintext).toMatch(/^pv_live_/);
    const row = await keyRow(body.key.key_id);
    expect(row.scope).toBe(ApiKeyScope.UNIVERSAL);
  });

  it('writes an audit log row carrying actor user_id and scope universal on create', async () => {
    const body = await createKeyViaRoute({ label: 'Audit create' });

    const [row] = await sql<AuditRow[]>`
      SELECT builder_id, actor_id, actor_user_id, action, resource_id, details
      FROM audit_log
      WHERE builder_id = ${builderId}
        AND action = 'api_key.create'
        AND resource_id = ${body.key.key_id}
      ORDER BY id DESC
      LIMIT 1
    `;

    expect(row).toMatchObject({
      builder_id: builderId,
      actor_id: ownerUserId,
      actor_user_id: ownerUserId,
      action: 'api_key.create',
      resource_id: body.key.key_id,
    });
    expect(detailsRecord(row!.details)).toMatchObject({
      scope: ApiKeyScope.UNIVERSAL,
      label: 'Audit create',
    });
  });
});

describe('GET /api/v1/settings/api-keys live listing', () => {
  it("returns only this builder's keys and never exposes hashes or plaintext", async () => {
    const own = await createKeyViaRoute({ label: 'Own listed key' });
    const other = await createApiKey(otherBuilderId, 'universal', { sql, label: 'Other key' });

    const response = await getApiKeys(dashboardRequest({}));
    expect(response.status).toBe(200);
    const body = (await response.json()) as ListApiKeysResponseBody;
    const keyIds = body.keys.map((key) => key.key_id);

    expect(keyIds).toContain(own.key.key_id);
    expect(keyIds).not.toContain(other.keyId);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(other.plaintextKey);
    expect(serialized).not.toContain('key_hash');
    expect(serialized).not.toContain('plaintext');
  });
});

describe('role enforcement', () => {
  it('returns 403 for member create and revoke attempts while owner requests are allowed', async () => {
    const memberCreate = await postApiKey(
      dashboardRequest({
        method: 'POST',
        role: Role.MEMBER,
        userId: memberUserId,
        body: {},
      }),
    );
    expect(memberCreate.status).toBe(403);

    const ownerCreate = await createKeyViaRoute({ label: 'Owner allowed' });
    const row = await keyRow(ownerCreate.key.key_id);

    const memberRevoke = await deleteApiKey(
      dashboardRequest({ method: 'DELETE', role: Role.MEMBER, userId: memberUserId }),
      { params: Promise.resolve({ id: row.id }) },
    );
    expect(memberRevoke.status).toBe(403);
    expect((await keyRow(ownerCreate.key.key_id)).revoked_at).toBeNull();

    const ownerRevoke = await deleteApiKey(dashboardRequest({ method: 'DELETE' }), {
      params: Promise.resolve({ id: row.id }),
    });
    expect(ownerRevoke.status).toBe(200);
  });
});

describe('one key drives every machine route family (via real middleware)', () => {
  it('a route-minted universal key authenticates all consumers and dies on revoke', async () => {
    const created = await createKeyViaRoute({ label: 'Matrix key' });
    const key = created.key.plaintext;

    for (const entry of machineMatrix(key)) {
      const ctx = await middlewareContext(entry);
      expect(ctx.builderId, `${entry.name} should authenticate`).toBe(builderId);
      expect(ctx.keyId, `${entry.name} should carry the key id`).toBe(created.key.key_id);
    }

    // Full-handler proof for the one machine route that only needs Postgres:
    // cost-sources POST accepts the middleware-forwarded machine context.
    const slug = `matrix-${crypto.randomBytes(4).toString('hex')}`;
    const handlerResponse = await postCostSource(
      new Request('http://localhost/api/v1/cost-sources', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-builder-id': builderId,
          'x-key-id': created.key.key_id,
        },
        body: JSON.stringify({
          display_name: 'Matrix Source',
          slug,
          source_type: 'non_llm_manual',
          metric: 'matrix_requests',
          unit: 'request',
          price_per_unit: 0.1,
        }),
      }) as unknown as NextRequest,
    );
    expect(handlerResponse.status).toBe(201);

    // Revoke → the same matrix is dead everywhere.
    const row = await keyRow(created.key.key_id);
    const revoke = await deleteApiKey(dashboardRequest({ method: 'DELETE' }), {
      params: Promise.resolve({ id: row.id }),
    });
    expect(revoke.status).toBe(200);

    for (const entry of machineMatrix(key)) {
      const ctx = await middlewareContext(entry);
      expect(ctx.status, `${entry.name} should reject a revoked key`).toBe(401);
      expect(ctx.builderId).toBeNull();
    }
  });

  it('a legacy pv_cli data_import key (pre-048 straggler row) also drives every consumer', async () => {
    const legacy = await createApiKey(builderId, 'data_import', { sql, label: 'Legacy CLI key' });
    expect(legacy.plaintextKey).toMatch(/^pv_cli_/);

    for (const entry of machineMatrix(legacy.plaintextKey)) {
      const ctx = await middlewareContext(entry);
      expect(ctx.builderId, `${entry.name} should authenticate the legacy key`).toBe(builderId);
      expect(ctx.keyId).toBe(legacy.keyId);
    }
  });

  it('rejects a well-formed but unknown key on every route family', async () => {
    const ghost = `pv_live_${crypto.randomBytes(4).toString('hex')}_${crypto
      .randomBytes(16)
      .toString('hex')}`;

    for (const entry of machineMatrix(ghost)) {
      const ctx = await middlewareContext(entry);
      expect(ctx.status, `${entry.name} should 401 an unknown key`).toBe(401);
    }
  });
});

describe('DELETE /api/v1/settings/api-keys/[id] live revoke', () => {
  it('revokes an own key, removes it from active listings, invalidates auth, and audits the write', async () => {
    const created = await createKeyViaRoute({ label: 'Revoke me' });
    const row = await keyRow(created.key.key_id);

    await expect(validateApiKey(created.key.plaintext)).resolves.toMatchObject({
      builderId,
      scope: ApiKeyScope.UNIVERSAL,
      keyId: created.key.key_id,
    });

    const response = await deleteApiKey(dashboardRequest({ method: 'DELETE' }), {
      params: Promise.resolve({ id: row.id }),
    });
    expect(response.status).toBe(200);

    await expect(validateApiKey(created.key.plaintext)).resolves.toBeNull();

    const listResponse = await getApiKeys(dashboardRequest({}));
    expect(listResponse.status).toBe(200);
    const listBody = (await listResponse.json()) as ListApiKeysResponseBody;
    expect(listBody.keys.map((key) => key.key_id)).not.toContain(created.key.key_id);

    const [auditRow] = await sql<AuditRow[]>`
      SELECT builder_id, actor_id, actor_user_id, action, resource_id, details
      FROM audit_log
      WHERE builder_id = ${builderId}
        AND action = 'api_key.revoke'
        AND resource_id = ${created.key.key_id}
      ORDER BY id DESC
      LIMIT 1
    `;

    expect(auditRow).toMatchObject({
      builder_id: builderId,
      actor_id: ownerUserId,
      actor_user_id: ownerUserId,
      action: 'api_key.revoke',
      resource_id: created.key.key_id,
    });
    expect(detailsRecord(auditRow!.details)).toMatchObject({ scope: ApiKeyScope.UNIVERSAL });
  });

  it('returns 404 for a nonexistent row id', async () => {
    const response = await deleteApiKey(dashboardRequest({ method: 'DELETE' }), {
      params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000000' }),
    });

    expect(response.status).toBe(404);
  });
});
