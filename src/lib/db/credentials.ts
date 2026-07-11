// Runtime DB password provider — survives RDS-managed master-password rotation.
//
// RDS/Aurora `manage_master_user_password = true` rotates the master password
// into Secrets Manager on AWS's own schedule, uncoordinated with the app. The
// old design baked the password into DATABASE_URL once at container start, so
// after a rotation every NEW postgres.js connection authenticated with a stale
// password and failed ("password authentication failed for user pylva")
// until a manual ECS redeploy.
//
// This provider fetches the CURRENT password from the RDS-managed secret. It is
// wired into the postgres.js pool as the `password` function (see db/client.ts),
// which porsager/postgres calls per new connection — so a rotated password is
// picked up automatically with no restart.
//
// Caching: a short TTL dampens reconnect storms (and the per-connection call
// cost) while keeping post-rotation recovery bounded to ~TTL. On a fetch error
// we serve the last-known-good password if we have one (graceful degradation
// through a transient Secrets Manager blip) and only throw when the cache is
// empty.

import { getSecretString } from '../aws/secrets.js';
import { env } from '../config.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'db.credentials' });

// Bounds both the worst-case post-rotation failure window and the per-connection
// Secrets Manager call rate. Rotations are rare (≈weekly), so a few seconds of
// staleness on a fresh connection is an acceptable trade for storm dampening.
const CREDENTIAL_TTL_MS = 30_000;

interface CachedPassword {
  password: string;
  fetchedAt: number;
}

let cache: CachedPassword | undefined;
let refreshPromise: Promise<string> | undefined;

interface RdsMasterSecret {
  username?: string;
  password?: string;
}

async function fetchPassword(arn: string): Promise<string> {
  const secret = JSON.parse(await getSecretString(arn)) as RdsMasterSecret;
  if (!secret.password) throw new Error('RDS master secret is missing password');
  return secret.password;
}

async function refreshPassword(arn: string): Promise<string> {
  try {
    const password = await fetchPassword(arn);
    cache = { password, fetchedAt: Date.now() };
    return password;
  } catch (err) {
    if (cache) {
      const stalePassword = cache.password;
      cache = { password: stalePassword, fetchedAt: Date.now() };
      log.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'db credential refresh failed; serving last-known-good password',
      );
      return stalePassword;
    }
    throw err;
  }
}

/**
 * Resolve the current database password from the RDS-managed master secret.
 * Throws if `DB_MASTER_USER_SECRET_ARN` is unset — callers gate on that ARN
 * before wiring this provider (local/dev/test use the static DATABASE_URL).
 */
export async function getDbPassword(): Promise<string> {
  const arn = env.DB_MASTER_USER_SECRET_ARN;
  if (!arn) throw new Error('DB_MASTER_USER_SECRET_ARN is not set');

  if (cache && Date.now() - cache.fetchedAt < CREDENTIAL_TTL_MS) {
    return cache.password;
  }

  if (!refreshPromise) {
    refreshPromise = refreshPassword(arn).finally(() => {
      refreshPromise = undefined;
    });
  }

  return refreshPromise;
}

/** Test-only: clear the cached password so the next call refetches. */
export function _resetDbCredentialCache(): void {
  cache = undefined;
  refreshPromise = undefined;
}
