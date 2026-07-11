import { test, expect } from '@playwright/test';

// Open-redirect surface — the /login page accepts a ?next= param and may use
// it as the post-auth redirect target. Any value reaching the page MUST be
// confined to an internal path, never an absolute remote URL or a
// non-http(s) scheme.
//
// The test asserts the contract at the OUTPUT side: whatever ends up in the
// page HTML as a redirect target must be relative-and-safe. If the server
// honored a remote `next`, this would leak into a form action or a hidden
// input.

const REMOTE_NEXTS = [
  '//evil.com/steal',
  'https://evil.com/phish',
  'http://attacker.example/cb',
  'javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  '\\\\evil.com\\share',
];

for (const next of REMOTE_NEXTS) {
  test(`/login refuses to embed a remote/scheme next=${next.slice(0, 30)}`, async ({ page }) => {
    await page.goto(`/login?next=${encodeURIComponent(next)}`);
    // Pull every redirect-target attribute out of the live DOM and check
    // each value. Asserting against the raw HTML is brittle — encoded forms,
    // attribute order, and quote style all vary by renderer. The DOM gives
    // us the resolved value the browser would actually act on.
    const targets = await page.evaluate(() => {
      const out: string[] = [];
      for (const el of Array.from(
        document.querySelectorAll('[href], [action], input[name="next"], input[name="redirect"]'),
      )) {
        const href = el.getAttribute('href');
        const action = el.getAttribute('action');
        const value = el.getAttribute('value');
        if (href) out.push(href);
        if (action) out.push(action);
        if (value) out.push(value);
      }
      return out;
    });

    for (const target of targets) {
      // Allow same-origin internal paths (start with `/` but not `//`).
      if (target.startsWith('/') && !target.startsWith('//')) continue;
      // Anything else must NOT be a remote/dangerous URL pointing at the attack.
      expect(target.toLowerCase()).not.toContain('evil.com');
      expect(target.toLowerCase()).not.toContain('attacker.example');
      expect(target.toLowerCase()).not.toMatch(/^javascript:/);
      expect(target.toLowerCase()).not.toMatch(/^vbscript:/);
      expect(target.toLowerCase()).not.toMatch(/^data:/);
    }
  });
}

test('/login keeps a safe internal next= path verbatim', async ({ page }) => {
  await page.goto('/login?next=/o/test-org/dashboard');
  expect(await page.content()).toContain('/o/test-org/dashboard');
});
