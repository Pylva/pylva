// Tenant isolation tests — B0 security verification
// These tests require Docker services (PostgreSQL, ClickHouse, Redis) running
// Excluded from fast CI, included in integration CI

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import argon2 from 'argon2';
import crypto from 'node:crypto';
import { ensureRlsTestRole, rlsDatabaseUrl } from '../helpers/rls-test-role.js';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://pylva:pylva_dev@localhost:5432/pylva';
const TEST_DATABASE_URL = process.env['PYLVA_TEST_DATABASE_URL'] ?? DATABASE_URL;
const ARGON2_SECRET = process.env['ARGON2_SECRET'] ?? 'dev-secret-change-in-prod';

let adminSql: ReturnType<typeof postgres> | undefined;
let rlsSql: ReturnType<typeof postgres> | undefined;
let builderAId = '';
let builderBId = '';

beforeAll(async () => {
  adminSql = postgres(TEST_DATABASE_URL);
  await ensureRlsTestRole(adminSql);
  rlsSql = postgres(rlsDatabaseUrl(TEST_DATABASE_URL));

  // Create test builders
  const [a] = await adminSql!`
    INSERT INTO builders (email, name, tier, slug)
    VALUES ('test-isolation-a@test.com', 'Isolation Test A', 'free', 'isolation-test-a')
    ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, tier = EXCLUDED.tier, slug = EXCLUDED.slug
    RETURNING id
  `;
  builderAId = a!.id as string;

  const [b] = await adminSql!`
    INSERT INTO builders (email, name, tier, slug)
    VALUES ('test-isolation-b@test.com', 'Isolation Test B', 'free', 'isolation-test-b')
    ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, tier = EXCLUDED.tier, slug = EXCLUDED.slug
    RETURNING id
  `;
  builderBId = b!.id as string;
});

afterAll(async () => {
  if (adminSql && builderAId && builderBId) {
    await adminSql!`DELETE FROM anomaly_events WHERE builder_id IN (${builderAId}, ${builderBId})`;
    await adminSql!`DELETE FROM rules WHERE builder_id IN (${builderAId}, ${builderBId})`;
    await adminSql!`DELETE FROM customers WHERE builder_id IN (${builderAId}, ${builderBId})`;
    await adminSql!`DELETE FROM api_keys WHERE builder_id IN (${builderAId}, ${builderBId})`;
    await adminSql!`DELETE FROM builders WHERE id IN (${builderAId}, ${builderBId})`;
  }
  await rlsSql?.end();
  await adminSql?.end();
});

