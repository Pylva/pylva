// B2a — org (builder) creation + slug resolution. Called from OAuth +
// magic-link callbacks when the authenticating user has no existing
// membership (D8 open signup).
//
// Slug generation: normalize display-name → lowercase ascii-alnum with
// hyphens → clamp 3..48. On UNIQUE collision, retry with a -{rand4} suffix.

import crypto from 'node:crypto';
import { and, desc, eq, sql as drizzleSql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { withRLS, type DrizzleTransaction } from '../db/rls.js';
import { builders, userBuilderMemberships } from '../db/schema.js';
import { logger } from '../logger.js';
import { Role, type Role as RoleType } from '@pylva/shared';

const log = logger.child({ module: 'auth.org' });

export interface OrgForUser {
  builderId: string;
  slug: string;
  role: RoleType;
  tier: string;
  isNew: boolean;
}

/** Slug-scoped membership tuple — shared by middleware + membership cache. */
export interface MembershipContext {
  builderId: string;
  role: RoleType;
  tier: string;
}

function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  if (base.length < 3) return `builder-${crypto.randomBytes(3).toString('hex')}`;
  return base.slice(0, 48);
}

function suffixed(base: string): string {
  const suffix = `-${crypto.randomBytes(2).toString('hex')}`;
  // Keep total length <=48 by trimming the base.
  const room = 48 - suffix.length;
  return `${base.slice(0, room)}${suffix}`;
}

/**
 * Upsert-or-create an org (builder) for a freshly-authenticated user.
 * - If the user has ANY existing membership: returns the most-recently-created
 *   one; `isNew: false`.
 * - Else if a legacy/provisioned builder already exists for the verified email:
 *   attaches the user as owner and returns that builder; `isNew: false`.
 * - Else: creates a new builder + owner membership at tier='free' and returns
 *   `isNew: true` so the caller can render the production onboarding checklist.
 *   No demo data is seeded in production (front-end launch §5).
 */
export async function findOrCreateBuilderForUser(input: {
  userId: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
}): Promise<OrgForUser> {
  const normalizedEmail = normalizeEmail(input.email);

  return db.transaction(async (tx) => {
    // Look for an existing membership first.
    const existing = await findDefaultBuilderForUserTx(tx, input.userId);
    if (existing) return existing;

    const emailMatch = await findBuilderByEmailTx(tx, normalizedEmail);
    if (emailMatch) {
      return attachExistingBuilderToUser(tx, {
        userId: input.userId,
        builder: emailMatch,
        reason: 'email_match',
      });
    }

    const nameBase = input.displayName ?? normalizedEmail.split('@')[0] ?? 'builder';
    const baseSlug = slugify(nameBase);
    const result = await insertBuilderWithSlug(tx, {
      baseSlug,
      displayName: input.displayName,
      avatarUrl: input.avatarUrl,
      email: normalizedEmail,
    });

    if (result.kind === 'existing_email_match') {
      return attachExistingBuilderToUser(tx, {
        userId: input.userId,
        builder: result.builder,
        reason: 'email_conflict_race',
      });
    }

    await insertOwnerMembership(tx, input.userId, result.builderId);

    log.info(
      { builderId: result.builderId, slug: result.slug },
      'new builder created (free tier, no demo seed)',
    );

    return {
      builderId: result.builderId,
      slug: result.slug,
      role: Role.OWNER,
      tier: 'free',
      isNew: true,
    };
  });
}

export async function findDefaultBuilderForUser(userId: string): Promise<OrgForUser | null> {
  return findDefaultBuilderForUserTx(db, userId);
}

async function findDefaultBuilderForUserTx(
  tx: DrizzleTransaction | typeof db,
  userId: string,
): Promise<OrgForUser | null> {
  const existing = await tx
    .select({
      builder_id: userBuilderMemberships.builder_id,
      role: userBuilderMemberships.role,
      slug: builders.slug,
      tier: builders.tier,
    })
    .from(userBuilderMemberships)
    .innerJoin(builders, eq(builders.id, userBuilderMemberships.builder_id))
    .where(eq(userBuilderMemberships.user_id, userId))
    .orderBy(desc(userBuilderMemberships.created_at))
    .limit(1);

  if (existing.length === 0) return null;
  const row = existing[0]!;
  return {
    builderId: row.builder_id,
    slug: row.slug,
    role: row.role as RoleType,
    tier: row.tier,
    isNew: false,
  };
}

