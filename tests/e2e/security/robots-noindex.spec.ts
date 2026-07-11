// SEO/privacy smoke — the app shell must keep itself out of search indexes
// and present per-page titles. Runs against a tokenless `next start` (no db
// services): /portal is exercised via its tokenless error branch, which
// returns before any data access.

import { expect, test } from '@playwright/test';

test.describe('robots + titles on the app shell', () => {
  test('/portal is noindex at header, meta, and title level', async ({ page }) => {
    const response = await page.goto('/portal');
    expect(response, 'portal must respond').toBeTruthy();
    expect(response!.headers()['x-robots-tag']).toContain('noindex');

    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    await expect(page).toHaveTitle('Usage portal — Pylva');
    await expect(page.locator('h1')).toHaveCount(1);
  });

  test('/login is noindex with its own title and a single h1', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    await expect(page).toHaveTitle('Sign in — Pylva');
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('h1')).toContainText('Sign in to Pylva');
  });

  test('anonymous dashboard request redirects to login', async ({ request }) => {
    const response = await request.get('/o/acme/dashboard', { maxRedirects: 0 });
    expect(response.status()).toBe(307);
    expect(response.headers()['location']).toContain('/login?next=');
  });

  test('404 page keeps the branded title without doubling the suffix', async ({ page }) => {
    await page.goto('/definitely-not-a-page');
    await expect(page).toHaveTitle('Page not found — Pylva');
    await expect(page.locator('h1')).toHaveCount(1);
  });
});
