// SEO hygiene — every dashboard page must declare its own tab title.
//
// The root layout owns the title template ('%s — Pylva'), so pages export the
// bare section name only. A page without a metadata export silently falls back
// to the generic "Pylva" title for the whole authenticated app; this source
// scan makes that regression (and a hardcoded "— Pylva" suffix, which the
// template would double up) fail CI. Static scan on purpose: importing the
// page modules would drag in db/clickhouse clients.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dashboardRoot = path.join(repoRoot, 'src/app/o/[slug]/dashboard');

function collectPageFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) collectPageFiles(absolute, out);
    else if (entry.name === 'page.tsx') out.push(absolute);
  }
  return out;
}

describe('dashboard page titles', () => {
  const pages = collectPageFiles(dashboardRoot);

  it('finds the dashboard page inventory', () => {
    // 24 pages at the time of writing; new pages are allowed but must pass
    // the per-file assertions below.
    expect(pages.length).toBeGreaterThanOrEqual(24);
  });

  it.each(pages.map((p) => [path.relative(repoRoot, p), p]))(
    '%s exports a bare metadata title',
    (_label, absolute) => {
      const body = fs.readFileSync(absolute as string, 'utf8');
      const match = /export const metadata(?::\s*Metadata)?\s*=\s*\{\s*title:\s*'([^']+)'/.exec(
        body,
      );
      expect(match, 'page must export `metadata` with a static title').not.toBeNull();
      const title = match![1]!;
      expect(title.trim().length).toBeGreaterThan(0);
      // The root layout template appends the brand; a suffix here would render
      // "Overview — Pylva — Pylva".
      expect(title).not.toMatch(/Pylva/);
      expect(title).not.toContain('—');
    },
  );
});