interface ExistingBuilder {
  id: string;
  slug: string;
  tier: string;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function findBuilderByEmailTx(
  tx: DrizzleTransaction,
  normalizedEmail: string,
): Promise<ExistingBuilder | null> {
  const rows = await tx
    .select({
      id: builders.id,
      slug: builders.slug,
      tier: builders.tier,
    })
    .from(builders)
    .where(drizzleSql`lower(${builders.email}) = ${normalizedEmail}`)
    .limit(1);

  return rows[0] ?? null;
}

async function insertOwnerMembership(
  tx: DrizzleTransaction,
  userId: string,
  builderId: string,
): Promise<void> {
  await tx
    .insert(userBuilderMemberships)
    .values({
      user_id: userId,
      builder_id: builderId,
      role: Role.OWNER,
    })
    .onConflictDoNothing();
}

async function attachExistingBuilderToUser(
  tx: DrizzleTransaction,
  input: {
    userId: string;
    builder: ExistingBuilder;
    reason: 'email_match' | 'email_conflict_race';
  },
): Promise<OrgForUser> {
  await insertOwnerMembership(tx, input.userId, input.builder.id);

  log.info(
    { builderId: input.builder.id, slug: input.builder.slug, reason: input.reason },
    'existing builder attached to authenticated user',
  );

  return {
    builderId: input.builder.id,
    slug: input.builder.slug,
    role: Role.OWNER,
    tier: input.builder.tier,
    isNew: false,
  };
}

/**
 * Transaction-safe create: try base slug → retry with suffix when a UNIQUE
 * conflict prevents insertion. `ON CONFLICT DO NOTHING` keeps the transaction
 * usable; after a conflict, reread by normalized email to distinguish an
 * existing legacy/racing builder from a slug-only collision.
 */
type InsertBuilderResult =
  | { kind: 'created'; builderId: string; slug: string }
  | { kind: 'existing_email_match'; builder: ExistingBuilder };

async function insertBuilderWithSlug(
  tx: DrizzleTransaction,
  input: {
    baseSlug: string;
    displayName: string | null;
    avatarUrl: string | null;
    email: string;
  },
): Promise<InsertBuilderResult> {
  let slug = input.baseSlug;
  for (let attempt = 0; attempt < 5; attempt++) {
    const rows = await tx
      .insert(builders)
      .values({
        email: input.email,
        name: input.displayName ?? null,
        display_name: input.displayName,
        avatar_url: input.avatarUrl,
        slug,
        // Explicit free-tier default. Self-serve signup does not start on
        // a paid tier; pricing changes are driven by Stripe webhook sync.
        tier: 'free',
      })
      .onConflictDoNothing()
      .returning({ id: builders.id });

    if (rows.length > 0) {
      return { kind: 'created', builderId: rows[0]!.id, slug };
    }

    const emailMatch = await findBuilderByEmailTx(tx, input.email);
    if (emailMatch) {
      return { kind: 'existing_email_match', builder: emailMatch };
    }

    slug = suffixed(input.baseSlug);
  }
  throw new Error('[auth.org] slug collision exhausted 5 retries');
}

/**
 * Switch the user's active org. Verifies membership then returns the tuple
 * needed to mint a new dashboard JWT (caller signs + sets cookie).
 */
export async function switchActiveOrg(input: {
  userId: string;
  builderId: string;
}): Promise<OrgForUser | null> {
  const rows = await withRLS(input.builderId, async (tx) =>
    tx
      .select({
        builder_id: userBuilderMemberships.builder_id,
        role: userBuilderMemberships.role,
        slug: builders.slug,
        tier: builders.tier,
      })
      .from(userBuilderMemberships)
      .innerJoin(builders, eq(builders.id, userBuilderMemberships.builder_id))
      .where(
        and(
          eq(userBuilderMemberships.user_id, input.userId),
          eq(userBuilderMemberships.builder_id, input.builderId),
        ),
      )
      .limit(1),
  );
  if (rows.length === 0) return null;
  const row = rows[0]!;
  return {
    builderId: row.builder_id,
    slug: row.slug,
    role: row.role as RoleType,
    tier: row.tier,
    isNew: false,
  };
}

/**
 * Resolve a slug → builder_id, and verify the user has membership.
 * Used by middleware on every /o/{slug}/* request (I-T1-9). Returns null on
 * no-membership so callers return 404 (don't leak existence).
 */
export async function resolveSlugForUser(input: {
  slug: string;
  userId: string;
}): Promise<MembershipContext | null> {
  const rows = await db
    .select({
      builder_id: builders.id,
      role: userBuilderMemberships.role,
      tier: builders.tier,
    })
    .from(builders)
    .innerJoin(userBuilderMemberships, eq(userBuilderMemberships.builder_id, builders.id))
    .where(and(eq(builders.slug, input.slug), eq(userBuilderMemberships.user_id, input.userId)))
    .limit(1);
  if (rows.length === 0) return null;
  const row = rows[0]!;
  return { builderId: row.builder_id, role: row.role as RoleType, tier: row.tier };
}

/** Test helper — expose the private slugify fn to tests. */
export const _internal = { slugify, suffixed };
