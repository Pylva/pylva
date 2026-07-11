import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const internalDocsSourcePaths = [
  'DESIGN.md',
  '.mintignore',
  'docs.json',
  'index.mdx',
  'quickstart.mdx',
  'api',
  'concepts',
  'sdks',
  'scripts/audit-mintlify-public-docs.ts',
  'tests/docs',
] as const;

const allowedPublicDocsPaths = ['docs/assets'] as const;

function exists(relativePath: string): boolean {
  return fs.existsSync(path.join(repoRoot, relativePath));
}

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')) as Record<
    string,
    unknown
  >;
}

describe('docs and design source boundary', () => {
  it('keeps full docs and design source out of the public repo', () => {
    for (const relativePath of internalDocsSourcePaths) {
      expect(exists(relativePath), `${relativePath} should live in pylva-internal`).toBe(false);
    }

    if (exists('docs')) {
      const docsEntries = fs
        .readdirSync(path.join(repoRoot, 'docs'))
        .map((entry) => `docs/${entry}`)
        .sort();

      expect(docsEntries).toEqual([...allowedPublicDocsPaths]);
    }
  });

  it('does not expose Mintlify maintenance scripts in the public package scripts', () => {
    const packageJson = readJson('package.json');
    const scripts = packageJson.scripts as Record<string, string>;

    expect(scripts['docs:audit']).toBeUndefined();
    expect(scripts['docs:validate']).toBeUndefined();
    expect(scripts['docs:dev']).toBeUndefined();
  });

  it('points contributors to repo-local guidance and hosted docs instead of DESIGN.md', () => {
    const agents = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');
    const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');

    expect(agents).not.toContain('DESIGN.md');
    expect(agents).toContain('CONTRIBUTING.md');
    expect(readme).toContain('https://docs.pylva.com');
  });
});
