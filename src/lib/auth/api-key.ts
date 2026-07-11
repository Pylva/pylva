// API Key auth — Decision #18: Format pv_live_{keyId}_{randomPart}
// Decision #14: argon2 hashing
// Decision #2: Cache + Redis pub/sub invalidation
//
// Since migration 048 every key is universal: one key covers the SDK, admin,
// and import surfaces, so validation never branches on scope. The persisted
// scope value is kept only for display/audit; rows still carrying a pre-048
// value (deploy-window stragglers) authenticate exactly like universal keys.

import crypto from 'node:crypto';
import argon2 from 'argon2';
import { eq, and, isNull } from 'drizzle-orm';
import { ApiKeyScope } from '@pylva/shared';
import { db } from '../db/client.js';
import { apiKeys } from '../db/schema.js';
import { redisClient, redisPubSubClient } from '../redis/client.js';
import { cacheBreaker } from '../redis/circuit-breaker.js';
import { env } from '../config.js';
import { API_KEY_PATTERN } from './api-key-format.js';
export { API_KEY_PATTERN } from './api-key-format.js';

// In-memory cache: stores DB row data to skip the DB lookup, NOT the argon2 verify.
// argon2 verify still runs on every request to prevent keyId-only auth bypass.
const MAX_CACHE_SIZE = 10_000;
// Short TTL bounds how long a just-revoked key can keep authenticating on an
// instance that missed the Redis pub/sub invalidation (e.g. breaker open).
const CACHE_TTL_MS = 10_000;
const keyCache = new Map<
  string,
  {
    builderId: string;
    scope: string;
    keyHash: string;
    // When this cache entry should be re-read from the DB.
    expiresAt: number;
    // The key's real expiry from the DB row (ms epoch), or null if it never
    // expires. Checked on every cache hit so an expired key is not served for
    // up to the cache TTL.
    dbExpiresAt: number | null;
  }
>();

function pruneCache(): void {
  if (keyCache.size <= MAX_CACHE_SIZE) return;
  // Evict oldest entries (Map preserves insertion order)
  const toDelete = keyCache.size - MAX_CACHE_SIZE;
  let deleted = 0;
  for (const [k] of keyCache) {
    if (deleted >= toDelete) break;
    keyCache.delete(k);
    deleted++;
  }
}

// --- Key Generation ---

export interface GenerateApiKeyResult {
  plaintextKey: string;
  keyId: string;
}

type ApiKeyInsertClient = {
  insert: (table: typeof apiKeys) => {
    values: (values: typeof apiKeys.$inferInsert) => unknown;
  };
};

export async function generateApiKeyWithClient(
  client: ApiKeyInsertClient,
  builderId: string,
  label?: string,
): Promise<GenerateApiKeyResult> {
  const keyId = crypto.randomBytes(4).toString('hex'); // 8 hex chars
  const randomPart = crypto.randomBytes(16).toString('hex'); // 32 hex chars
  const plaintextKey = `pv_live_${keyId}_${randomPart}`;

  const keyHash = await argon2.hash(plaintextKey, {
    secret: Buffer.from(env.ARGON2_SECRET),
  });

  await client.insert(apiKeys).values({
    key_id: keyId,
    builder_id: builderId,
    key_hash: keyHash,
    scope: ApiKeyScope.UNIVERSAL,
    label: label ?? null,
  });

  return { plaintextKey, keyId };
}

export async function generateApiKey(
  builderId: string,
  label?: string,
): Promise<GenerateApiKeyResult> {
  return generateApiKeyWithClient(db, builderId, label);
}

// --- Key Validation ---

export interface ValidateApiKeyResult {
  builderId: string;
  /** Persisted scope value — display/audit only; never used for authorization. */
  scope: string;
  keyId: string;
}

export async function validateApiKey(key: string): Promise<ValidateApiKeyResult | null> {
  const match = key.match(API_KEY_PATTERN);
  if (!match) return null;

  const keyId = match[1]!;

  // Cache stores DB row data to avoid DB lookup; argon2 verify always runs.
  let builderId: string;
  let scope: string;
  let keyHash: string;

  const now = Date.now();
  const cached = keyCache.get(keyId);
  // Serve from cache only if the entry is fresh AND the key's real expiry has
  // not passed. Without the dbExpiresAt check a cache hit would honor an expired
  // key until the cache TTL lapsed.
  if (cached && cached.expiresAt > now && (cached.dbExpiresAt === null || cached.dbExpiresAt > now)) {
    builderId = cached.builderId;
    scope = cached.scope;
    keyHash = cached.keyHash;
  } else {
    // DB lookup by key_id (O(1) via unique index)
    const [row] = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.key_id, keyId), isNull(apiKeys.revoked_at)))
      .limit(1);

    if (!row) return null;

    // Check expiration
    if (row.expires_at && new Date(row.expires_at) < new Date()) return null;

    builderId = row.builder_id;
    scope = row.scope;
    keyHash = row.key_hash;

    // Cache the DB row (NOT the auth result)
    keyCache.set(keyId, {
      builderId,
      scope,
      keyHash,
      expiresAt: now + CACHE_TTL_MS,
      dbExpiresAt: row.expires_at ? new Date(row.expires_at).getTime() : null,
    });
    pruneCache();
  }

  // argon2 verify runs on EVERY request — cache only skips the DB lookup
  try {
    const valid = await argon2.verify(keyHash, key, {
      secret: Buffer.from(env.ARGON2_SECRET),
    });
    if (!valid) return null;
  } catch {
    return null;
  }

  return { builderId, scope, keyId };
}

// --- Key Revocation ---

export async function revokeApiKey(keyId: string, immediate: boolean): Promise<void> {
  if (immediate) {
    await db.update(apiKeys).set({ revoked_at: new Date() }).where(eq(apiKeys.key_id, keyId));
  } else {
    // Graceful: expire in 24 hours
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.update(apiKeys).set({ expires_at: expires }).where(eq(apiKeys.key_id, keyId));
  }

  // Best-effort cross-instance cache invalidation. The DB update above is the
  // source of truth, so a publish failure does NOT fail the revoke; other
  // instances fall back to the short cache TTL. Log loudly (error, not warn, and
  // detect the breaker-open fallback) so degraded propagation is visible.
  try {
    const published = await cacheBreaker.fire(async () =>
      redisClient.publish('api_key_revoked', keyId),
    );
    if (published === null) {
      console.error(
        '[api-key] revocation publish skipped (redis breaker open); relying on cache TTL',
      );
    }
  } catch (err) {
    console.error('[api-key] revocation publish failed; relying on cache TTL', err);
  }

  // Clear local cache immediately
  keyCache.delete(keyId);
}

// --- Key Rotation ---

export async function rotateApiKey(
  builderId: string,
  oldKeyId: string,
): Promise<GenerateApiKeyResult> {
  // Generate new key
  const newKey = await generateApiKey(builderId);

  // Gracefully expire old key (24h overlap)
  await revokeApiKey(oldKeyId, false);

  return newKey;
}

// --- Redis Pub/Sub Listener ---
// Must be called at server startup (not lazily)

export async function initApiKeyRevocationListener(): Promise<void> {
  await redisPubSubClient.subscribe('api_key_revoked', (keyId) => {
    keyCache.delete(keyId);
    console.log(`[api-key] cache cleared for revoked key_id: ${keyId}`);
  });
}
