import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const publicAppShellFiles = [
  'src/app/layout.tsx',
  'src/app/login/page.tsx',
  'src/components/auth/MagicLinkForm.tsx',
  'src/app/not-found.tsx',
  'src/components/dashboard/OnboardingChecklist.tsx',
] as const;

describe('public app shell marketing boundary', () => {
  it('keeps self-host product files free of marketing module imports', () => {
    for (const relativePath of publicAppShellFiles) {
      const body = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

      expect(body, relativePath).not.toContain('@/components/marketing');
      expect(body, relativePath).not.toContain('@/lib/marketing');
    }
  });
});
