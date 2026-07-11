// Launch perf — Redis-cached slug→membership resolution for middleware.
//
// resolveSlugForUser() runs a builders × user_builder_memberships JOIN on
// EVERY /o/{slug}/* request (page navs, RSC fetches, prefetches). Strategy
// mirrors src/lib/portal/iframe-csp.ts:
//   1. 30s Redis TTL bounds staleness — a role change / removal can be
//      honored up to 30s late for page renders. Negative results are NEVER
//      cached: a 404 always re-checks Postgres, so an invite-accept redirect
//      can't race a stale miss.
//   2. Every Redis call goes through cacheBreaker — any Redis failure falls
//      open to the direct Postgres path (identical to pre-cache behavior).
//
// CONTRACT: any future endpoint that mutates user_builder_memberships
// (member remove, role change) MUST call invalidateMembershipCache(userId,
// slug) after the write. Today the only mutation is invite-accept.

import { Role } from '@pylva/shared';
import { resolveSlugForUser, type MembershipContext } from './org.js';
import { ensureRedisCommandClient, redisClient } from '../redis/client.js';
import { cacheBreaker } from '../redis/circuit-breaker.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'auth.membership-cache' });

const REDIS_TTL_SEC = 30;

// Known membership roles, derived from the shared Role enum so a new role
// auto-applies here. Used to reject garbage cached roles in parseCached().
const VALID_ROLES = Object.values(Role) as string[];

function cacheKey(userId: string, slug: string): string {
  return `membership:${userId}:${slug}`;
}

function parseCached(raw: string): MembershipContext | null {
  try {
    const value = JSON.parse(raw) as Partial<MembershipContext>;
    if (
      typeof value.builderId === 'string' &&
      typeof value.role === 'string' &&
      // Narrow to the known Role enum — a garbage cached role (future
      // serialization bug / key corruption) must re-check Postgres, never
      // reach the x-user-role header.
      VALID_ROLES.includes(value.role) &&
      typeof value.tier === 'string'
    ) {
      return value as MembershipContext;
    }
  } catch {
    /* malformed entry — fall through to Postgres */
  }
  return null;
}

/** Drop-in replacement for resolveSlugForUser with a 30s Redis cache. */
export async function resolveSlugForUserCached(input: {
  slug: string;
  userId: string;
}): Promise<MembershipContext | null> {
  const key = cacheKey(input.userId, input.slug);

  try {
    // ensure*: middleware runs in its own module graph where the eager
    // instrumentation connect never happened (see redis/client.ts).
    const cached = await cacheBreaker.fire(async () => {
      await ensureRedisCommandClient();
      return redisClient.get(key);
    });
    if (typeof cached === 'string') {
      const parsed = parseCached(cached);
      if (parsed) return parsed;
    }
  } catch {
    /* breaker open / Redis error — fall through to Postgres */
  }

  const ctx = await resolveSlugForUser(input);
  if (!ctx) return null; // never cache negatives

  try {
    await cacheBreaker.fire(async () => {
      await ensureRedisCommandClient();
      return redisClient.set(key, JSON.stringify(ctx), { EX: REDIS_TTL_SEC });
    });
  } catch {
    /* cache write failure is non-fatal */
  }

  return ctx;
}

/** Drop a cached membership after a mutation. Safe to call when absent. */
export async function invalidateMembershipCache(userId: string, slug: string): Promise<void> {
  try {
    await cacheBreaker.fire(async () => {
      await ensureRedisCommandClient();
      return redisClient.del(cacheKey(userId, slug));
    });
  } catch (err) {
    // TTL still bounds staleness at 30s even when the delete fails.
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'membership cache invalidation failed',
    );
  }
}
