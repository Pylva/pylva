// B2a — org (builder) creation + slug resolution. Called from OAuth +
// magic-link callbacks when the authenticating user has no existing
// membership (D8 open signup).
//
// Slug generation: normalize display-name → lowercase ascii-alnum with
// hyphens → clamp 3..48. On UNIQUE collision, retry with a -{rand4} suffix.

import crypto from 'node:crypto';
import { and, desc, eq, gt, isNull, sql as drizzleSql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { withRLS, type DrizzleTransaction } from '../db/rls.js';
import { builders, invites, userBuilderMemberships, users } from '../db/schema.js';
import { logger } from '../logger.js';
import {
  BuilderAccessState,
  AuthProvider,
  EntitlementSource,
  OAuthProvider,
  Role,
  type AuthProvider as AuthProviderType,
  type BuilderAccessState as BuilderAccessStateValue,
  type BuilderPlan,
  type EntitlementSource as EntitlementSourceValue,
  type OAuthProvider as OAuthProviderType,
  type Role as RoleType,
} from '@pylva/shared';
import { env } from '../config.js';
import {
  InvalidBuilderEntitlementError,
  requireEntitlementContext,
  type NormalizedEntitlementContext,
} from './entitlement-context.js';
import { assertHostedProvisionalSignupEnabledTx } from './hosted-provisional-signup.js';

const log = logger.child({ module: 'auth.org' });
const FIRST_LOGIN_LOCK_SEED = 50_620_260_723;

function entitlementContextOrNull(
  builderId: string,
  input: Parameters<typeof requireEntitlementContext>[0],
): NormalizedEntitlementContext | null {
  try {
    return requireEntitlementContext(input);
  } catch (error) {
    if (!(error instanceof InvalidBuilderEntitlementError)) throw error;
    log.error(
      { builder_id: builderId, reason: error.reason },
      'invalid persisted builder entitlement; auth access denied',
    );
    return null;
  }
}

export interface OrgForUser {
  builderId: string;
  slug: string;
  role: RoleType;
  plan: BuilderPlan | null;
  accessState: BuilderAccessStateValue;
  entitlementSource: EntitlementSourceValue | null;
  isNew: boolean;
  acceptedInviteId: string | null;
}

export type AuthProvisioningStage = 'user_upsert' | 'org_create';

export class AuthProvisioningError extends Error {
  constructor(
    public readonly stage: AuthProvisioningStage,
    options?: { cause?: unknown },
  ) {
    super(`[auth.org] ${stage} failed`, options);
    this.name = 'AuthProvisioningError';
  }
}

export interface ProvisionedMagicLinkUser {
  userId: string;
  email: string;
  isNewUser: boolean;
}

export interface ProvisionedOAuthUser {
  userId: string;
  isNew: boolean;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  previousAuthProvider: AuthProviderType | null;
}

export interface ProvisionedMagicLinkSession {
  user: ProvisionedMagicLinkUser;
  org: OrgForUser;
}

export interface ProvisionedOAuthSession {
  user: ProvisionedOAuthUser;
  org: OrgForUser;
}

/** Slug-scoped membership tuple — shared by middleware + membership cache. */
export interface MembershipContext {
  builderId: string;
  role: RoleType;
  plan: BuilderPlan | null;
  accessState: BuilderAccessStateValue;
  entitlementSource: EntitlementSourceValue | null;
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

interface ExistingAuthUser {
  id: string;
  auth_provider: string | null;
  display_name?: string | null;
  avatar_url?: string | null;
}

async function recordMagicLinkLoginTx(
  tx: DrizzleTransaction,
  row: ExistingAuthUser,
): Promise<void> {
  const existingProvider = row.auth_provider as AuthProviderType | null;
  const nextProvider: AuthProviderType =
    existingProvider === null || existingProvider === AuthProvider.MAGIC_LINK
      ? AuthProvider.MAGIC_LINK
      : AuthProvider.MIXED;
  await tx
    .update(users)
    .set({ auth_provider: nextProvider, last_login_at: new Date() })
    .where(eq(users.id, row.id));
}

async function upsertMagicLinkUserTx(
  tx: DrizzleTransaction,
  normalizedEmail: string,
): Promise<ProvisionedMagicLinkUser> {
  const existing = await tx
    .select({ id: users.id, auth_provider: users.auth_provider })
    .from(users)
    .where(eq(users.email, normalizedEmail))
    .limit(1);
  const existingUser = existing[0];
  if (existingUser) {
    await recordMagicLinkLoginTx(tx, existingUser);
    return { userId: existingUser.id, email: normalizedEmail, isNewUser: false };
  }

  const inserted = await tx
    .insert(users)
    .values({
      email: normalizedEmail,
      auth_provider: AuthProvider.MAGIC_LINK,
      last_login_at: new Date(),
    })
    .onConflictDoNothing({ target: users.email })
    .returning({ id: users.id });
  const insertedUser = inserted[0];
  if (insertedUser) {
    return { userId: insertedUser.id, email: normalizedEmail, isNewUser: true };
  }

  const raced = await tx
    .select({ id: users.id, auth_provider: users.auth_provider })
    .from(users)
    .where(eq(users.email, normalizedEmail))
    .limit(1);
  const racedUser = raced[0];
  if (!racedUser) throw new Error('Magic-link user conflict could not be resolved');
  await recordMagicLinkLoginTx(tx, racedUser);
  return { userId: racedUser.id, email: normalizedEmail, isNewUser: false };
}

async function recordOAuthLoginTx(
  tx: DrizzleTransaction,
  row: ExistingAuthUser,
  profile: {
    email: string;
    displayName: string | null;
    avatarUrl: string | null;
  },
  authProvider: AuthProviderType,
): Promise<ProvisionedOAuthUser> {
  const existingProvider = row.auth_provider as AuthProviderType | null;
  const nextProvider: AuthProviderType =
    existingProvider === null || existingProvider === authProvider
      ? authProvider
      : AuthProvider.MIXED;
  const displayName = row.display_name ?? profile.displayName;
  const avatarUrl = row.avatar_url ?? profile.avatarUrl;
  await tx
    .update(users)
    .set({
      auth_provider: nextProvider,
      display_name: displayName,
      avatar_url: avatarUrl,
      last_login_at: new Date(),
    })
    .where(eq(users.id, row.id));
  return {
    userId: row.id,
    isNew: false,
    email: profile.email,
    displayName,
    avatarUrl,
    previousAuthProvider: existingProvider,
  };
}

async function upsertOAuthUserTx(
  tx: DrizzleTransaction,
  profile: {
    email: string;
    displayName: string | null;
    avatarUrl: string | null;
    provider: OAuthProviderType;
  },
): Promise<ProvisionedOAuthUser> {
  const authProvider: AuthProviderType =
    profile.provider === OAuthProvider.GITHUB
      ? AuthProvider.OAUTH_GITHUB
      : AuthProvider.OAUTH_GOOGLE;
  const existing = await tx
    .select({
      id: users.id,
      auth_provider: users.auth_provider,
      display_name: users.display_name,
      avatar_url: users.avatar_url,
    })
    .from(users)
    .where(eq(users.email, profile.email))
    .limit(1);
  const existingUser = existing[0];
  if (existingUser) return recordOAuthLoginTx(tx, existingUser, profile, authProvider);

  const inserted = await tx
    .insert(users)
    .values({
      email: profile.email,
      display_name: profile.displayName,
      avatar_url: profile.avatarUrl,
      auth_provider: authProvider,
      last_login_at: new Date(),
    })
    .onConflictDoNothing({ target: users.email })
    .returning({ id: users.id });
  const insertedUser = inserted[0];
  if (insertedUser) {
    return {
      userId: insertedUser.id,
      isNew: true,
      email: profile.email,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
      previousAuthProvider: null,
    };
  }

  const raced = await tx
    .select({
      id: users.id,
      auth_provider: users.auth_provider,
      display_name: users.display_name,
      avatar_url: users.avatar_url,
    })
    .from(users)
    .where(eq(users.email, profile.email))
    .limit(1);
  const racedUser = raced[0];
  if (!racedUser) throw new Error('OAuth user conflict could not be resolved');
  return recordOAuthLoginTx(tx, racedUser, profile, authProvider);
}

/**
 * Upsert-or-create an org (builder) for a freshly-authenticated user.
 * - If the user has ANY existing membership: returns the most-recently-created
 *   one; `isNew: false`.
 * - Else if a valid pending invite belongs to the verified email: atomically
 *   claims it and returns the invited workspace without creating a personal
 *   workspace.
 * - Else if a legacy/provisioned builder already exists for the verified email:
 *   attaches the user as owner and returns that builder; `isNew: false`.
 * - Else: creates a provisional hosted workspace, or an active self-hosted
 *   workspace. No paid plan is inferred before Stripe activates one.
 */
export interface BuilderForUserInput {
  userId: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  pendingInviteToken?: string | null;
}

export async function findOrCreateBuilderForUser(
  input: BuilderForUserInput,
): Promise<OrgForUser> {
  const normalizedEmail = normalizeEmail(input.email);

  return db.transaction(async (tx) => {
    // This must be the transaction's first database operation. The user row is
    // unique by CITEXT email, so an email-scoped transaction lock serializes
    // explicit-invite and generic callbacks for the same verified identity.
    // The waiter takes a new READ COMMITTED statement snapshot after the
    // winner commits and therefore observes its membership before provisioning.
    await lockFirstLoginForVerifiedEmailTx(tx, normalizedEmail);
    return findOrCreateBuilderForUserTx(tx, input, normalizedEmail);
  });
}

export async function provisionMagicLinkUserAndBuilder(input: {
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  pendingInviteToken?: string | null;
}): Promise<ProvisionedMagicLinkSession> {
  const normalizedEmail = normalizeEmail(input.email);
  return db.transaction(async (tx) => {
    await lockFirstLoginForVerifiedEmailTx(tx, normalizedEmail);

    let user: ProvisionedMagicLinkUser;
    try {
      user = await upsertMagicLinkUserTx(tx, normalizedEmail);
    } catch (cause) {
      throw new AuthProvisioningError('user_upsert', { cause });
    }
    try {
      const org = await findOrCreateBuilderForUserTx(
        tx,
        {
          ...input,
          email: normalizedEmail,
          userId: user.userId,
        },
        normalizedEmail,
      );
      return { user, org };
    } catch (cause) {
      throw new AuthProvisioningError('org_create', { cause });
    }
  });
}

export async function provisionOAuthUserAndBuilder(input: {
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  provider: OAuthProviderType;
  pendingInviteToken?: string | null;
}): Promise<ProvisionedOAuthSession> {
  const normalizedEmail = normalizeEmail(input.email);
  const profile = { ...input, email: normalizedEmail };
  return db.transaction(async (tx) => {
    await lockFirstLoginForVerifiedEmailTx(tx, normalizedEmail);

    let user: ProvisionedOAuthUser;
    try {
      user = await upsertOAuthUserTx(tx, profile);
    } catch (cause) {
      throw new AuthProvisioningError('user_upsert', { cause });
    }
    try {
      const org = await findOrCreateBuilderForUserTx(
        tx,
        {
          email: normalizedEmail,
          displayName: input.displayName,
          avatarUrl: input.avatarUrl,
          pendingInviteToken: input.pendingInviteToken,
          userId: user.userId,
        },
        normalizedEmail,
      );
      return { user, org };
    } catch (cause) {
      throw new AuthProvisioningError('org_create', { cause });
    }
  });
}

async function findOrCreateBuilderForUserTx(
  tx: DrizzleTransaction,
  input: BuilderForUserInput,
  normalizedEmail: string,
): Promise<OrgForUser> {
  // Look for an existing membership first.
  const existing = await findDefaultBuilderForUserTx(tx, input.userId);
  if (existing) return existing;

  if (input.pendingInviteToken) {
    const invited = await acceptPendingInviteTx(tx, {
      userId: input.userId,
      email: normalizedEmail,
      token: input.pendingInviteToken,
    });
    if (invited) return invited;

    // A concurrent callback for the same token may have committed the claim
    // while this UPDATE waited on its row lock. Re-read membership before
    // creating a personal workspace.
    const acceptedByConcurrentLogin = await findDefaultBuilderForUserTx(tx, input.userId);
    if (acceptedByConcurrentLogin) return acceptedByConcurrentLogin;
  }

  // An auth callback does not need to carry the invite bearer token. Once the
  // provider has verified the email, claim the newest valid invitation for
  // that address deterministically (UUID breaks equal-created_at ties).
  const invitedByEmail = await acceptPendingInviteByEmailTx(tx, {
    userId: input.userId,
    email: normalizedEmail,
  });
  if (invitedByEmail) return invitedByEmail;

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
    'new builder created (no paid plan, no demo seed)',
  );

  const entitlement =
    env.PYLVA_DEPLOYMENT_MODE === 'hosted'
      ? {
          plan: null,
          accessState: BuilderAccessState.CHECKOUT_REQUIRED,
          entitlementSource: null,
        }
      : {
          plan: null,
          accessState: BuilderAccessState.ACTIVE,
          entitlementSource: EntitlementSource.SELF_HOSTED,
        };

  return {
    builderId: result.builderId,
    slug: result.slug,
    role: Role.OWNER,
    ...entitlement,
    isNew: true,
    acceptedInviteId: null,
  };
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
      plan: builders.tier,
      access_state: builders.access_state,
      entitlement_source: builders.entitlement_source,
    })
    .from(userBuilderMemberships)
    .innerJoin(builders, eq(builders.id, userBuilderMemberships.builder_id))
    .where(eq(userBuilderMemberships.user_id, userId))
    .orderBy(desc(userBuilderMemberships.created_at))
    .limit(1);

  if (existing.length === 0) return null;
  const row = existing[0]!;
  const entitlement = requireEntitlementContext({
    plan: row.plan,
    access_state: row.access_state,
    entitlement_source: row.entitlement_source,
  });
  return {
    builderId: row.builder_id,
    slug: row.slug,
    role: row.role as RoleType,
    ...entitlement,
    isNew: false,
    acceptedInviteId: null,
  };
}

