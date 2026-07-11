// Authenticated dashboard table UX contract (gated by E2E_DASHBOARD; requires
// pnpm db:seed + tests/e2e/setup/seed-dashboard-fixtures.ts against a running
// stack — see auth.setup.ts for how the session is minted).
//
// This is the real-pixel guardrail for the flush-edge padding bug: computed
// styles and bounding boxes on actual CSS, which jsdom component tests cannot
// see. Never assert relative-time text here ("2h ago") — it is server-rendered
// and non-deterministic.

import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
  DASHBOARD_ORG_SLUG,
  DASHBOARD_STORAGE_STATE,
  FIXTURE_CUSTOMER_IDS,
} from './setup/fixtures';

const ORG = `/o/${DASHBOARD_ORG_SLUG}/dashboard`;

test.skip(!process.env.E2E_DASHBOARD, 'dashboard e2e requires E2E_DASHBOARD + a seeded stack');
test.use({ storageState: DASHBOARD_STORAGE_STATE });

const PAGES = [
  { name: 'end-users', path: `${ORG}/end-users` },
  { name: 'models', path: `${ORG}/models` },
  { name: 'billing', path: `${ORG}/billing` },
] as const;

async function documentScrollDelta(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

for (const { name, path } of PAGES) {
  test.describe(`${name} table`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(path);
    });

    test(`renders inside the card with real horizontal cell padding`, async ({ page }) => {
      const table = page.getByRole('table');
      await expect(table).toBeVisible();
      await expect(table.locator('tbody tr').first()).toBeVisible();

      // The pixel guardrail: cells must carry computed horizontal padding.
      const firstCell = table.locator('tbody td').first();
      const padding = await firstCell.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          left: parseFloat(style.paddingLeft),
          right: parseFloat(style.paddingRight),
        };
      });
      expect(padding.left).toBeGreaterThanOrEqual(12);
      expect(padding.right).toBeGreaterThanOrEqual(12);

      // And the first/last columns must sit inset from the card frame — the
      // bug was text flush against (clipped by) the card border.
      const card = page.locator('.app-card', { has: page.getByRole('table') });
      const cardBox = (await card.boundingBox())!;
      const firstBox = (await firstCell.boundingBox())!;
      const lastCell = table.locator('tbody tr').first().locator('td').last();
      const lastBox = (await lastCell.boundingBox())!;

      // Cell boxes include padding, so content starts at box.x + padding.
      expect(firstBox.x + padding.left).toBeGreaterThanOrEqual(cardBox.x + 8);

      // Right-edge containment only applies when the table fits; on narrow
      // viewports a wide table legitimately scrolls inside the card instead
      // (bounding boxes measure layout, not clipping).
      const overflow = await card.evaluate((el) => el.scrollWidth - el.clientWidth);
      if (overflow <= 0) {
        expect(lastBox.x + lastBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
      } else {
        const scrolls = await card.evaluate((el) => {
          el.scrollLeft = 40;
          const moved = el.scrollLeft > 0;
          el.scrollLeft = 0;
          return moved;
        });
        expect(scrolls, 'overflowing table card must scroll horizontally').toBe(true);
      }
    });

    test(`page does not scroll horizontally`, async ({ page }) => {
      expect(await documentScrollDelta(page)).toBeLessThanOrEqual(1);
    });

    test(`axe: no serious/critical violations and clean table semantics`, async ({ page }) => {
      await page.waitForLoadState('networkidle');
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();

      const blocking = results.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      );
      expect(
        blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`),
      ).toEqual([]);

      // Table-shape rules regardless of impact — catches empty header cells
      // (the models action column regression) and orphaned headers.
      const tableRules = results.violations.filter((v) =>
        ['empty-table-header', 'th-has-data-cells', 'td-headers-attr'].includes(v.id),
      );
      expect(tableRules.map((v) => v.id)).toEqual([]);
    });
  });
}

test('end-users: long and Arabic ids render as working, keyboard-reachable links', async ({
  page,
}) => {
  await page.goto(`${ORG}/end-users`);

  const longLink = page.getByRole('link', { name: FIXTURE_CUSTOMER_IDS.long });
  await expect(longLink).toBeVisible();
  await expect(page.getByRole('link', { name: FIXTURE_CUSTOMER_IDS.arabic })).toBeVisible();

  await longLink.focus();
  await expect(longLink).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/end-users/${FIXTURE_CUSTOMER_IDS.long}$`));
});

test('models: wide table scrolls inside its card wrapper, not the page', async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, 'overflow behavior is exercised on the mobile-safari project');
  await page.goto(`${ORG}/models`);
  await expect(page.getByRole('table')).toBeVisible();

  expect(await documentScrollDelta(page)).toBeLessThanOrEqual(1);

  const wrapper = page.locator('.app-card.overflow-x-auto', { has: page.getByRole('table') });
  const scrollBehavior = await wrapper.evaluate((el) => {
    if (el.scrollWidth <= el.clientWidth) return 'not-overflowing';
    el.scrollLeft = 40;
    return el.scrollLeft > 0 ? 'scrolls' : 'stuck';
  });
  expect(scrollBehavior).not.toBe('stuck');
});
