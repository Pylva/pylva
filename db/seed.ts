// Database seed — full test environment
// Decision #24: 3 builders (free/pro/scale), multiple API keys, 10+ customers
// Usage: pnpm db:seed

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import argon2 from 'argon2';
import { createClient } from '@clickhouse/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDirectExecution =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

const SEED_ENV_DEFAULTS = {
  DATABASE_URL: 'postgresql://pylva:pylva_dev@localhost:5432/pylva',
  CLICKHOUSE_URL: 'http://localhost:8123',
  REDIS_URL: 'redis://localhost:6379',
  JWT_PRIVATE_KEY: '.keys/private.pem',
  JWT_PUBLIC_KEY: '.keys/public.pem',
  ARGON2_SECRET: 'dev-secret-change-in-prod',
} as const;

interface SeedKey {
  keyId: string;
  fullKey: string;
  hash: string;
}

export function assertSafeSeedEnvironment(
  environment: Record<string, string | undefined>,
): void {
  if (environment['NODE_ENV'] === 'production') {
    throw new Error('Refusing to seed a production database');
  }
}

function applySeedEnvDefaults(): void {
  for (const [name, value] of Object.entries(SEED_ENV_DEFAULTS)) {
    if (!Object.prototype.hasOwnProperty.call(process.env, name)) {
      process.env[name] = value;
    }
  }
}

// Seed key ids MUST be 8 lowercase hex chars — `validateApiKey` parses
// pv_(live|cli)_{keyId}_{randomPart} with `[a-f0-9]{8}` (src/lib/auth/api-key.ts).
// The old 'ka01'-style ids failed that regex, so seeded keys could never
// authenticate against ingest. Old rows with legacy ids are harmless leftovers.
export const SEED_API_KEY_IDS = {
  alice_agent_sdk: 'aa000001',
  bob_agent_sdk: 'bb000001',
  bob_admin_api: 'bb000002',
  carol_agent_sdk: 'cc000001',
} as const;

async function generateSeedKey(keyId: string, argon2Secret: string): Promise<SeedKey> {
  const randomPart = crypto.randomBytes(16).toString('hex');
  const fullKey = `pv_live_${keyId}_${randomPart}`;
  const hash = await argon2.hash(fullKey, {
    secret: Buffer.from(argon2Secret),
  });
  return { keyId, fullKey, hash };
}

