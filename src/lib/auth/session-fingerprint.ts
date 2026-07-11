// Active-session fingerprint cookie. Companion to the httpOnly session JWT:
// a JS-readable marker of WHO is signed in (hashed) and which org their
// session targets, so an open dashboard tab can detect that the browser's
// single session slot now belongs to a different account (login in another
// tab silently overwrites the shared cookie) and surface it instead of
// failing with confusing 404s / wrong-org data.
//
// Value format: `${sessionFingerprint(userId)}.${orgSlug}`. The fingerprint
// is a truncated hash — never the raw user id — because the cookie is
// intentionally readable by client script. The slug half lets the overlay
// link to the now-active account's dashboard.

import crypto from 'node:crypto';

export const ACTIVE_SESSION_COOKIE = 'pylva_active_session';
export const SESSION_FINGERPRINT_PATTERN = /^[0-9a-f]{16}$/;

/** Truncated, non-reversible marker for "which user owns the session". */
export function sessionFingerprint(userId: string): string {
  return crypto.createHash('sha256').update(userId).digest('hex').slice(0, 16);
}

export function encodeActiveSessionValue(userId: string, orgSlug: string): string {
  return `${sessionFingerprint(userId)}.${orgSlug}`;
}

export function decodeActiveSessionValue(
  value: string | null | undefined,
): { fingerprint: string; slug: string } | null {
  if (!value) return null;
  const dot = value.indexOf('.');
  if (dot <= 0 || dot === value.length - 1) return null;
  const fingerprint = value.slice(0, dot);
  const slug = value.slice(dot + 1);
  if (!SESSION_FINGERPRINT_PATTERN.test(fingerprint) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) {
    return null;
  }
  return { fingerprint, slug };
}
