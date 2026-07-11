// Conventions guard: dashboard tables must be composed from the shared
// primitives in src/components/ui/table.tsx — hand-rolled <table> markup is
// how the flush-edge padding bug shipped (cells with py-* only, no px-*).
// The ESLint no-restricted-syntax ban enforces this at lint time; this test
// enforces it in the default `pnpm test` suite and pins the primitive's own
// padding contract at the source level.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

// The only file allowed to contain a raw <table> element.
const ALLOWLIST = new Set(['src/components/ui/table.tsx']);

// Pages that render data tables and must import the shared primitives.
const DASHBOARD_TABLE_PAGES = [
  'src/app/o/[slug]/dashboard/end-users/page.tsx',
  'src/app/o/[slug]/dashboard/models/page.tsx',
  'src/app/o/[slug]/dashboard/billing/page.tsx',
  'src/app/o/[slug]/dashboard/billing/invoices/[id]/page.tsx',
  'src/app/o/[slug]/dashboard/end-users/[id]/pricing/page.tsx',
];

async function tsxFiles(relDir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(path.join(ROOT, relDir), { withFileTypes: true });
  for (const entry of entries) {
    const rel = path.join(relDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await tsxFiles(rel)));
    } else if (entry.name.endsWith('.tsx')) {
      out.push(rel);
    }
  }
  return out;
}

describe('table primitive usage', () => {
  it('no file outside the primitive hand-rolls a <table>', async () => {
    const files = [...(await tsxFiles('src/app')), ...(await tsxFiles('src/components'))];
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const rel of files) {
      if (ALLOWLIST.has(rel)) continue;
      const src = await readFile(path.join(ROOT, rel), 'utf8');
      if (/<table[\s>]/.test(src)) offenders.push(rel);
    }

    expect(
      offenders,
      `raw <table> markup found — compose from @/components/ui/table instead: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('dashboard table pages import the shared primitives', async () => {
    for (const rel of DASHBOARD_TABLE_PAGES) {
      const src = await readFile(path.join(ROOT, rel), 'utf8');
      expect(src, `${rel} must import @/components/ui/table`).toContain('@/components/ui/table');
    }
  });

  it('the primitive bakes horizontal padding into th and td', async () => {
    const src = await readFile(path.join(ROOT, 'src/components/ui/table.tsx'), 'utf8');
    const thClasses = src.match(/<th className=\{cn\('([^']+)'/);
    const tdClasses = src.match(/<td className=\{cn\('([^']+)'/);
    expect(thClasses?.[1], 'th default classes must include px-*').toMatch(/(^|\s)px-\d/);
    expect(tdClasses?.[1], 'td default classes must include px-*').toMatch(/(^|\s)px-\d/);
  });
});
