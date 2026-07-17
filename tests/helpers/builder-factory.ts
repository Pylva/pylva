// Test helper: create fresh builders + API keys + RLS-scoped transactions.
// Lifts boilerplate out of individual test files so the security tests and the
// upcoming B1 integration tests stay focused on behavior, not setup plumbing.
//
// Every helper acquires its own `postgres` handle via DATABASE_URL (dev default
// when not set). Callers are responsible for calling `sql.end()` at teardown
// if they stash the handle; the factory functions open and close within a
// single operation otherwise.

import argon2 from 'argon2';
import crypto from 'node:crypto';
import postgres, { type Sql } from 'postgres';

const DATABASE_URL =
  process.env['PYLVA_TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgresql://pylva:pylva_dev@localhost:5432/pylva';

const ARGON2_SECRET = process.env['ARGON2_SECRET'] ?? 'dev-secret-change-in-prod';

// 'universal' is the only scope minted since migration 048; the legacy values
// remain insertable (straggler-tolerance coverage in the security tests).
export type TestApiKeyScope = 'universal' | 'agent_sdk' | 'admin_api' | 'data_import';

export interface TestBuilder {
  id: string;
  email: string;
  slug: string;
  tier: 'free' | 'pro' | 'scale' | 'enterprise';
}

export interface TestApiKey {
  keyId: string;
  plaintextKey: string;
  hash: string;
  scope: TestApiKeyScope;
  builderId: string;
}

/**
 * Returns a shared postgres handle. Tests that want to reuse a handle across
 * calls can pass it as the `sql` argument to each helper; otherwise each
 * helper opens and tears down its own connection.
 */
export function getSql(): Sql {
  return postgres(DATABASE_URL);
}

/**
 * Create a fresh builder with a randomized email so tests can run in parallel
 * against the same DB without UNIQUE(email) collisions.
 */
export async function createTestBuilder(
  args: { tier?: TestBuilder['tier']; sql?: Sql } = {},
): Promise<TestBuilder> {
  const sql = args.sql ?? getSql();
  const suffix = crypto.randomBytes(6).toString('hex');
  const email = `test-${suffix}@example.com`;
  const slug = `test-builder-${suffix}`;
  const tier = args.tier ?? 'free';

  const [row] = await sql<{ id: string }[]>`
    INSERT INTO builders (email, name, tier, slug)
    VALUES (${email}, ${`Test Builder ${suffix}`}, ${tier}, ${slug})
    RETURNING id
  `;

  if (!args.sql) await sql.end();

  return { id: row!.id, email, slug, tier };
}

/**
 * Create an API key for a builder. Returns the plaintext key (callers typically
 * want this to hit the SDK path) plus the key_id (for DB assertions).
 */
export async function createApiKey(
  builderId: string,
  scope: TestApiKeyScope,
  args: { sql?: Sql; label?: string } = {},
): Promise<TestApiKey> {
  const sql = args.sql ?? getSql();
  const keyId = crypto.randomBytes(4).toString('hex'); // 8 hex chars
  const randomPart = crypto.randomBytes(16).toString('hex'); // 32 hex chars
  // Legacy data-import keys used the pv_cli_ prefix; everything else (incl.
  // the universal keys minted since 048) is pv_live_. Matches
  // src/lib/auth/api-key.ts.
  const prefix = scope === 'data_import' ? 'pv_cli' : 'pv_live';
  const plaintextKey = `${prefix}_${keyId}_${randomPart}`;
  const hash = await argon2.hash(plaintextKey, { secret: Buffer.from(ARGON2_SECRET) });

  await sql`
    INSERT INTO api_keys (key_id, builder_id, key_hash, scope, label)
    VALUES (${keyId}, ${builderId}, ${hash}, ${scope}, ${args.label ?? null})
  `;

  if (!args.sql) await sql.end();

  return { keyId, plaintextKey, hash, scope, builderId };
}

/**
 * Run a block inside an RLS-scoped transaction. Mirrors the production
 * `withRLS()` helper but uses a raw postgres handle (tests don't pull in Drizzle).
 * Returns the block's value; commits on success, rolls back on throw.
 */
export async function rlsTx<T>(
  builderId: string,
  block: (sql: Sql) => Promise<T>,
  args: { sql?: Sql } = {},
): Promise<T> {
  const sql = args.sql ?? getSql();
  try {
    const result = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.builder_id', ${builderId}, true)`;
      return block(tx as unknown as Sql);
    });
    return result as T;
  } finally {
    if (!args.sql) await sql.end();
  }
}

/**
 * Utility: drop all test-created rows for a builder (best-effort cleanup).
 * Leaves builders with non-test emails intact.
 */
export async function cleanupTestBuilder(
  builderId: string,
  args: { sql?: Sql } = {},
): Promise<void> {
  const sql = args.sql ?? getSql();
  // ON DELETE CASCADE cleans up api_keys, customers, rules, webhook_configs, etc.
  await sql`DELETE FROM builders WHERE id = ${builderId}`;
  if (!args.sql) await sql.end();
}
