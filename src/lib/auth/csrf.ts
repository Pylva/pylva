// CSRF defense for cookie-authenticated, state-changing dashboard requests.
// The dashboard is served from the canonical site origin, so a same-origin check
// (Origin header, with Sec-Fetch-Site as fallback) cleanly separates legitimate
// dashboard mutations from cross-site forgery. Complements the SameSite=Lax
// session cookie. NOT applied to the portal audience, whose custom-domain
// deployments legitimately originate from other hosts.

import { type NextRequest, type NextResponse } from 'next/server.js';
import { ErrorCode } from '@pylva/shared';
import { forbiddenError } from '../errors.js';
import { env } from '../config.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const ALLOWED_ORIGINS = new Set(
  [env.PUBLIC_SITE_URL, env.OAUTH_REDIRECT_BASE_URL, env.PYLVA_BACKEND_URL]
    .map((u) => {
      try {
        return new URL(u).origin;
      } catch {
        return null;
      }
    })
    .filter((o): o is string => o !== null),
);

function originAllowed(origin: string): boolean {
  try {
    return ALLOWED_ORIGINS.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

/**
 * Returns a 403 response if a state-changing request looks cross-site, else null.
 * Safe methods (GET/HEAD/OPTIONS) always pass. An Origin header must match an
 * allowed origin; absent that, Sec-Fetch-Site must be same-origin/none. When
 * neither header is present (non-browser client, or a same-origin fetch that
 * omits Origin) the SameSite=Lax cookie is the backstop and the request proceeds.
 */
export function assertSameOrigin(request: NextRequest): NextResponse | null {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null;

  const origin = request.headers.get('origin');
  if (origin) {
    return originAllowed(origin)
      ? null
      : forbiddenError(ErrorCode.INSUFFICIENT_PERMISSIONS, 'Cross-origin request rejected');
  }

  const site = request.headers.get('sec-fetch-site');
  if (site) {
    return site === 'same-origin' || site === 'none'
      ? null
      : forbiddenError(ErrorCode.INSUFFICIENT_PERMISSIONS, 'Cross-site request rejected');
  }

  return null;
}
