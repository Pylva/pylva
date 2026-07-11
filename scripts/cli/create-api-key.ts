// CLI: Create an API key for an existing builder
// Usage: pnpm cli:create-api-key -- --builder-id <uuid>
//
// One universal key (migration 048): every key is minted with scope
// 'universal'. The legacy --scope flag is accepted but ignored (with a
// warning) so existing runbooks don't break.

import postgres from 'postgres';
import argon2 from 'argon2';
import crypto from 'node:crypto';

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

const builderId = getArg('builder-id');
const legacyScope = getArg('scope');
const argon2Secret = process.env['ARGON2_SECRET'] ?? 'dev-secret-change-in-prod';

if (!builderId) {
  console.error('Usage: pnpm cli:create-api-key -- --builder-id <uuid>');
  process.exit(1);
}

if (legacyScope) {
  console.warn(
    `--scope ${legacyScope} is ignored: since migration 048 every key is universal ` +
      '(SDK telemetry, admin API, and data import).',
  );
}

const databaseUrl =
  process.env['DATABASE_URL'] ?? 'postgresql://pylva:pylva_dev@localhost:5432/pylva';
const sql = postgres(databaseUrl);

try {
  // Verify builder exists
  const [builder] = await sql`SELECT id FROM builders WHERE id = ${builderId}`;
  if (!builder) {
    console.error(`Builder not found: ${builderId}`);
    process.exit(1);
  }

  // Generate API key
  const keyId = crypto.randomBytes(4).toString('hex');
  const randomPart = crypto.randomBytes(16).toString('hex');
  const fullKey = `pv_live_${keyId}_${randomPart}`;
  const keyHash = await argon2.hash(fullKey, {
    secret: Buffer.from(argon2Secret),
  });

  await sql`
    INSERT INTO api_keys (key_id, builder_id, key_hash, scope)
    VALUES (${keyId}, ${builderId}, ${keyHash}, 'universal')
  `;

  console.log(`API Key (save this — shown once): ${fullKey}`);
  console.log(`  Builder: ${builderId}`);
} catch (err) {
  console.error('Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
} finally {
  await sql.end();
}
