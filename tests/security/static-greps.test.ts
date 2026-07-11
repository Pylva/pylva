// Source-tree static audit. Cheap CI guard against the recurring
// frontend-XSS / arbitrary-code-execution patterns. Every entry here is a
// concrete rule, not aspirational: an allowlist of files that are ALLOWED
// to use the pattern, and the test fails for any new occurrence.

import { beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'dist') continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(abs, out);
    } else if (/\.(ts|tsx|js|jsx|mts|mjs)$/.test(entry.name)) {
      out.push(abs);
    }
  }
  return out;
}

// Cache: read every src file ONCE up front and reuse across all greps.
// Without this, six independent it()s each walked + read the full tree.
const sources = new Map<string, string[]>();

beforeAll(async () => {
  const files = await walk(SRC_ROOT);
  await Promise.all(
    files.map(async (file) => {
      const text = await fs.readFile(file, 'utf8');
      sources.set(file, text.split('\n'));
    }),
  );
});

function scan(pattern: RegExp): Array<{ file: string; line: number; text: string }> {
  const hits: Array<{ file: string; line: number; text: string }> = [];
  for (const [file, lines] of sources) {
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i]!)) {
        hits.push({ file: path.relative(REPO_ROOT, file), line: i + 1, text: lines[i]! });
      }
    }
  }
  return hits;
}

describe('static security greps under src/', () => {
  it('dangerouslySetInnerHTML appears only in the explicit static-script allowlist', () => {
    const hits = scan(/dangerouslySetInnerHTML/);
    // Allowlist: file paths permitted to use dangerouslySetInnerHTML.
    const allowed = new Set([
      // Dashboard theme bootstrap. Static script literal; no user-controlled interpolation.
      'src/app/o/[slug]/layout.tsx',
      // Lightweight analytics beacon. Endpoint is restricted to known PostHog hosts and dynamic
      // values are JSON stringified with HTML-script delimiter characters escaped.
      'src/lib/analytics/page-view-beacon.tsx',
    ]);
    const violations = hits.filter((h) => !allowed.has(h.file));
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it('no eval(', () => {
    expect(scan(/\beval\s*\(/)).toEqual([]);
  });

  it('no new Function(', () => {
    expect(scan(/\bnew\s+Function\s*\(/)).toEqual([]);
  });

  it('no .innerHTML = assignment', () => {
    expect(scan(/\.innerHTML\s*=/)).toEqual([]);
  });

  it('no document.write', () => {
    expect(scan(/document\.write\s*\(/)).toEqual([]);
  });

  it('no target="_blank" without rel noopener/noreferrer (string-literal match only)', () => {
    const hits: Array<{ file: string; line: number; text: string }> = [];
    for (const [file, lines] of sources) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!/target=\s*["{]\s*["']?_blank/.test(line)) continue;
        // Check current line and ±2 lines for a matching rel.
        const window = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 3)).join('\n');
        if (!/rel=\s*["{][^"}]*(noopener|noreferrer)/.test(window)) {
          hits.push({ file: path.relative(REPO_ROOT, file), line: i + 1, text: line.trim() });
        }
      }
    }
    expect(hits, JSON.stringify(hits, null, 2)).toEqual([]);
  });
});