interface ExistingBuilder {
  id: string;
  slug: string;
  plan: BuilderPlan | null;
  accessState: BuilderAccessStateValue;
  entitlementSource: EntitlementSourceValue | null;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function lockFirstLoginForVerifiedEmailTx(
  tx: DrizzleTransaction,
  normalizedEmail: string,
): Promise<void> {
  await tx.execute(drizzleSql`
    SELECT pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        pg_catalog.concat('pylva-auth-first-login:', ${normalizedEmail}::TEXT),
        ${FIRST_LOGIN_LOCK_SEED}::BIGINT
      )
    )
  `);
}

async function findBuilderByEmailTx(
  tx: DrizzleTransaction,
  normalizedEmail: string,
): Promise<ExistingBuilder | null> {
  const rows = await tx
    .select({
      id: builders.id,
      slug: builders.slug,
      plan: builders.tier,
      access_state: builders.access_state,
      entitlement_source: builders.entitlement_source,
    })
    .from(builders)
    .where(drizzleSql`lower(${builders.email}) = ${normalizedEmail}`)
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  const entitlement = requireEntitlementContext({
    plan: row.plan,
    access_state: row.access_state,
    entitlement_source: row.entitlement_source,
  });
  return {
    id: row.id,
    slug: row.slug,
    ...entitlement,
  };
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
    plan: input.builder.plan,
    accessState: input.builder.accessState,
    entitlementSource: input.builder.entitlementSource,
    isNew: false,
    acceptedInviteId: null,
  };
}

