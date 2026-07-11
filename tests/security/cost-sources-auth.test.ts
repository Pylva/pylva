// B3-T4a — cost-sources API auth tests.
//
// Runs under `pnpm test:integration` (hits real Postgres).
// Verifies that:
//   1. The `api_keys.scope` CHECK constraint accepts 'universal' (the only
//      scope minted since migration 048) plus the legacy values, which stay
//      insertable as previous-release straggler tolerance.
//   2. Prefixes: universal keys mint pv_live_*; legacy pv_cli_* fixtures
//      remain representable.
//   3. RLS on cost_sources blocks cross-builder reads.
//   4. onConflictDoNothing keeps the CLI rerun idempotent.
//   5. The POST machine path stays ungated for API-key callers.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import crypto from 'node:crypto';
import argon2 from 'argon2';
import {
  createApiKey,
  createTestBuilder,
  getSql,
  type TestApiKey,
} from '../helpers/builder-factory.js';
import { ensureRlsTestRole, rlsDatabaseUrl } from '../helpers/rls-test-role.js';
import { POST } from '../../src/app/api/v1/cost-sources/route.js';

const ARGON2_SECRET = process.env['ARGON2_SECRET'] ?? 'dev-secret-change-in-prod';

let sql: ReturnType<typeof postgres> | undefined;
let rlsSql: ReturnType<typeof postgres> | undefined;
let builderAId = '';
let builderBId = '';

async function insertApiKey(builderId: string, scope: TestApiKey['scope']): Promise<TestApiKey> {
  return createApiKey(builderId, scope, { sql: sql!, label: 'audit-test' });
}

function uniqueSlug(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
}

function costSourcePayload(slug: string) {
  return {
    display_name: 'ElevenLabs',
    slug,
    source_type: 'non_llm_manual',
    metric: 'elevenlabs_tokens',
    unit: 'token',
    price_per_unit: 0.1,
  };
}

function postCostSource(builderId: string, slug: string, headers: Record<string, string>) {
  return POST(
    new Request('http://localhost/api/v1/cost-sources', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-builder-id': builderId,
        ...headers,
      },
      body: JSON.stringify(costSourcePayload(slug)),
    }) as unknown as import('next/server.js').NextRequest,
  );
}

async function costSourceCount(builderId: string, slug: string): Promise<number> {
  const [row] = await sql!<{ count: string }[]>`
    SELECT COUNT(*)::text AS count
    FROM cost_sources
    WHERE builder_id = ${builderId} AND slug = ${slug}
  `;
  return Number(row!.count);
}

beforeAll(async () => {
  sql = getSql();
  await ensureRlsTestRole(sql);
  rlsSql = postgres(
    rlsDatabaseUrl(
      process.env['DATABASE_URL'] ??
        'postgresql://pylva:pylva_dev@localhost:5432/pylva',
    ),
  );
  builderAId = (await createTestBuilder({ sql: sql! })).id;
  builderBId = (await createTestBuilder({ sql: sql! })).id;
});

afterAll(async () => {
  if (sql && builderAId && builderBId) {
    await sql!`DELETE FROM cost_sources WHERE builder_id IN (${builderAId}, ${builderBId})`;
    await sql!`DELETE FROM api_keys WHERE builder_id IN (${builderAId}, ${builderBId})`;
    await sql!`DELETE FROM builders WHERE id IN (${builderAId}, ${builderBId})`;
  }
  await rlsSql?.end();
  await sql?.end();
});

describe('api_keys.scope constraint (migrations 041 + 048)', () => {
  it('accepts scope=universal (the only scope minted since migration 048)', async () => {
    const key = await insertApiKey(builderAId, 'universal');
    const [row] = await sql!<{ scope: string }[]>`
      SELECT scope FROM api_keys WHERE key_id = ${key.keyId}
    `;
    expect(row!.scope).toBe('universal');
  });

  it('keeps legacy scopes insertable (previous-release straggler tolerance)', async () => {
    const dataImport = await insertApiKey(builderAId, 'data_import');
    const agent = await insertApiKey(builderAId, 'agent_sdk');
    const admin = await insertApiKey(builderAId, 'admin_api');
    const rows = await sql!<{ scope: string }[]>`
      SELECT scope FROM api_keys
      WHERE key_id IN (${dataImport.keyId}, ${agent.keyId}, ${admin.keyId})
      ORDER BY scope
    `;
    expect(rows.map((r) => r.scope)).toEqual(['admin_api', 'agent_sdk', 'data_import']);
  });

  it('rejects an unknown scope at the DB layer', async () => {
    const keyId = crypto.randomBytes(4).toString('hex');
    const plaintext = `pv_live_${keyId}_${'a'.repeat(32)}`;
    const hash = await argon2.hash(plaintext, { secret: Buffer.from(ARGON2_SECRET) });
    await expect(
      sql!`
        INSERT INTO api_keys (key_id, builder_id, key_hash, scope, label)
        VALUES (${keyId}, ${builderAId}, ${hash}, 'not_a_scope', 'audit-test')
      `,
    ).rejects.toThrow(/api_keys_scope_check/);
  });
});

