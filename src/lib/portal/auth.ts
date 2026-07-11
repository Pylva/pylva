// SPDX-License-Identifier: Elastic-2.0
// Track 4 PR 4.2 — portal auth helper.
// Per internal design notes
// (O7 + O8 + O36).
//
// Verifies a portal JWT (audience=pylva:portal), checks the link is
// still active in portal_links, and resolves it to a portal_sessions row
// (creating one on first visit). The 8h hard cap + sliding window are
// enforced inline.
//
// Rate limit: 60 req/min per JTI via Redis sliding window. Exceed →
// 429 with Retry-After.

import { and, eq } from 'drizzle-orm';
import { JwtAudience, PortalLinkStatus, PortalLinkType } from '@pylva/shared';
import { verifyJwt } from '../auth/jwt.js';
import { withRLS } from '../db/rls.js';
import { db } from '../db/client.js';
import { portalLinks, portalSessions } from '../db/schema.js';
import { redisClient } from '../redis/client.js';
import { rateLimitBreaker } from '../redis/circuit-breaker.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'portal.auth' });

// O7/O8: 8h hard cap, sliding within window.
const HARD_TTL_MS = 8 * 60 * 60 * 1000;
const SLIDING_TTL_MS = 8 * 60 * 60 * 1000;

// O36: 60 req/min per JTI Redis sliding window.
const RATE_LIMIT_REQUESTS = 60;
const RATE_LIMIT_WINDOW_SEC = 60;

export interface PortalAuthContext {
  builderId: string;
  customerId: string;
  jti: string;
  linkId: string;
  sessionExpiresAt: Date;
}

export type PortalAuthOutcome =
  | { kind: 'ok'; ctx: PortalAuthContext }
  | { kind: 'unauthenticated'; reason: string }
  | { kind: 'expired'; reason: string }
  | { kind: 'rate_limited'; retryAfterSec: number };

/**
 * Verify a portal token, refresh the sliding session, enforce the
 * 60 req/min per-JTI rate limit. Caller (portal data routes / pages)
 * receives back a customer-scoped context.
 */
export async function authenticatePortalToken(token: string): Promise<PortalAuthOutcome> {
  let payload;
  try {
    payload = await verifyJwt(token, JwtAudience.PORTAL);
  } catch (err) {
    return {
      kind: 'unauthenticated',
      reason: err instanceof Error ? err.message : 'invalid token',
    };
  }

  if (!payload.builder_id || !payload.customer_id || !payload.jti) {
    return { kind: 'unauthenticated', reason: 'missing required claims' };
  }

  // O36: rate limit before doing PG work.
  const allowed = await rateCheck(payload.jti);
  if (!allowed) return { kind: 'rate_limited', retryAfterSec: RATE_LIMIT_WINDOW_SEC };

  // Confirm the underlying link is still active.
  const linkRows = await db
    .select({
      id: portalLinks.id,
      status: portalLinks.status,
      link_type: portalLinks.link_type,
      expires_at: portalLinks.expires_at,
      first_used_at: portalLinks.first_used_at,
      grace_expires_at: portalLinks.grace_expires_at,
    })
    .from(portalLinks)
    .where(and(eq(portalLinks.jti, payload.jti), eq(portalLinks.builder_id, payload.builder_id)))
    .limit(1);

  const link = linkRows[0];
  if (!link) return { kind: 'unauthenticated', reason: 'link not found' };
  if (link.status !== PortalLinkStatus.ACTIVE) {
    return { kind: 'expired', reason: `link status=${link.status}` };
  }
  if (link.expires_at.getTime() < Date.now()) {
    return { kind: 'expired', reason: 'link expired' };
  }

  // v1.1 follow-up — single-use claim path. First visit stamps
  // first_used_at + a 5-minute grace_expires_at; subsequent visits
  // within grace are accepted (so the customer can refresh / open the
  // link in their actual browser); after grace, the link flips to USED
  // and is rejected on the next request.
  if (link.link_type === PortalLinkType.SINGLE_USE) {
    const nowMs = Date.now();
    if (!link.first_used_at) {
      const grace = new Date(nowMs + 5 * 60 * 1000);
      await db
        .update(portalLinks)
        .set({ first_used_at: new Date(nowMs), grace_expires_at: grace })
        .where(eq(portalLinks.jti, payload.jti));
    } else if (link.grace_expires_at && link.grace_expires_at.getTime() < nowMs) {
      // Past grace — flip to USED so even a sliding session can't
      // resurrect it on the next tick.
      await db
        .update(portalLinks)
        .set({ status: PortalLinkStatus.USED })
        .where(eq(portalLinks.jti, payload.jti));
      return { kind: 'expired', reason: 'single_use grace exhausted' };
    }
  }

  // Sliding session: read existing or create on first visit.
  const now = new Date();
  const session = await withRLS(payload.builder_id, async (tx) => {
    const existing = await tx
      .select()
      .from(portalSessions)
      .where(eq(portalSessions.jti, payload.jti!))
      .limit(1);

    if (existing.length === 0) {
      // First exchange — create the session row.
      const [created] = await tx
        .insert(portalSessions)
        .values({
          jti: payload.jti!,
          builder_id: payload.builder_id,
          customer_id: payload.customer_id!,
          link_id: link.id,
          issued_at: now,
          last_activity_at: now,
          hard_expires_at: new Date(now.getTime() + HARD_TTL_MS),
        })
        .returning();
      return created;
    }

    const row = existing[0]!;
    // Hard cap: 8h from issued.
    if (row.hard_expires_at.getTime() < now.getTime()) return null;
    // Sliding: 8h since last_activity.
    if (now.getTime() - row.last_activity_at.getTime() > SLIDING_TTL_MS) return null;

    // Bump last_activity_at on each request.
    await tx
      .update(portalSessions)
      .set({ last_activity_at: now })
      .where(eq(portalSessions.jti, payload.jti!));

    return row;
  });

  if (!session) return { kind: 'expired', reason: 'session expired' };

  return {
    kind: 'ok',
    ctx: {
      builderId: payload.builder_id,
      customerId: payload.customer_id!,
      jti: payload.jti!,
      linkId: link.id,
      sessionExpiresAt: session.hard_expires_at,
    },
  };
}

async function rateCheck(jti: string): Promise<boolean> {
  const key = `portal_rl:${jti}`;
  try {
    const result = await rateLimitBreaker.fire(async () => {
      const count = await redisClient.incr(key);
      if (count === 1) {
        await redisClient.expire(key, RATE_LIMIT_WINDOW_SEC);
      }
      return count <= RATE_LIMIT_REQUESTS;
    });
    return Boolean(result);
  } catch (err) {
    log.warn(
      { jti, error: err instanceof Error ? err.message : String(err) },
      'portal rate-limit redis fail-open',
    );
    return true; // Fail open — preferable to a redis blip locking out a real customer.
  }
}