async function acceptPendingInviteTx(
  tx: DrizzleTransaction,
  input: { userId: string; email: string; token: string },
): Promise<OrgForUser | null> {
  const now = new Date();
  const claimed = await tx
    .update(invites)
    .set({ accepted_at: now })
    .where(
      and(
        eq(invites.token, input.token),
        drizzleSql`lower(${invites.email}) = ${input.email}`,
        isNull(invites.accepted_at),
        gt(invites.expires_at, now),
      ),
    )
    .returning({
      id: invites.id,
      builder_id: invites.builder_id,
      role: invites.role,
    });
  const invite = claimed[0];
  if (!invite) return null;

  return createMembershipForClaimedInviteTx(tx, input.userId, invite);
}

interface ClaimedInvite extends Record<string, unknown> {
  id: string;
  builder_id: string;
  role: string;
}

async function acceptPendingInviteByEmailTx(
  tx: DrizzleTransaction,
  input: { userId: string; email: string },
): Promise<OrgForUser | null> {
  const claimed = await tx.execute<ClaimedInvite>(drizzleSql`
    WITH pending_invite AS (
      SELECT ${invites.id}
      FROM ${invites}
      WHERE lower(${invites.email}) = ${input.email}
        AND ${invites.accepted_at} IS NULL
        AND ${invites.expires_at} > CURRENT_TIMESTAMP
      ORDER BY ${invites.created_at} DESC, ${invites.id} ASC
      FOR UPDATE
      LIMIT 1
    )
    UPDATE ${invites}
    SET accepted_at = CURRENT_TIMESTAMP
    FROM pending_invite
    WHERE ${invites.id} = pending_invite.id
      AND ${invites.accepted_at} IS NULL
      AND ${invites.expires_at} > CURRENT_TIMESTAMP
    RETURNING
      ${invites.id},
      ${invites.builder_id},
      ${invites.role}
  `);
  const invite = claimed[0];
  if (!invite) return null;

  return createMembershipForClaimedInviteTx(tx, input.userId, invite);
}

