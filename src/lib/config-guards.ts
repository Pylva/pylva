// Boot-time guards for security-critical secrets. Kept separate from config.ts
// (which only parses/validates shape) because these rules are conditional on
// NODE_ENV and would otherwise break the seed/CLI/test flows that intentionally
// use the documented dev values.

import { env } from './config.js';

const DEV_ARGON2_SECRET = 'dev-secret-change-in-prod';
const MIN_SECRET_BYTES = 32;

/**
 * Refuse to boot in production if security-critical secrets are left at their
 * dev defaults or are too weak. No-op outside production so local/dev/test and
 * the seed/CLI scripts keep working with the documented dev values.
 * Throws with an aggregated message listing every problem found.
 */
export function validateProductionSecrets(): void {
  if (env.NODE_ENV !== 'production') return;

  const problems: string[] = [];
  if (env.ARGON2_SECRET === DEV_ARGON2_SECRET) {
    problems.push('ARGON2_SECRET is still the dev default — set a unique value');
  }
  if (Buffer.byteLength(env.ARGON2_SECRET) < MIN_SECRET_BYTES) {
    problems.push(`ARGON2_SECRET must be at least ${MIN_SECRET_BYTES} bytes`);
  }

  if (!env.OAUTH_STATE_SECRET) {
    // Non-fatal: OAuth-state HMAC falls back to ARGON2_SECRET. Warn so operators
    // know the two trust domains are not yet separated.
    console.warn('[config] OAUTH_STATE_SECRET is unset; OAuth state falls back to ARGON2_SECRET');
  }

  if (problems.length > 0) {
    throw new Error(`Refusing to boot in production: ${problems.join('; ')}`);
  }
}
