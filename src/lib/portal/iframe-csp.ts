// SPDX-License-Identifier: Elastic-2.0
// v1.1 follow-up — portal CSP frame-ancestors derived from
// portal_configs.allowed_iframe_origins.
//
// Strategy:
//   1. Decode the portal JWT *without* verifying — we only need
//      builder_id to look up the config. Middleware can't do PG +
//      JWT-verify cheaply; the actual auth happens inside the portal
//      route. This is fine because frame-ancestors is a defense-in-
//      depth header, not the primary auth boundary.
//   2. Cache (builder_id → origins) in Redis with 60s TTL so we don't
//      hit PG on every portal request.
//   3. Fall back to "frame-ancestors 'self'" when the token is missing,
//      malformed, or the lookup fails — the v1 baseline.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { portalConfigs } from '../db/schema.js';
import { ensureRedisCommandClient, redisClient } from '../redis/client.js';
import { cacheBreaker } from '../redis/circuit-breaker.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'portal.iframe-csp' });

const REDIS_TTL_SEC = 60;
const SELF_DIRECTIVE = "frame-ancestors 'self'";

interface DecodedJwt {
  builder_id?: string;
  jti?: string;
}

function decodeJwtUnsafe(token: string): DecodedJwt | null {
  try {
    const [, payload] = token.split('.');
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as DecodedJwt;
  } catch {
    return null;
  }
}

async function getOriginsCached(builderId: string): Promise<string[] | null> {
  const key = `portal_origins:${builderId}`;
  try {
    // Middleware module graph: lazily connect (see redis/client.ts) — this
    // cache was dead in middleware before, falling through to PG every time.
    const cached = await cacheBreaker.fire(async () => {
      await ensureRedisCommandClient();
      return redisClient.get(key);
    });
    if (typeof cached === 'string') {
      return cached === '' ? [] : cached.split('\n');
    }
  } catch {
    /* fall through to PG */
  }

  const rows = await db
    .select({ allowed_iframe_origins: portalConfigs.allowed_iframe_origins })
    .from(portalConfigs)
    .where(eq(portalConfigs.builder_id, builderId))
    .limit(1);

  const origins = rows[0]?.allowed_iframe_origins ?? [];

  try {
    await cacheBreaker.fire(async () => {
      await ensureRedisCommandClient();
      return redisClient.set(key, origins.join('\n'), { EX: REDIS_TTL_SEC });
    });
  } catch {
    /* cache write failure is non-fatal */
  }

  return origins;
}

/**
 * Build the CSP frame-ancestors directive for a portal request. Token
 * is the JWT supplied via ?token= or Authorization header. Returns the
 * baseline 'self' directive on any miss.
 */
export async function buildPortalFrameAncestors(token: string | null): Promise<string> {
  if (!token) return SELF_DIRECTIVE;
  const decoded = decodeJwtUnsafe(token);
  if (!decoded?.builder_id) return SELF_DIRECTIVE;

  try {
    const origins = await getOriginsCached(decoded.builder_id);
    if (!origins || origins.length === 0) return SELF_DIRECTIVE;
    // Always include 'self' so direct-link visits keep working.
    return `frame-ancestors 'self' ${origins.join(' ')}`;
  } catch (err) {
    log.warn(
      { builder_id: decoded.builder_id, error: err instanceof Error ? err.message : String(err) },
      'frame-ancestors lookup failed — falling back to self',
    );
    return SELF_DIRECTIVE;
  }
}
