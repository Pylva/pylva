import { test, expect } from '@playwright/test';

// Login redirects from protected pages must be built from the configured
// public origin (OAUTH_REDIRECT_BASE_URL), never from the incoming request
// host. Pre-fix, the Location header echoed whatever host the request
// arrived on — in production that was the server bind address
// (https://0.0.0.0:3000), a dead link for real users.
//
// Next relativizes Locations it considers same-origin with the deployment
// (both a relative `/login?...` and an absolute configured-origin URL are
// safe outcomes), so the middleware-level origin choice is pinned by the
// unit tests in tests/auth/. What this e2e asserts is the user-visible
// safety property: the Location is never an absolute URL on some other
// host — which is exactly what production emitted pre-fix.

test('login redirect Location never points at a foreign host', async ({
  request,
  baseURL,
}) => {
  const base = new URL(baseURL ?? 'http://localhost:3000');
  test.skip(base.hostname !== 'localhost', 'needs a localhost baseURL to vary the request host');

  const altHost = new URL(base.toString());
  altHost.hostname = '127.0.0.1';

  const response = await request.get(new URL('/o/e2e-probe/dashboard', altHost).toString(), {
    maxRedirects: 0,
  });

  expect(response.status()).toBe(307);
  const location = response.headers()['location'] ?? '';
  const safe = location.startsWith('/login') || location.startsWith(`${base.origin}/login`);
  expect(safe, `unexpected Location: ${location}`).toBe(true);
});
