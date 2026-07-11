// Shared CRON_SECRET bearer guard for EventBridge-targeted cron routes.
//
// Every cron route previously inlined `header === \`Bearer ${secret}\`` —
// a non-constant-time comparison: `===` bails at the first differing
// character, so response timing leaks how long a correct prefix of the
// secret is. Hashing both sides first fixes the timing channel (digests
// are fixed-length, satisfying timingSafeEqual's equal-length requirement)
// and centralizes the fail-closed missing-secret behavior.

import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server.js';
import { env } from '../config.js';

export function verifyCronSecret(request: NextRequest): boolean {
  if (!env.CRON_SECRET) return false;
  const header = request.headers.get('authorization') ?? '';
  const provided = createHash('sha256').update(header).digest();
  const expected = createHash('sha256').update(`Bearer ${env.CRON_SECRET}`).digest();
  return timingSafeEqual(provided, expected);
}
