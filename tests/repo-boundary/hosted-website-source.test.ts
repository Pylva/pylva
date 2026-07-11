import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Boundary exception: /openapi.json (src/app/openapi.json + src/lib/public-api)
// is part of the self-host product — it describes the public API this repo
// ships, so self-hosters get a machine-readable spec too. The hosted website,
// SEO, marketing, and MCP surfaces stay internal.
const internalHostedWebsitePaths = [
  'hosted.next.config.mjs',
  'src/app/(marketing)',
  'src/components/marketing',
  'src/lib/marketing',
  'src/app/llms.txt',
  'src/app/llms-full.txt',
  'src/app/md',
  'src/app/sitemap.ts',
  'src/app/robots.txt',
  'src/app/opengraph-image.tsx',
  'src/lib/seo',
  'src/app/auth.md',
  'src/app/mcp',
  'src/app/well-known',
  'src/lib/public-mcp',
  'tests/marketing',
  'tests/seo',
  'tests/e2e/marketing.spec.ts',
  'tests/security/code-highlighter.test.ts',
  'tests/frontend/source-library-page.test.tsx',
  'output/playwright',
] as const;

const importOnlyInternalModules = [
  '@/components/marketing',
  '@/lib/marketing',
  '@/lib/seo',
  '@/lib/public-mcp',
] as const;

function exists(relativePath: string): boolean {
  return fs.existsSync(path.join(repoRoot, relativePath));
}

function walkSourceFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) {
    return out;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'dist') {
      continue;
    }

    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(absolutePath, out);
    } else if (/\.(ts|tsx|js|jsx|mjs|mts)$/.test(entry.name)) {
      out.push(absolutePath);
    }
  }

  return out;
}

describe('hosted website and reference source boundary', () => {
  it('keeps hosted website, SEO, public reference routes, and generated screenshots internal', () => {
    for (const relativePath of internalHostedWebsitePaths) {
      expect(exists(relativePath), `${relativePath} should live in pylva-internal`).toBe(false);
    }
  });

  it('keeps self-host product source free of internal website/reference imports', () => {
    const sourceFiles = walkSourceFiles(path.join(repoRoot, 'src'));
    const violations: Array<{ file: string; module: string }> = [];

    for (const absolutePath of sourceFiles) {
      const body = fs.readFileSync(absolutePath, 'utf8');
      for (const moduleName of importOnlyInternalModules) {
        if (body.includes(moduleName)) {
          violations.push({
            file: path.relative(repoRoot, absolutePath),
            module: moduleName,
          });
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
