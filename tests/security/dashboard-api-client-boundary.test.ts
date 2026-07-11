import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = path.resolve(process.cwd(), 'src');
const EXCEPTIONS = new Set([
  'components/auth/MagicLinkForm.tsx',
  'components/dashboard/TopBar.tsx',
  'lib/dashboard/api-client.ts',
  'app/login/page.tsx',
]);

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(fullPath);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [fullPath] : [];
  });
}

describe('dashboard browser API boundary', () => {
  it('keeps dashboard requests, SSE, forms, and downloads behind the context-aware client', () => {
    const violations: string[] = [];
    for (const file of sourceFiles(SRC_ROOT)) {
      const relative = path.relative(SRC_ROOT, file);
      if (relative.startsWith(`app${path.sep}api${path.sep}`) || EXCEPTIONS.has(relative)) continue;
      const source = fs.readFileSync(file, 'utf8');

      if (/\bfetch\s*\([^)]*\/api\/v1/s.test(source)) violations.push(`${relative}: raw fetch`);
      if (/new\s+EventSource\s*\(/.test(source)) violations.push(`${relative}: raw EventSource`);
      if (/<form\b[^>]*\baction\s*=\s*[^>]*\/api\/v1/s.test(source)) {
        violations.push(`${relative}: native API form`);
      }
      if (/<a\b[^>]*\bhref\s*=\s*[^>]*\/api\/v1/s.test(source)) {
        violations.push(`${relative}: native API download/navigation`);
      }
    }

    expect(violations).toEqual([]);
  });
});