async function createMembershipForClaimedInviteTx(
  tx: DrizzleTransaction,
  userId: string,
  invite: ClaimedInvite,
): Promise<OrgForUser> {
  await tx
    .insert(userBuilderMemberships)
    .values({
      user_id: userId,
      builder_id: invite.builder_id,
      role: invite.role as RoleType,
    })
    .onConflictDoNothing();

  const rows = await tx
    .select({
      slug: builders.slug,
      plan: builders.tier,
      access_state: builders.access_state,
      entitlement_source: builders.entitlement_source,
      role: userBuilderMemberships.role,
    })
    .from(builders)
    .innerJoin(userBuilderMemberships, eq(userBuilderMemberships.builder_id, builders.id))
    .where(
      and(
        eq(builders.id, invite.builder_id),
        eq(userBuilderMemberships.user_id, userId),
      ),
    )
    .limit(1);
  const membership = rows[0];
  if (!membership) throw new Error('Invite claim did not produce a membership');
  const entitlement = requireEntitlementContext({
    plan: membership.plan,
    access_state: membership.access_state,
    entitlement_source: membership.entitlement_source,
  });

  log.info(
    { builderId: invite.builder_id, inviteId: invite.id, userId },
    'pending invite accepted during authentication',
  );
  return {
    builderId: invite.builder_id,
    slug: membership.slug,
    role: membership.role as RoleType,
    ...entitlement,
    isNew: false,
    acceptedInviteId: invite.id,
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
  const hosted = env.PYLVA_DEPLOYMENT_MODE === 'hosted';
  if (hosted) {
    await assertHostedProvisionalSignupEnabledTx(tx);
  }

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
        tier: null,
        access_state: hosted
          ? BuilderAccessState.CHECKOUT_REQUIRED
          : BuilderAccessState.ACTIVE,
        entitlement_source: hosted ? null : EntitlementSource.SELF_HOSTED,
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
        plan: builders.tier,
        access_state: builders.access_state,
        entitlement_source: builders.entitlement_source,
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
  const entitlement = entitlementContextOrNull(row.builder_id, {
    plan: row.plan,
    access_state: row.access_state,
    entitlement_source: row.entitlement_source,
  });
  if (entitlement === null) return null;
  return {
    builderId: row.builder_id,
    slug: row.slug,
    role: row.role as RoleType,
    ...entitlement,
    isNew: false,
    acceptedInviteId: null,
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
      plan: builders.tier,
      access_state: builders.access_state,
      entitlement_source: builders.entitlement_source,
    })
    .from(builders)
    .innerJoin(userBuilderMemberships, eq(userBuilderMemberships.builder_id, builders.id))
    .where(and(eq(builders.slug, input.slug), eq(userBuilderMemberships.user_id, input.userId)))
    .limit(1);
  if (rows.length === 0) return null;
  const row = rows[0]!;
  const entitlement = entitlementContextOrNull(row.builder_id, {
    plan: row.plan,
    access_state: row.access_state,
    entitlement_source: row.entitlement_source,
  });
  if (entitlement === null) return null;
  return {
    builderId: row.builder_id,
    role: row.role as RoleType,
    ...entitlement,
  };
}

/** Test helper — expose the private slugify fn to tests. */
export const _internal = { slugify, suffixed };
