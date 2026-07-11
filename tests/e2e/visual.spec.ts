import { test, expect } from '@playwright/test';

// Visual baselines for the public self-host product surfaces.
//
// First-time runs generate snapshots under tests/e2e/visual.spec.ts-snapshots/.
// Subsequent runs compare against them. Update with:
//   pnpm test:e2e --update-snapshots tests/e2e/visual.spec.ts

test.describe('visual baselines - public product surfaces', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('login', async ({ page }) => {
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveScreenshot('login.png', {
      maxDiffPixelRatio: 0.02,
    });
  });

  test('portal missing-link', async ({ page }) => {
    await page.goto('/portal');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveScreenshot('portal-missing-link.png', {
      maxDiffPixelRatio: 0.02,
    });
  });
});
