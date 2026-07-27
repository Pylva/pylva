// CLI: Create or adopt a builder with an optional API key.
// New builders require an explicit paid plan or self-hosted entitlement.
// Decision #25: create-builder with auto-key

import postgres from 'postgres';
import argon2 from 'argon2';
import crypto from 'node:crypto';
import {
  BuilderAccessState,
  EntitlementSource,
  isBuilderPlan,
  type BuilderPlan,
  type EntitlementSource as EntitlementSourceValue,
} from '@pylva/shared';
import { builderBillingLifecycleLockKey } from '../../src/lib/db/advisory-locks.js';

const args = process.argv.slice(2);

function getArg(name: string, defaultValue?: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return defaultValue;
  return args[idx + 1];
}

const email = getArg('email');
const planArg = getArg('plan');
const legacyTierArg = getArg('tier');
const selfHosted = args.includes('--self-hosted');
const noKey = args.includes('--no-key');
const argon2Secret = process.env['ARGON2_SECRET'] ?? 'dev-secret-change-in-prod';
const deploymentMode = process.env['PYLVA_DEPLOYMENT_MODE'] ?? 'self_hosted';

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
    'Usage: pnpm cli:create-builder -- --email <email> [--plan pro|scale|enterprise | --self-hosted] [--no-key]',
  );
  process.exit(1);
}

if (legacyTierArg !== undefined) {
  console.error('The --tier option was removed. Use --plan pro|scale|enterprise.');
  process.exit(1);
}

if (planArg !== undefined && !isBuilderPlan(planArg)) {
  console.error(`Invalid plan: ${planArg}. Must be one of: pro, scale, enterprise`);
  process.exit(1);
}

if (planArg !== undefined && selfHosted) {
  console.error('Choose either --plan or --self-hosted, not both.');
  process.exit(1);
}

if (deploymentMode !== 'hosted' && deploymentMode !== 'self_hosted') {
  console.error('PYLVA_DEPLOYMENT_MODE must be hosted or self_hosted.');
  process.exit(1);
}

if (selfHosted && deploymentMode === 'hosted') {
  console.error('Cannot provision a self-hosted entitlement in hosted deployment mode.');
  process.exit(1);
}

if (planArg !== undefined && deploymentMode === 'self_hosted') {
  console.error('Cannot assign a commercial plan in self-hosted deployment mode.');
  process.exit(1);
}

interface RequestedEntitlement {
  plan: BuilderPlan | null;
  source: EntitlementSourceValue;
}

const requestedEntitlement: RequestedEntitlement | null =
  planArg !== undefined
    ? { plan: planArg, source: EntitlementSource.ADMIN }
    : selfHosted
      ? { plan: null, source: EntitlementSource.SELF_HOSTED }
      : null;

const databaseUrl =
  process.env['DATABASE_URL'] ?? 'postgresql://pylva:pylva_dev@localhost:5432/pylva';
const sql = postgres(databaseUrl);

try {
  const normalizedEmail = email.trim().toLowerCase();
  const slug = `${slugify(normalizedEmail.split('@')[0] ?? normalizedEmail)}-${crypto.randomBytes(3).toString('hex')}`;

  const result = await sql.begin(async (tx) => {
    // Serialize provisioning by normalized email so concurrent invocations
    // cannot race into conflicting plan assignments.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${normalizedEmail}, 0))`;

    let [builder] = await tx<
      Array<{
        id: string;
        email: string;
        tier: BuilderPlan | null;
        access_state: string;
        entitlement_source: string | null;
        slug: string;
      }>
    >`
      SELECT id, email, tier, access_state, entitlement_source, slug
      FROM builders
      WHERE email = ${normalizedEmail}
    `;

    if (builder === undefined) {
      if (requestedEntitlement === null) {
        throw new Error('A new builder requires --plan pro|scale|enterprise or --self-hosted.');
      }

      [builder] = await tx<
        Array<{
          id: string;
          email: string;
          tier: BuilderPlan | null;
          access_state: string;
          entitlement_source: string | null;
          slug: string;
        }>
      >`
        INSERT INTO builders (
          email,
          tier,
          access_state,
          entitlement_source,
          slug
        )
        VALUES (
          ${normalizedEmail},
          ${requestedEntitlement.plan},
          ${BuilderAccessState.ACTIVE},
          ${requestedEntitlement.source},
          ${slug}
        )
        RETURNING id, email, tier, access_state, entitlement_source, slug
      `;
    } else if (requestedEntitlement !== null) {
      // An explicit option is required to change an existing entitlement.
      // Lock order is email advisory -> builder lifecycle advisory -> row.
      // Hosted Checkout/recovery/sync acquire the same builder-key advisory
      // lock before their authoritative lifecycle reads and Stripe effects.
      // Re-read under FOR UPDATE after the advisory wait so this update never
      // acts on the stale row observed while resolving the builder ID.
      await tx`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${builderBillingLifecycleLockKey(builder.id)}, 0)
        )
      `;
      [builder] = await tx<
        Array<{
          id: string;
          email: string;
          tier: BuilderPlan | null;
          access_state: string;
          entitlement_source: string | null;
          slug: string;
        }>
      >`
        SELECT id, email, tier, access_state, entitlement_source, slug
        FROM builders
        WHERE id = ${builder.id}
          AND email = ${normalizedEmail}
        FOR UPDATE
      `;
      if (builder === undefined) {
        throw new Error('Builder disappeared while waiting for lifecycle lock');
      }
      [builder] = await tx<
        Array<{
          id: string;
          email: string;
          tier: BuilderPlan | null;
          access_state: string;
          entitlement_source: string | null;
          slug: string;
        }>
      >`
        UPDATE builders
        SET tier = ${requestedEntitlement.plan},
            access_state = ${BuilderAccessState.ACTIVE},
            entitlement_source = ${requestedEntitlement.source},
            updated_at = NOW()
        WHERE id = ${builder.id}
        RETURNING id, email, tier, access_state, entitlement_source, slug
      `;
    }

    if (builder === undefined) {
      throw new Error('Builder provisioning did not return a row');
    }

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
  console.log(`  Plan:  ${result.builder.tier ?? '(none)'}`);
  console.log(`  Access: ${result.builder.access_state}`);
  console.log(`  Source: ${result.builder.entitlement_source ?? '(none)'}`);
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
