// Post-auth `next` redirect: return the user to the dashboard page they were
// on before their session expired (middleware sets /login?next={pathname}).
//
// Open-redirect hardening: `next` is only ever honored when it matches a
// strict same-origin dashboard-path allowlist — a relative /o/{slug}/dashboard
// subtree path over a conservative character set (no scheme, no host, no
// `//`, no dots, no query/fragment). Anything else falls back to the default
// org dashboard. The OAuth flow carries `next` inside the HMAC-signed state
// value, so it also cannot be tampered with in transit.

const OAUTH_STATE_PREFIX = 'v1.';
const MAX_NEXT_LENGTH = 200;

// /o/{slug}/dashboard[/...] — slug mirrors the generator's charset
// (lowercase alnum + hyphen); the trailing path allows only alnum, hyphen,
// underscore and slashes, which covers every dashboard route (ids are UUIDs).
const AUTH_NEXT_PATTERN = /^\/o\/[a-z0-9][a-z0-9-]{0,62}\/dashboard(?:\/[A-Za-z0-9\-_/]*)?$/;

declare const dashboardAuthNextBrand: unique symbol;
export type DashboardAuthNextPath = string & { readonly [dashboardAuthNextBrand]: true };
/** A `next` path that passed validateAuthNext — the only form ever redirected to. */
export type AllowedAuthNextPath = DashboardAuthNextPath;

export function validateAuthNext(value: string | null | undefined): AllowedAuthNextPath | null {
  if (!value || value.length > MAX_NEXT_LENGTH) return null;
  if (!AUTH_NEXT_PATTERN.test(value)) return null;
  if (value.includes('//')) return null;
  return value as AllowedAuthNextPath;
}

export function isDashboardAuthNext(next: AllowedAuthNextPath): next is DashboardAuthNextPath {
  return AUTH_NEXT_PATTERN.test(next);
}

/** Org slug segment of a validated dashboard next path (`/o/{slug}/dashboard/...`). */
export function nextPathOrgSlug(next: DashboardAuthNextPath): string {
  return next.split('/')[2]!;
}

export function authHrefWithNext(href: string, next: string | null | undefined): string {
  const safeNext = validateAuthNext(next);
  if (!safeNext) return href;
  const separator = href.includes('?') ? '&' : '?';
  return `${href}${separator}next=${encodeURIComponent(safeNext)}`;
}

/**
 * Where to land after a successful login. `next` is honored only when it
 * belongs to the org the freshly minted session targets (callers resolve
 * membership and may mint for the next-path's org — see the OAuth callback);
 * any mismatch falls back to that org's dashboard home.
 */
export function buildPostAuthRedirectUrl(params: {
  baseUrl: string;
  orgSlug: string;
  next?: string | null;
}): string {
  const safeNext = validateAuthNext(params.next);
  if (
    safeNext &&
    isDashboardAuthNext(safeNext) &&
    nextPathOrgSlug(safeNext) === params.orgSlug
  ) {
    return `${params.baseUrl}${safeNext}`;
  }
  return `${params.baseUrl}/o/${params.orgSlug}/dashboard`;
}

/**
 * OAuth `state` value. Bare nonce when there is no next; otherwise a
 * versioned base64url envelope carrying both. The whole raw value is
 * HMAC-signed (oauth.ts), so the embedded next is tamper-proof.
 */
export function encodeOAuthStateValue(nonce: string, next: string | null | undefined): string {
  const safeNext = validateAuthNext(next);
  if (!safeNext) return nonce;
  const payload = Buffer.from(JSON.stringify({ nonce, next: safeNext }), 'utf8').toString(
    'base64url',
  );
  return `${OAUTH_STATE_PREFIX}${payload}`;
}

export function decodeOAuthStateNext(raw: string): AllowedAuthNextPath | null {
  if (!raw.startsWith(OAUTH_STATE_PREFIX)) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(raw.slice(OAUTH_STATE_PREFIX.length), 'base64url').toString('utf8'),
    ) as { next?: unknown };
    return validateAuthNext(typeof payload.next === 'string' ? payload.next : null);
  } catch {
    return null;
  }
}
