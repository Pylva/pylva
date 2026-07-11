// CLI: Create a builder with optional API key
// Usage: pnpm cli:create-builder -- --email alice@example.com --tier free
// Decision #25: create-builder with auto-key

import postgres from 'postgres';
import argon2 from 'argon2';
import crypto from 'node:crypto';

const args = process.argv.slice(2);

function getArg(name: string, defaultValue?: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return defaultValue;
  return args[idx + 1];
}

const email = getArg('email');
const tier = getArg('tier', 'free')!;
const noKey = args.includes('--no-key');
const argon2Secret = process.env['ARGON2_SECRET'] ?? 'dev-secret-change-in-prod';

function slugify(input: string): string {
  const candidate = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 40);
  return candidate.length >= 3 ? candidate : 'builder';
}

if (!email) {
  console.error(
    'Usage: pnpm cli:create-builder -- --email <email> [--tier free|pro|scale|enterprise] [--no-key]',
  );
  process.exit(1);
}

if (!['free', 'pro', 'scale', 'enterprise'].includes(tier)) {
  console.error(`Invalid tier: ${tier}. Must be one of: free, pro, scale, enterprise`);
  process.exit(1);
}

const databaseUrl =
  process.env['DATABASE_URL'] ?? 'postgresql://pylva:pylva_dev@localhost:5432/pylva';
const sql = postgres(databaseUrl);

try {
  const normalizedEmail = email.trim().toLowerCase();
  const slug = `${slugify(normalizedEmail.split('@')[0] ?? normalizedEmail)}-${crypto.randomBytes(3).toString('hex')}`;

  const result = await sql.begin(async (tx) => {
    const [builder] = await tx`
      INSERT INTO builders (email, tier, slug) VALUES (${normalizedEmail}, ${tier}, ${slug})
      ON CONFLICT (email) DO UPDATE SET tier = EXCLUDED.tier
      RETURNING id, email, tier, slug
    `;

    const [user] = await tx`
      INSERT INTO users (email)
      VALUES (${normalizedEmail})
      ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
      RETURNING id
    `;

    await tx`
      INSERT INTO user_builder_memberships (user_id, builder_id, role)
      VALUES (${user!.id}, ${builder!.id}, 'owner')
      ON CONFLICT (user_id, builder_id) DO NOTHING
    `;

    let fullKey: string | null = null;
    if (!noKey) {
      // Generate Agent SDK key
      const keyId = crypto.randomBytes(4).toString('hex');
      const randomPart = crypto.randomBytes(16).toString('hex');
      fullKey = `pv_live_${keyId}_${randomPart}`;
      const keyHash = await argon2.hash(fullKey, {
        secret: Buffer.from(argon2Secret),
      });

      await tx`
        INSERT INTO api_keys (key_id, builder_id, key_hash, scope, label)
        VALUES (${keyId}, ${builder!.id}, ${keyHash}, 'universal', 'Auto-generated API key')
      `;
    }

    return { builder: builder!, userId: user!.id as string, fullKey };
  });

  console.log(`Builder created: ${result.builder.id}`);
  console.log(`  Email: ${result.builder.email}`);
  console.log(`  Tier:  ${result.builder.tier}`);
  console.log(`  Slug:  ${result.builder.slug}`);
  console.log(`  Owner user: ${result.userId}`);

  if (result.fullKey !== null) {
    console.log(`\nAPI Key (save this — shown once): ${result.fullKey}`);
  }
} catch (err) {
  console.error('Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
} finally {
  await sql.end();
}
