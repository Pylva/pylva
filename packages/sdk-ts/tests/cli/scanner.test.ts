// B3-T4a — scanner coverage. Creates a /tmp fixture tree and asserts the
// walker finds the right manifests (skipping node_modules / .venv), unions
// dependencies across monorepo subpackages, and honors --include/--exclude.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { walkManifests } from '../../src/cli/scanner.js';

async function writeFile(p: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, body, 'utf8');
}

describe('scanner.walkManifests', () => {
  let root: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pylva-scanner-'));

    // Root package.json — openai + anthropic + one unknown package.
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        dependencies: { openai: '^4.0.0', 'random-unknown': '^1' },
        devDependencies: { '@anthropic-ai/sdk': '^0.20' },
      }),
    );

    // Python requirements.txt — anthropic + mistralai (version-pinned).
    await writeFile(
      path.join(root, 'requirements.txt'),
      '# project deps\nanthropic>=0.8\nmistralai==0.1.3  # via Mistral\n\n',
    );

    // pyproject.toml — cohere + google-generativeai.
    await writeFile(
      path.join(root, 'pyproject.toml'),
      `[project]\nname = "app"\ndependencies = [\n  "cohere",\n  "google-generativeai>=0.3",\n]\n`,
    );

    // Monorepo subpackage — must be picked up.
    await writeFile(
      path.join(root, 'packages', 'service-a', 'package.json'),
      JSON.stringify({ dependencies: { elevenlabs: '^1.0' } }),
    );

    // node_modules/openai — must be skipped.
    await writeFile(
      path.join(root, 'node_modules', 'openai', 'package.json'),
      JSON.stringify({ dependencies: { somethingunexpected: '*' } }),
    );

    // .venv/pkg — must be skipped.
    await writeFile(
      path.join(root, '.venv', 'lib', 'site-packages', 'test.txt'),
      'fake venv content',
    );
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('detects root package.json dependencies from all three dep groups', async () => {
    const hits = await walkManifests(root);
    const rootHit = hits.find((h) => h.manifest === path.join(root, 'package.json'));
    expect(rootHit).toBeDefined();
    expect(rootHit!.dependencies).toEqual(
      expect.arrayContaining(['openai', 'random-unknown', '@anthropic-ai/sdk']),
    );
  });

  it('detects requirements.txt packages, stripping version specifiers', async () => {
    const hits = await walkManifests(root);
    const req = hits.find((h) => h.manifest === path.join(root, 'requirements.txt'));
    expect(req).toBeDefined();
    expect(req!.dependencies).toEqual(expect.arrayContaining(['anthropic', 'mistralai']));
    expect(req!.dependencies.every((d) => !d.includes('>'))).toBe(true);
  });

  it('detects pyproject.toml dependencies', async () => {
    const hits = await walkManifests(root);
    const py = hits.find((h) => h.manifest === path.join(root, 'pyproject.toml'));
    expect(py).toBeDefined();
    expect(py!.dependencies).toEqual(expect.arrayContaining(['cohere', 'google-generativeai']));
  });

  it('walks monorepo subpackages', async () => {
    const hits = await walkManifests(root);
    const sub = hits.find(
      (h) => h.manifest === path.join(root, 'packages', 'service-a', 'package.json'),
    );
    expect(sub).toBeDefined();
    expect(sub!.dependencies).toContain('elevenlabs');
  });

  it('skips node_modules and .venv', async () => {
    const hits = await walkManifests(root);
    const skipped = hits.find(
      (h) => h.manifest.includes('node_modules') || h.manifest.includes('.venv'),
    );
    expect(skipped).toBeUndefined();
  });

  it('filters by --include glob', async () => {
    const hits = await walkManifests(root, { include: ['packages/*/package.json'] });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.manifest).toBe(path.join(root, 'packages', 'service-a', 'package.json'));
  });

  it('filters by --exclude glob', async () => {
    const hits = await walkManifests(root, { exclude: ['requirements.txt', 'pyproject.toml'] });
    const manifests = hits.map((h) => path.relative(root, h.manifest).split(path.sep).join('/'));
    expect(manifests).not.toContain('requirements.txt');
    expect(manifests).not.toContain('pyproject.toml');
    // package.json at root + packages/service-a/package.json both remain.
    expect(manifests).toEqual(
      expect.arrayContaining(['package.json', 'packages/service-a/package.json']),
    );
  });
});
