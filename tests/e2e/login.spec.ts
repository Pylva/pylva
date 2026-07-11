import { test, expect } from '@playwright/test';

// Sign-in page surface contract for the public self-host repo.

test.describe('/login — public sign-in page', () => {
  test('renders with exactly one h1', async ({ page }) => {
    await page.goto('/login');
    const headings = await page.locator('h1').count();
    expect(headings).toBe(1);
  });

  test('no horizontal scroll on the login viewport', async ({ page }) => {
    await page.goto('/login');
    const viewportWidth = await page.evaluate(() => document.documentElement.clientWidth);
    const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(pageWidth).toBeLessThanOrEqual(viewportWidth + 1);
  });

  test('login is wrapped in [data-marketing], inheriting the public surface tokens', async ({
    page,
  }) => {
    await page.goto('/login');
    await expect(page.locator('[data-marketing]')).toBeVisible();
    await expect(page.locator('[data-app]')).toHaveCount(0);
    await expect(page.locator('[data-portal]')).toHaveCount(0);
  });
});
