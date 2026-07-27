// JWT auth via jose — Decision #4
// RS256, dev: file keys, prod: KMS key IDs
// Sliding window refresh at 50% token lifetime — Decision #10
// Dashboard JWTs carry user + role plus informational plan/access claims.
// Authorization must still resolve current entitlement from PostgreSQL.

import { SignJWT, jwtVerify, importPKCS8, importSPKI, type CryptoKey, type KeyObject } from 'jose';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { env } from '../config.js';
import {
  BuilderAccessState,
  isBuilderAccessState,
  isBuilderPlan,
  JwtAudience,
  type BuilderAccessState as BuilderAccessStateValue,
  type BuilderPlan,
  type Role,
} from '@pylva/shared';
import { ensureRedisCommandClient, redisClient } from '../redis/client.js';
import { revocationBreaker } from '../redis/circuit-breaker.js';

type JoseKey = CryptoKey | KeyObject;

let _privateKey: JoseKey | null = null;
let _publicKey: JoseKey | null = null;

async function getPrivateKey(): Promise<JoseKey> {
  if (_privateKey) return _privateKey;
  const pem = await fs.readFile(env.JWT_PRIVATE_KEY, 'utf-8');
  _privateKey = await importPKCS8(pem, 'RS256');
  return _privateKey;
}

async function getPublicKey(): Promise<JoseKey> {
  if (_publicKey) return _publicKey;
  const pem = await fs.readFile(env.JWT_PUBLIC_KEY, 'utf-8');
  _publicKey = await importSPKI(pem, 'RS256');
  return _publicKey;
}

export interface SignJwtOptions {
  builder_id: string;
  audience: string;
  expiresIn?: string;
  /** Stable revocation family shared by every sliding refresh of one session. */
  session_id?: string;
  // Dashboard tokens carry user identity plus informational entitlement data.
  user_id?: string;
  /** Active dashboard organization; additive for legacy-token compatibility. */
  org_slug?: string;
  role?: Role;
  plan?: BuilderPlan | null;
  access_state?: BuilderAccessStateValue;
  /** @deprecated Compatibility alias emitted only for an active paid plan. */
  tier?: BuilderPlan;
  // Customer-id for portal audience; retained for B3.
  customer_id?: string;
  additionalClaims?: Record<string, unknown>;
}

const DEFAULT_EXPIRATION: Record<string, string> = {
  [JwtAudience.DASHBOARD]: '24h',
  [JwtAudience.PORTAL]: '24h',
  [JwtAudience.WEBSOCKET]: '1h',
};

const RESERVED_JWT_CLAIMS = new Set([
  'access_state',
  'aud',
  'builder_id',
  'customer_id',
  'exp',
  'iat',
  'iss',
  'jti',
  'nbf',
  'org_slug',
  'plan',
  'role',
  'sid',
  'sub',
  'tier',
  'user_id',
]);

export async function signJwt(options: SignJwtOptions): Promise<string> {
  for (const claim of Object.keys(options.additionalClaims ?? {})) {
    if (RESERVED_JWT_CLAIMS.has(claim)) {
      throw new Error(`additionalClaims cannot override reserved JWT claim: ${claim}`);
    }
  }

  const hasEntitlementClaims =
    options.plan !== undefined || options.access_state !== undefined || options.tier !== undefined;
  if (hasEntitlementClaims && (options.plan === undefined || options.access_state === undefined)) {
    throw new Error('Dashboard entitlement claims require both plan and access_state');
  }
  if (options.plan !== undefined && options.plan !== null && !isBuilderPlan(options.plan)) {
    throw new Error('Dashboard token plan claim is invalid');
  }
  if (options.access_state !== undefined && !isBuilderAccessState(options.access_state)) {
    throw new Error('Dashboard token access_state claim is invalid');
  }
  if (
    options.tier !== undefined &&
    (options.access_state !== BuilderAccessState.ACTIVE ||
      options.plan === null ||
      options.tier !== options.plan)
  ) {
    throw new Error('Deprecated tier claim must match an active paid plan');
  }
  if (
    options.plan !== undefined &&
    options.plan !== null &&
    options.access_state !== BuilderAccessState.ACTIVE
  ) {
    throw new Error('A non-active dashboard token cannot carry a paid plan');
  }

  const privateKey = await getPrivateKey();
  const jti = crypto.randomUUID();
  const expiresIn = options.expiresIn ?? DEFAULT_EXPIRATION[options.audience] ?? '24h';

  const claims: Record<string, unknown> = {
    ...options.additionalClaims,
    builder_id: options.builder_id,
    ...(options.user_id ? { user_id: options.user_id } : {}),
    ...(options.org_slug ? { org_slug: options.org_slug } : {}),
    ...(options.role ? { role: options.role } : {}),
    ...(options.plan !== undefined ? { plan: options.plan } : {}),
    ...(options.access_state !== undefined ? { access_state: options.access_state } : {}),
    ...(options.tier !== undefined ? { tier: options.tier } : {}),
    ...(options.customer_id ? { customer_id: options.customer_id } : {}),
    // Keep the JWT ID unique per token while giving every refresh branch one
    // stable revocation identity. Without this, two refreshes of a stolen
    // cookie mint unrelated jtis and logout can revoke only one branch.
    sid: options.session_id ?? jti,
  };

  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256' })
    .setJti(jti)
    .setAudience(options.audience)
    .setIssuedAt()
    .setExpirationTime(expiresIn);

  return jwt.sign(privateKey);
}