describe('api_keys prefix vs scope mapping', () => {
  it('universal keys mint with the pv_live_ prefix', async () => {
    const key = await insertApiKey(builderAId, 'universal');
    expect(key.plaintextKey).toMatch(/^pv_live_/);
    expect(key.scope).toBe('universal');
  });

  it('legacy pv_cli_* data_import fixtures remain representable', async () => {
    const key = await insertApiKey(builderAId, 'data_import');
    expect(key.plaintextKey).toMatch(/^pv_cli_/);
    expect(key.scope).toBe('data_import');
  });
});

describe('cost_sources RLS', () => {
  it('allows a builder to insert + read their own row', async () => {
    await rlsSql!.begin(async (tx) => {
      await tx`SELECT set_config('app.builder_id', ${builderAId}, true)`;
      await tx`
        INSERT INTO cost_sources (builder_id, source_type, display_name, slug)
        VALUES (${builderAId}, 'non_llm_manual', 'Builder A ElevenLabs', 'elevenlabs')
      `;
      const rows = await tx`SELECT * FROM cost_sources WHERE slug = 'elevenlabs'`;
      expect(rows.length).toBe(1);
    });
  });

  it('hides Builder A rows from Builder B (RLS policy USING)', async () => {
    await rlsSql!.begin(async (tx) => {
      await tx`SELECT set_config('app.builder_id', ${builderBId}, true)`;
      const rows = await tx`SELECT * FROM cost_sources WHERE slug = 'elevenlabs'`;
      expect(rows.length).toBe(0);
    });
  });

  it('ON CONFLICT (builder_id, slug) DO NOTHING is idempotent', async () => {
    await rlsSql!.begin(async (tx) => {
      await tx`SELECT set_config('app.builder_id', ${builderAId}, true)`;
      const result = await tx`
        INSERT INTO cost_sources (builder_id, source_type, display_name, slug)
        VALUES (${builderAId}, 'non_llm_manual', 'Builder A ElevenLabs retry', 'elevenlabs')
        ON CONFLICT (builder_id, slug) DO NOTHING
      `;
      expect(result.count).toBe(0); // conflict path
      const rows = await tx`SELECT display_name FROM cost_sources WHERE slug = 'elevenlabs'`;
      // Existing row was NOT overwritten.
      expect(rows[0]!.display_name).toBe('Builder A ElevenLabs');
    });
  });
});

describe('POST /api/v1/cost-sources dashboard role gate', () => {
  it('rejects Member dashboard callers before inserting a priced cost source', async () => {
    const slug = uniqueSlug('member-denied');

    const response = await postCostSource(builderAId, slug, {
      'x-user-id': 'member-user',
      'x-user-role': 'member',
    });

    expect(response.status).toBe(403);
    expect(await costSourceCount(builderAId, slug)).toBe(0);
  });

  it('allows Owner dashboard callers to insert a priced cost source', async () => {
    const slug = uniqueSlug('owner-allowed');

    const response = await postCostSource(builderAId, slug, {
      'x-user-id': 'owner-user',
      'x-user-role': 'owner',
    });

    expect(response.status).toBe(201);
    expect(await costSourceCount(builderAId, slug)).toBe(1);
  });

  it('allows API-key machine callers without user role headers', async () => {
    const slug = uniqueSlug('data-import');

    const response = await postCostSource(builderAId, slug, {
      'x-key-id': 'cli-key-1',
    });

    expect(response.status).toBe(201);
    expect(await costSourceCount(builderAId, slug)).toBe(1);
  });
});