async function seed() {
  assertSafeSeedEnvironment(process.env);
  applySeedEnvDefaults();
  const { env } = await import('../src/lib/config.js');
  const databaseUrl = env.DATABASE_URL;
  const clickhouseUrl = env.CLICKHOUSE_URL;

  const sql = postgres(databaseUrl);
  const ch = createClient({ url: clickhouseUrl });

  console.log('Seeding database...\n');

  // --- Builders ---
  console.log('Creating builders...');
  const [builderA] = await sql`
    INSERT INTO builders (email, name, tier, slug)
    VALUES ('alice@example.com', 'Alice (Free)', 'free', 'alice-free')
    ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, tier = EXCLUDED.tier, slug = EXCLUDED.slug
    RETURNING id
  `;
  const [builderB] = await sql`
    INSERT INTO builders (email, name, tier, slug)
    VALUES ('bob@example.com', 'Bob (Pro)', 'pro', 'bob-pro')
    ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, tier = EXCLUDED.tier, slug = EXCLUDED.slug
    RETURNING id
  `;
  const [builderC] = await sql`
    INSERT INTO builders (email, name, tier, slug)
    VALUES ('carol@example.com', 'Carol (Scale)', 'scale', 'carol-scale')
    ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, tier = EXCLUDED.tier, slug = EXCLUDED.slug
    RETURNING id
  `;
  console.log(`  ✓ Builder A (free): ${builderA!.id}`);
  console.log(`  ✓ Builder B (pro):  ${builderB!.id}`);
  console.log(`  ✓ Builder C (scale): ${builderC!.id}\n`);

  // --- Users + Owner Memberships ---
  console.log('Creating builder owners...');
  const [userA] = await sql`
    INSERT INTO users (email, display_name)
    VALUES ('alice@example.com', 'Alice')
    ON CONFLICT (email) DO UPDATE SET display_name = COALESCE(users.display_name, EXCLUDED.display_name)
    RETURNING id
  `;
  const [userB] = await sql`
    INSERT INTO users (email, display_name)
    VALUES ('bob@example.com', 'Bob')
    ON CONFLICT (email) DO UPDATE SET display_name = COALESCE(users.display_name, EXCLUDED.display_name)
    RETURNING id
  `;
  const [userC] = await sql`
    INSERT INTO users (email, display_name)
    VALUES ('carol@example.com', 'Carol')
    ON CONFLICT (email) DO UPDATE SET display_name = COALESCE(users.display_name, EXCLUDED.display_name)
    RETURNING id
  `;

  await sql`
    INSERT INTO user_builder_memberships (user_id, builder_id, role)
    VALUES
      (${userA!.id}, ${builderA!.id}, 'owner'),
      (${userB!.id}, ${builderB!.id}, 'owner'),
      (${userC!.id}, ${builderC!.id}, 'owner')
    ON CONFLICT (user_id, builder_id) DO NOTHING
  `;
  console.log('  ✓ Owner memberships created\n');

  // --- API Keys ---
  console.log('Creating API keys...');
  const keyA = await generateSeedKey(SEED_API_KEY_IDS.alice_agent_sdk, env.ARGON2_SECRET);
  const keyB1 = await generateSeedKey(SEED_API_KEY_IDS.bob_agent_sdk, env.ARGON2_SECRET);
  const keyB2 = await generateSeedKey(SEED_API_KEY_IDS.bob_admin_api, env.ARGON2_SECRET);
  const keyC = await generateSeedKey(SEED_API_KEY_IDS.carol_agent_sdk, env.ARGON2_SECRET);

  // One universal key (migration 048): every seed key is 'universal'. The
  // SEED_API_KEY_IDS property names keep their historical spelling — they are
  // fixture identifiers referenced by tests.
  await sql`
    INSERT INTO api_keys (key_id, builder_id, key_hash, scope, label)
    VALUES
      (${keyA.keyId}, ${builderA!.id}, ${keyA.hash}, 'universal', 'Alice API key'),
      (${keyB1.keyId}, ${builderB!.id}, ${keyB1.hash}, 'universal', 'Bob API key'),
      (${keyB2.keyId}, ${builderB!.id}, ${keyB2.hash}, 'universal', 'Bob second API key'),
      (${keyC.keyId}, ${builderC!.id}, ${keyC.hash}, 'universal', 'Carol API key')
    ON CONFLICT (key_id) DO NOTHING
  `;
  console.log(`  ✓ Builder A key: ${keyA.fullKey}`);
  console.log(`  ✓ Builder B key: ${keyB1.fullKey}`);
  console.log(`  ✓ Builder B second key: ${keyB2.fullKey}`);
  console.log(`  ✓ Builder C key: ${keyC.fullKey}\n`);

  // --- Customers ---
  console.log('Creating customers...');
  const customerIds: string[] = [];
  const allCustomers = [
    // Builder A: 3 customers (free tier limit = 10)
    { builder_id: builderA!.id, external_id: 'cust_1', name: 'Customer 1' },
    { builder_id: builderA!.id, external_id: 'cust_2', name: 'Customer 2' },
    { builder_id: builderA!.id, external_id: 'cust_3', name: 'Customer 3' },
    // Builder B: 5 customers (pro tier limit = 50)
    { builder_id: builderB!.id, external_id: 'cust_4', name: 'Customer 4' },
    { builder_id: builderB!.id, external_id: 'cust_5', name: 'Customer 5' },
    { builder_id: builderB!.id, external_id: 'cust_6', name: 'Customer 6' },
    { builder_id: builderB!.id, external_id: 'cust_7', name: 'Customer 7' },
    { builder_id: builderB!.id, external_id: 'cust_8', name: 'Customer 8' },
    // Builder C: 10 customers (scale tier limit = 500)
    { builder_id: builderC!.id, external_id: 'cust_9', name: 'Customer 9' },
    { builder_id: builderC!.id, external_id: 'cust_10', name: 'Customer 10' },
    { builder_id: builderC!.id, external_id: 'cust_11', name: 'Customer 11' },
    { builder_id: builderC!.id, external_id: 'cust_12', name: 'Customer 12' },
    { builder_id: builderC!.id, external_id: 'cust_13', name: 'Customer 13' },
    { builder_id: builderC!.id, external_id: 'cust_14', name: 'Customer 14' },
    { builder_id: builderC!.id, external_id: 'cust_15', name: 'Customer 15' },
    { builder_id: builderC!.id, external_id: 'cust_16', name: 'Customer 16' },
    { builder_id: builderC!.id, external_id: 'cust_17', name: 'Customer 17' },
    { builder_id: builderC!.id, external_id: 'cust_18', name: 'Customer 18' },
  ];

  for (const c of allCustomers) {
    const [row] = await sql`
      INSERT INTO customers (builder_id, external_id, name)
      VALUES (${c.builder_id}, ${c.external_id}, ${c.name})
      ON CONFLICT (builder_id, external_id) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `;
    customerIds.push(row!.id as string);
  }
  console.log(`  ✓ ${allCustomers.length} customers created\n`);

  // --- LLM Pricing ---
  console.log('Seeding LLM pricing...');
  const pricingPath = path.join(__dirname, 'seeds', 'llm_pricing_seed.json');
  const pricingData = JSON.parse(fs.readFileSync(pricingPath, 'utf-8')) as Array<{
    provider: string;
    model: string;
    input_per_1m: number;
    output_per_1m: number;
    effective_from: string;
    source: string;
  }>;

  for (const p of pricingData) {
    await sql`
      INSERT INTO llm_pricing (provider, model, input_per_1m, output_per_1m, effective_from, source)
      VALUES (${p.provider}, ${p.model}, ${p.input_per_1m}, ${p.output_per_1m}, ${p.effective_from}, ${p.source})
      ON CONFLICT (provider, model, effective_from) DO NOTHING
    `;
  }
  console.log(`  ✓ ${pricingData.length} pricing entries\n`);

  // --- Sample Rules (Builder B) ---
  console.log('Creating sample rules...');
  await sql`
    INSERT INTO rules (builder_id, type, enforcement, name, config)
    VALUES (${builderB!.id}, 'cost_threshold', 'post_call', 'Daily cost alert',
      ${sql.json({ threshold_usd: 50, period: 'daily', notify: ['webhook'] })})
    ON CONFLICT DO NOTHING
  `;
  console.log('  ✓ Sample cost threshold rule for Builder B\n');

  // --- Sample Webhook (Builder B) ---
  console.log('Creating sample webhook...');
  await sql`
    INSERT INTO webhook_configs (builder_id, url, events, secret)
    VALUES (${builderB!.id}, 'https://example.com/webhook', ${sql.array(['cost.threshold_exceeded', 'budget.exceeded'])}, 'whsec_test_secret')
    ON CONFLICT DO NOTHING
  `;
  console.log('  ✓ Sample webhook for Builder B\n');

  // --- ClickHouse Sample Events ---
  console.log('Inserting ClickHouse sample events...');
  const models = ['gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4-6', 'gemini-2.0-flash'];
  const providers = ['openai', 'openai', 'anthropic', 'google'];
  const events = [];

  const now = new Date();
  for (let i = 0; i < 100; i++) {
    const builderIdx = i < 30 ? 0 : i < 70 ? 1 : 2;
    const builderId = [builderA!.id, builderB!.id, builderC!.id][builderIdx]!;
    const custIdx = i % 5;
    const modelIdx = i % models.length;

    const timestamp = new Date(now.getTime() - (100 - i) * 3600000);
    const tokensIn = Math.floor(Math.random() * 2000) + 100;
    const tokensOut = Math.floor(Math.random() * 1000) + 50;

    events.push({
      timestamp: timestamp.toISOString().replace('T', ' ').slice(0, 19),
      builder_id: builderId as string,
      trace_id: crypto.randomUUID(),
      span_id: crypto.randomUUID(),
      customer_id: `${builderId}:cust_${custIdx + 1}`,
      provider: providers[modelIdx],
      model: models[modelIdx],
      operation: 'chat.completions',
      step_name: `step_${i % 5}`,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: Number(((tokensIn * 2.5 + tokensOut * 10) / 1_000_000).toFixed(6)),
      latency_ms: Math.floor(Math.random() * 3000) + 200,
      status: 'success',
      cost_source: 'auto',
      instrumentation_tier: 'sdk_wrapper',
      stream_aborted: 0,
      abort_savings: 0,
      metadata: '',
    });
  }

  await ch.insert({
    table: 'cost_events',
    values: events,
    format: 'JSONEachRow',
  });
  console.log(`  ✓ ${events.length} ClickHouse events\n`);

  await sql.end();
  await ch.close();

  console.log('Seed complete.');
}

if (isDirectExecution) {
  seed().catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
}