export interface VerifyJwtResult {
  builder_id: string;
  jti: string;
  aud: string;
  iat: number;
  exp: number;
  sid?: string;
  /** Redis revocation key: sid for refreshed sessions, jti for legacy tokens. */
  revocation_id: string;
  user_id?: string;
  org_slug?: string;
  role?: Role;
  plan?: BuilderPlan | null;
  access_state?: BuilderAccessStateValue;
  /** @deprecated Compatibility claim from the staged plan migration. */
  tier?: string;
  customer_id?: string;
  [key: string]: unknown;
}

export async function verifyJwt(token: string, expectedAudience: string): Promise<VerifyJwtResult> {
  const publicKey = await getPublicKey();

  const { payload } = await jwtVerify(token, publicKey, {
    audience: expectedAudience,
    algorithms: ['RS256'],
  });

  const jti = payload.jti;
  if (!jti) throw new Error('Missing jti claim');

  // Tokens minted before session families were introduced have no sid; their
  // jti remains the revocation identity and is propagated on the first refresh.
  const revocationId =
    typeof payload.sid === 'string' && payload.sid.length > 0 ? payload.sid : jti;
  const isRevoked = await checkRevocation(revocationId, expectedAudience);
  if (isRevoked) throw new Error('Token has been revoked');

  return { ...payload, revocation_id: revocationId } as unknown as VerifyJwtResult;
}

/**
 * Revoke a JWT session family by storing its stable revocation id as an
 * individual Redis key. TTL = remaining token lifetime (auto-cleanup).
 */
export async function revokeJwt(
  revocationId: string,
  audience: string,
  remainingTtlSeconds: number,
): Promise<void> {
  const key = `REVOKED_TOKEN:${audience}:${revocationId}`;
  await redisClient.set(key, '1', { EX: Math.max(remainingTtlSeconds, 60) });
}

/**
 * Sliding-window refresh — Decision #10.
 * Preserves validated informational entitlement claims on rotation. Legacy
 * tokens that carry only `tier` deliberately lose that stale claim; middleware
 * reloads authoritative entitlement state before authorizing product access.
 */
export async function refreshJwtIfNeeded(payload: VerifyJwtResult): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  const iat = payload.iat;
  const exp = payload.exp;
  const lifetime = exp - iat;
  const elapsed = now - iat;

  if (elapsed < lifetime * 0.5) return null;

  return signJwt({
    builder_id: payload.builder_id,
    audience: payload.aud,
    session_id: payload.revocation_id,
    ...(payload.user_id ? { user_id: payload.user_id } : {}),
    ...(payload.org_slug ? { org_slug: payload.org_slug } : {}),
    ...(payload.role ? { role: payload.role } : {}),
    ...(payload.plan !== undefined ? { plan: payload.plan } : {}),
    ...(payload.access_state !== undefined ? { access_state: payload.access_state } : {}),
    ...(payload.plan !== null &&
    payload.plan !== undefined &&
    payload.access_state === BuilderAccessState.ACTIVE &&
    isBuilderPlan(payload.tier)
      ? { tier: payload.tier }
      : {}),
    ...(payload.customer_id ? { customer_id: payload.customer_id } : {}),
  });
}

// Audiences where a failed revocation check must fail CLOSED: if we cannot
// confirm a dashboard/portal token is still valid (Redis down or breaker open),
// treat it as revoked and force re-auth rather than honor a possibly-revoked
// 24h session token. WEBSOCKET (1h, low-sensitivity realtime) stays fail-open so
// a transient Redis blip does not drop live feeds.
const FAIL_CLOSED_AUDIENCES = new Set<string>([JwtAudience.DASHBOARD, JwtAudience.PORTAL]);

export async function checkRevocation(jti: string, audience: string): Promise<boolean> {
  const failClosed = FAIL_CLOSED_AUDIENCES.has(audience);
  try {
    const result = (await revocationBreaker.fire(async () => {
      // Middleware module graph never ran instrumentation's connectRedis —
      // without this, every revocation check failed open (redis/client.ts).
      await ensureRedisCommandClient();
      return redisClient.exists(`REVOKED_TOKEN:${audience}:${jti}`);
    })) as number | null;
    if (result === null) {
      // Breaker open / fallback — revocation state is unknown.
      if (failClosed) {
        console.warn('[jwt] revocation check unavailable, failing closed (treating as revoked)');
        return true;
      }
      return false;
    }
    return result > 0;
  } catch {
    if (failClosed) {
      console.warn('[jwt] revocation check failed, failing closed (treating as revoked)');
      return true;
    }
    console.warn('[jwt] revocation check failed, allowing request (fail-open)');
    return false;
  }
}
