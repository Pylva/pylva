import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const PUBLIC_SURFACES: Array<{ name: string; path: string }> = [
  { name: 'login', path: '/login' },
  { name: 'portal-missing-link', path: '/portal' },
];

for (const { name, path } of PUBLIC_SURFACES) {
  test(`a11y — ${name} (${path}) has no serious or critical axe violations`, async ({ page }) => {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    // Only WCAG A/AA — best-practice rules are slower to compute and we
    // filter them out below anyway, since we only block on serious/critical.
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();

    const blocking = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );

    if (blocking.length > 0) {
      // Print a concise summary so the failure message is useful.
      const summary = blocking.map((v) => `  • ${v.id} (${v.impact}) — ${v.help}`).join('\n');
      throw new Error(
        `Axe found ${blocking.length} serious/critical violations on ${path}:\n${summary}`,
      );
    }
    expect(blocking).toEqual([]);
  });
}