describe('RLS: Tenant Isolation', () => {
  it('Builder A can insert and read their own customers', async () => {
    await rlsSql!.begin(async (tx) => {
      await tx`SELECT set_config('app.builder_id', ${builderAId}, true)`;
      await tx`
        INSERT INTO customers (builder_id, external_id, name)
        VALUES (${builderAId}, 'rls-test-cust-a1', 'RLS Test Customer A1')
        ON CONFLICT (builder_id, external_id) DO NOTHING
      `;
      const rows = await tx`SELECT * FROM customers WHERE external_id = 'rls-test-cust-a1'`;
      expect(rows.length).toBe(1);
      expect(rows[0]!.builder_id).toBe(builderAId);
    });
  });

  it('Builder B cannot read Builder A customers via RLS', async () => {
    await rlsSql!.begin(async (tx) => {
      await tx`SELECT set_config('app.builder_id', ${builderBId}, true)`;
      const rows = await tx`SELECT * FROM customers WHERE external_id = 'rls-test-cust-a1'`;
      expect(rows.length).toBe(0);
    });
  });

  it('Builder B cannot update Builder A customers via RLS', async () => {
    await rlsSql!.begin(async (tx) => {
      await tx`SELECT set_config('app.builder_id', ${builderBId}, true)`;
      const result = await tx`
        UPDATE customers SET name = 'HACKED' WHERE external_id = 'rls-test-cust-a1'
      `;
      expect(result.count).toBe(0);
    });

    // Verify the customer was NOT modified
    await rlsSql!.begin(async (tx) => {
      await tx`SELECT set_config('app.builder_id', ${builderAId}, true)`;
      const rows = await tx`SELECT name FROM customers WHERE external_id = 'rls-test-cust-a1'`;
      expect(rows[0]!.name).toBe('RLS Test Customer A1');
    });
  });

  it('Builder B cannot delete Builder A customers via RLS', async () => {
    await rlsSql!.begin(async (tx) => {
      await tx`SELECT set_config('app.builder_id', ${builderBId}, true)`;
      const result = await tx`
        DELETE FROM customers WHERE external_id = 'rls-test-cust-a1'
      `;
      expect(result.count).toBe(0);
    });
  });

  it('RLS isolates rules per builder', async () => {
    // Create a rule for Builder A
    await rlsSql!.begin(async (tx) => {
      await tx`SELECT set_config('app.builder_id', ${builderAId}, true)`;
      await tx`
        INSERT INTO rules (builder_id, type, enforcement, name, config)
        VALUES (${builderAId}, 'cost_threshold', 'post_call', 'RLS Test Rule', '{}')
      `;
      const rows = await tx`SELECT * FROM rules WHERE name = 'RLS Test Rule'`;
      expect(rows.length).toBe(1);
    });

    // Builder B cannot see it
    await rlsSql!.begin(async (tx) => {
      await tx`SELECT set_config('app.builder_id', ${builderBId}, true)`;
      const rows = await tx`SELECT * FROM rules WHERE name = 'RLS Test Rule'`;
      expect(rows.length).toBe(0);
    });
  });

  it('RLS isolates anomaly_events per builder (B4-4b → B4-8 sweep)', async () => {
    // Insert an OPEN anomaly for Builder A; verify B cannot read,
    // update, or dismiss it via RLS.
    await rlsSql!.begin(async (tx) => {
      await tx`SELECT set_config('app.builder_id', ${builderAId}, true)`;
      await tx`
        INSERT INTO anomaly_events (
          builder_id, customer_id, source_type, status, severity,
          period_start, period_end, actual_value, baseline_value, delta_pct,
          diagnosis, recommendation
        )
        VALUES (
          ${builderAId}, 'rls-cust-iso', 'cost_spike', 'open', 'warn',
          NOW() - interval '1 day', NOW(), 120, 100, 20,
          ${'{"insufficient_revenue_data": true}'}::jsonb,
          ${'{"action": "investigate_deep_link"}'}::jsonb
        )
      `;
      const rows = await tx`SELECT id FROM anomaly_events WHERE customer_id = 'rls-cust-iso'`;
      expect(rows.length).toBe(1);
    });

    // Builder B cannot SELECT.
    await rlsSql!.begin(async (tx) => {
      await tx`SELECT set_config('app.builder_id', ${builderBId}, true)`;
      const rows = await tx`SELECT * FROM anomaly_events WHERE customer_id = 'rls-cust-iso'`;
      expect(rows.length).toBe(0);
    });

    // Builder B cannot UPDATE (e.g. attempt to dismiss).
    await rlsSql!.begin(async (tx) => {
      await tx`SELECT set_config('app.builder_id', ${builderBId}, true)`;
      const result = await tx`
        UPDATE anomaly_events SET status = 'dismissed', dismissed_at = NOW()
        WHERE customer_id = 'rls-cust-iso'
      `;
      expect(result.count).toBe(0);
    });

    // Confirm Builder A's row is unchanged (still OPEN).
    await rlsSql!.begin(async (tx) => {
      await tx`SELECT set_config('app.builder_id', ${builderAId}, true)`;
      const rows = await tx`SELECT status FROM anomaly_events WHERE customer_id = 'rls-cust-iso'`;
      expect(rows[0]!.status).toBe('open');
    });
  });

  it('RLS isolates API keys per builder', async () => {
    const keyId = crypto.randomBytes(4).toString('hex');
    const keyHash = await argon2.hash(`pv_live_${keyId}_test`, {
      secret: Buffer.from(ARGON2_SECRET),
    });

    await rlsSql!.begin(async (tx) => {
      await tx`SELECT set_config('app.builder_id', ${builderAId}, true)`;
      await tx`
        INSERT INTO api_keys (key_id, builder_id, key_hash, scope)
        VALUES (${keyId}, ${builderAId}, ${keyHash}, 'agent_sdk')
      `;
    });

    // Builder B cannot see Builder A's keys
    await rlsSql!.begin(async (tx) => {
      await tx`SELECT set_config('app.builder_id', ${builderBId}, true)`;
      const rows = await tx`SELECT * FROM api_keys WHERE key_id = ${keyId}`;
      expect(rows.length).toBe(0);
    });
  });

  it('users_self policy scopes users to members of the current builder (migration 046 fix)', async () => {
    // Before 046 this policy keyed on app.user_id (never set), so a non-owner
    // role saw zero users. It now scopes through user_builder_memberships.
    const email = `rls-user-${crypto.randomBytes(4).toString('hex')}@test.com`;
    const [u] = await adminSql!`INSERT INTO users (email) VALUES (${email}) RETURNING id`;
    const userId = u!.id as string;
    await adminSql!`
      INSERT INTO user_builder_memberships (user_id, builder_id, role)
      VALUES (${userId}, ${builderAId}, 'owner')
    `;

    try {
      // Builder A (a member) can see the user under RLS.
      await rlsSql!.begin(async (tx) => {
        await tx`SELECT set_config('app.builder_id', ${builderAId}, true)`;
        const rows = await tx`SELECT id FROM users WHERE id = ${userId}`;
        expect(rows.length).toBe(1);
      });
      // Builder B (not a member) cannot.
      await rlsSql!.begin(async (tx) => {
        await tx`SELECT set_config('app.builder_id', ${builderBId}, true)`;
        const rows = await tx`SELECT id FROM users WHERE id = ${userId}`;
        expect(rows.length).toBe(0);
      });
    } finally {
      await adminSql!`DELETE FROM user_builder_memberships WHERE user_id = ${userId}`;
      await adminSql!`DELETE FROM users WHERE id = ${userId}`;
    }
  });

  it('rejects a cross-tenant write (WITH CHECK) — B cannot insert a row owned by A', async () => {
    // The failing INSERT aborts the transaction, so assert the whole begin()
    // block rejects with the RLS violation (postgres.js surfaces it on commit).
    await expect(
      rlsSql!.begin(async (tx) => {
        await tx`SELECT set_config('app.builder_id', ${builderBId}, true)`;
        await tx`
          INSERT INTO customers (builder_id, external_id, name)
          VALUES (${builderAId}, 'rls-crosswrite', 'should be rejected')
        `;
      }),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe('Audit Log', () => {
  it('captures audit entries in the partitioned table', async () => {
    await adminSql!`
      INSERT INTO audit_log (builder_id, actor_type, actor_id, action, resource_type, resource_id)
      VALUES (${builderAId}, 'system', 'test', 'create', 'customer', 'test-cust-id')
    `;

    const rows = await adminSql!`
      SELECT * FROM audit_log WHERE builder_id = ${builderAId} AND action = 'create' AND resource_id = 'test-cust-id'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.actor_type).toBe('system');
  });
});
