import { getSecretString } from '../aws/secrets.js';

const CREDENTIAL_TTL_MS = 30_000;

interface CachedCredential {
  arn: string;
  expectedUsername: string;
  fetchedAt: number;
  password: string;
}

interface DatabaseSecret {
  password?: unknown;
  username?: unknown;
}

let cache: CachedCredential | undefined;
let refreshPromise: Promise<string> | undefined;

async function fetchCredential(arn: string, expectedUsername: string): Promise<string> {
  let secret: DatabaseSecret;
  try {
    secret = JSON.parse(await getSecretString(arn)) as DatabaseSecret;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('budget-control database secret is not valid JSON');
    }
    throw error;
  }

  if (secret.username !== expectedUsername) {
    throw new Error('budget-control database secret username does not match its database URL');
  }
  if (typeof secret.password !== 'string' || secret.password.length === 0) {
    throw new Error('budget-control database secret is missing a password');
  }
  return secret.password;
}

/**
 * Resolve a rotating password for the exact login encoded in the dedicated
 * URL. Any refresh or identity mismatch fails closed; this control path never
 * serves a stale privileged credential after a Secrets Manager error.
 */
export async function getBudgetControlDbPassword(
  arn: string,
  expectedUsername: string,
): Promise<string> {
  if (
    cache &&
    cache.arn === arn &&
    cache.expectedUsername === expectedUsername &&
    Date.now() - cache.fetchedAt < CREDENTIAL_TTL_MS
  ) {
    return cache.password;
  }

  if (!refreshPromise) {
    refreshPromise = fetchCredential(arn, expectedUsername)
      .then((password) => {
        cache = { arn, expectedUsername, fetchedAt: Date.now(), password };
        return password;
      })
      .finally(() => {
        refreshPromise = undefined;
      });
  }
  return refreshPromise;
}

export function _resetBudgetControlCredentialCache(): void {
  cache = undefined;
  refreshPromise = undefined;
}
