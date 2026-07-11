import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const publicCommunityFiles = [
  'README.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  'AGENTS.md',
  '.github/CODEOWNERS',
  '.github/pull_request_template.md',
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
] as const;

const legacyOwnershipTerms = ['@SpaceGravity', 'SpaceGravity/pylva', 'SpaceGravity/agentmeter'];

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('public community file boundary', () => {
  it('keeps public collaboration and support files in the open-source repo', () => {
    for (const relativePath of publicCommunityFiles) {
      expect(fs.existsSync(path.join(repoRoot, relativePath)), `${relativePath} should stay public`).toBe(
        true,
      );
    }
  });

  it('keeps CODEOWNERS under Pylva ownership without legacy SpaceGravity owners', () => {
    const codeowners = read('.github/CODEOWNERS');

    expect(codeowners).toContain('@Pylva/pylva-maintainers');
    for (const term of legacyOwnershipTerms) {
      expect(codeowners).not.toContain(term);
    }
  });

  it('keeps contributor guidance self-contained and linked to hosted docs', () => {
    const agents = read('AGENTS.md');
    const readme = read('README.md');
    const contributing = read('CONTRIBUTING.md');

    expect(agents).not.toContain('DESIGN.md');
    expect(agents).toContain('CONTRIBUTING.md');
    expect(readme).toContain('https://docs.pylva.com');
    expect(contributing).toContain('pnpm typecheck');
    expect(contributing).toContain('pnpm test');
  });
});
