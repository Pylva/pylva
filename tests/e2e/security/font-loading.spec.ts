import { test, expect } from '@playwright/test';

// Product/login fonts must be self-hosted via Next.js `next/font`. A regression
// where a font URL leaks to a third-party CDN would (a) introduce a runtime
// dependency on Google/Adobe servers, (b) leak referrer information, and
// (c) require a wider connect-src in CSP later.

const FORBIDDEN_HOSTS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'use.typekit.net',
  'cdn.fonts.com',
  'fast.fonts.com',
];

for (const path of ['/login']) {
  test(`${path} does not fetch fonts from a third-party CDN`, async ({ page }) => {
    const requested: string[] = [];
    page.on('request', (req) => {
      const url = req.url();
      if (FORBIDDEN_HOSTS.some((h) => url.includes(h))) {
        requested.push(url);
      }
    });
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    expect(
      requested,
      `Unexpected third-party font requests on ${path}: ${requested.join(', ')}`,
    ).toEqual([]);
  });
}

test('public self-host pages do not load any non-localhost script from arbitrary CDN', async ({
  page,
}) => {
  const forbidden: string[] = [];
  page.on('request', (req) => {
    if (req.resourceType() !== 'script') return;
    const url = req.url();
    if (/^https?:\/\/(?!localhost|127\.0\.0\.1)/.test(url)) {
      const allowList = ['vercel.live', 'va.vercel-scripts.com', 'browser.sentry-cdn.com'];
      if (!allowList.some((host) => url.includes(host))) {
        forbidden.push(url);
      }
    }
  });

  await page.goto('/login');
  await page.waitForLoadState('networkidle');

  expect(forbidden, `Unexpected third-party script requests: ${forbidden.join(', ')}`).toEqual([]);
});
