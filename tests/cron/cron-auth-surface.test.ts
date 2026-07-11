// Static guard: every HTTP cron route must use the shared constant-time
// CRON_SECRET verifier. This catches copy-pasted bearer comparisons before
// they reintroduce a timing side channel.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const CRON_DIR = join(process.cwd(), 'src/app/api/cron');

function cronRouteFiles(): string[] {
  return readdirSync(CRON_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(CRON_DIR, entry.name, 'route.ts'));
}

describe('cron auth surface', () => {
  const routeFiles = cronRouteFiles();

  it('finds cron route files', () => {
    expect(routeFiles.length).toBeGreaterThan(0);
  });

  it('uses the shared verifyCronSecret helper on every route', () => {
    const findings = routeFiles.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      const rel = relative(process.cwd(), file);
      const issues: string[] = [];

      if (source.includes('function checkBearer')) {
        issues.push(`${rel}: declares local checkBearer`);
      }
      if (/Bearer\s+\$\{env\.CRON_SECRET\}/.test(source)) {
        issues.push(`${rel}: compares raw CRON_SECRET bearer`);
      }
      if (!source.includes('verifyCronSecret')) {
        issues.push(`${rel}: missing verifyCronSecret`);
      }

      return issues;
    });

    expect(findings).toEqual([]);
  });
});
