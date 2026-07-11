import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const textExtensions = new Set([
  '.css',
  '.env',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.py',
  '.sh',
  '.sql',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);

const legacyBoundaryTestFiles = new Set([
  'tests/infrastructure/github-repo-slug.test.ts',
  'tests/repo-boundary/community-files.test.ts',
  'tests/repo-boundary/final-public-boundary.test.ts',
]);

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

function trackedTextFiles(): string[] {
  return trackedFiles().filter((file) => textExtensions.has(path.extname(file)));
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('final public boundary gate', () => {
  it('keeps internal transcript-audit fixtures out of the public repo', () => {
    expect(trackedFiles().some((file) => file.startsWith('tests/fixtures/transcripts/'))).toBe(
      false,
    );
  });

  it('keeps legacy repo/brand terms limited to negative boundary assertions', () => {
    const violations = trackedTextFiles()
      .filter((file) => !legacyBoundaryTestFiles.has(file))
      .filter((file) => /spacegravity|agentmeter/i.test(read(file)));

    expect(violations).toEqual([]);
  });

  it('does not contain obvious live secret material', () => {
    const secretPatterns = [
      /sk_live_[A-Za-z0-9]+/,
      /rk_live_[A-Za-z0-9]+/,
      /pk_live_[A-Za-z0-9]+/,
      /\bAKIA[0-9A-Z]{16}\b/,
      /\bASIA[0-9A-Z]{16}\b/,
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
      /\bghp_[A-Za-z0-9_]{30,}\b/,
      /\bgithub_pat_[A-Za-z0-9_]{80,}\b/,
      /\bxox[baprs]-[A-Za-z0-9-]+\b/,
      /\bAIza[0-9A-Za-z_-]{35}\b/,
      /aws_secret_access_key\s*=\s*["']?[A-Za-z0-9/+]{20,}/i,
    ] as const;

    const violations: Array<{ file: string; pattern: string }> = [];

    for (const relativePath of trackedTextFiles()) {
      const body = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

      for (const pattern of secretPatterns) {
        if (pattern.test(body)) {
          violations.push({ file: relativePath, pattern: String(pattern) });
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
