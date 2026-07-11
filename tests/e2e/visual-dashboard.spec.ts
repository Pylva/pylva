// Visual baselines for the authenticated dashboard tables (gated by
// E2E_DASHBOARD; see auth.setup.ts + seed-dashboard-fixtures.ts).
//
// Element-scoped screenshots of the table card only — full-page dashboard
// screenshots drift with unrelated layout work. desktop-chromium only, to
// keep the baseline surface small. The end-users "Last seen" column renders
// server-side relative time ("2h ago") and is masked.
//
// Baselines are per-platform (…-darwin.png / …-linux.png). This spec is NOT
// in the CI smoke run yet: generate Linux baselines from a CI artifact run
// (pnpm test:e2e --update-snapshots tests/e2e/visual-dashboard.spec.ts),
// commit them, then add the file to the ci-e2e-smoke Playwright invocation.
// Screenshot determinism relies on seed-dashboard-fixtures.ts wiping the
// builder's random-seed events and pinning distinct totals/timestamps.

import { test, expect } from '@playwright/test';
import { DASHBOARD_ORG_SLUG, DASHBOARD_STORAGE_STATE } from './setup/fixtures';

const ORG = `/o/${DASHBOARD_ORG_SLUG}/dashboard`;

test.skip(!process.env.E2E_DASHBOARD, 'dashboard e2e requires E2E_DASHBOARD + a seeded stack');
test.skip(
  ({ browserName, isMobile }) => browserName !== 'chromium' || Boolean(isMobile),
  'visual baselines are desktop-chromium only',
);
test.use({ storageState: DASHBOARD_STORAGE_STATE, viewport: { width: 1280, height: 720 } });

test.describe('visual baselines - dashboard tables', () => {
  test('end-users table card', async ({ page }) => {
    await page.goto(`${ORG}/end-users`);
    const card = page.locator('.app-card', { has: page.getByRole('table') });
    await expect(card).toBeVisible();
    await expect(card).toHaveScreenshot('end-users-table.png', {
      maxDiffPixelRatio: 0.02,
      mask: [card.locator('tbody td:nth-child(4)')],
    });
  });

  test('models table card', async ({ page }) => {
    await page.goto(`${ORG}/models`);
    const card = page.locator('.app-card', { has: page.getByRole('table') });
    await expect(card).toBeVisible();
    await expect(card).toHaveScreenshot('models-table.png', {
      maxDiffPixelRatio: 0.02,
    });
  });

  test('billing table card', async ({ page }) => {
    await page.goto(`${ORG}/billing`);
    const card = page.locator('.app-card', { has: page.getByRole('table') });
    await expect(card).toBeVisible();
    await expect(card).toHaveScreenshot('billing-table.png', {
      maxDiffPixelRatio: 0.02,
    });
  });
});
