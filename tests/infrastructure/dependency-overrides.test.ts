import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
  devDependencies: Record<string, string>;
};
const workspace = readFileSync('pnpm-workspace.yaml', 'utf8');
const lockfile = readFileSync('pnpm-lock.yaml', 'utf8');

function postcssOverride(source: string): string {
  const match = source.match(/^overrides:\n(?:(?:  .*)\n)*?  postcss: ([^\n]+)$/m);
  if (!match?.[1]) throw new Error('PostCSS override is missing');
  return match[1];
}

describe('dependency overrides', () => {
  it('keeps the PostCSS manifest, workspace override, and lockfile override aligned', () => {
    const workspaceVersion = postcssOverride(workspace);

    expect(packageJson.devDependencies.postcss).toBe(`^${workspaceVersion}`);
    expect(postcssOverride(lockfile)).toBe(workspaceVersion);
  });
});
