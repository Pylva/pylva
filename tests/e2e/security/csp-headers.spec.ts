import { test, expect } from '@playwright/test';

// CSP + security header contract.
//
// Portal: per-builder frame-ancestors (set in src/middleware.ts).
// Login: must NOT be framed by arbitrary origins.

const PUBLIC = ['/login'];

for (const path of PUBLIC) {
  test(`security headers — ${path} carries baseline protections`, async ({ request }) => {
    const response = await request.get(path);
    expect(response.ok()).toBeTruthy();

    const headers = response.headers();
    // Either CSP frame-ancestors 'self' or X-Frame-Options DENY must protect
    // every authenticated/control surface from being framed by a remote host.
    const csp = headers['content-security-policy'] ?? '';
    const xfo = headers['x-frame-options'] ?? '';

    if (path === '/login') {
      const sameOriginFrameProtected =
        /frame-ancestors\s+'self'/i.test(csp) || /DENY|SAMEORIGIN/i.test(xfo);
      expect(
        sameOriginFrameProtected,
        `expected ${path} to set frame-ancestors 'self' or X-Frame-Options DENY/SAMEORIGIN`,
      ).toBe(true);
    }

    // Referrer-Policy: never leak full URL to third-party hosts.
    expect(headers['referrer-policy'] ?? '').toMatch(/no-referrer|strict-origin|same-origin/);
  });
}

test('portal sets Content-Security-Policy and Referrer-Policy', async ({ request }) => {
  // Even an invalid token path serves CSP + Referrer-Policy via middleware.
  const response = await request.get('/portal?token=invalid');
  expect(response.ok()).toBeTruthy();
  const headers = response.headers();
  expect(headers['content-security-policy'] ?? '').toMatch(/frame-ancestors/);
  expect(headers['referrer-policy'] ?? '').toBe('no-referrer');
});

test('no surface advertises a wildcard frame-ancestors', async ({ request }) => {
  // A wildcard frame-ancestors would let any origin iframe the page —
  // enabling clickjacking.
  for (const path of ['/login', '/portal?token=invalid']) {
    const response = await request.get(path);
    const csp = (response.headers()['content-security-policy'] ?? '').toLowerCase();
    expect(csp).not.toMatch(/frame-ancestors\s+\*/);
  }
});
