import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

describe('production onboarding — no demo data', () => {
  it('findOrCreateBuilderForUser does not import or invoke the demo seed', async () => {
    const src = await readFile(path.join(ROOT, 'src/lib/auth/org.ts'), 'utf8');
    expect(src).not.toContain('seed-demo-data');
    expect(src).not.toContain('seedDemoData');
    // Explicit free-tier insert (don't rely on DB default).
    expect(src).toMatch(/tier:\s*['"]free['"]/);
  });

  it('dashboard pages no longer pass includeDemo: true', async () => {
    const overview = await readFile(path.join(ROOT, 'src/app/o/[slug]/dashboard/page.tsx'), 'utf8');
    expect(overview).not.toMatch(/includeDemo:\s*true/);
    expect(overview).not.toContain('DemoBanner');
    expect(overview).toContain('OnboardingChecklist');

    const endUsers = await readFile(
      path.join(ROOT, 'src/app/o/[slug]/dashboard/end-users/page.tsx'),
      'utf8',
    );
    expect(endUsers).not.toContain('DemoBanner');

    const models = await readFile(
      path.join(ROOT, 'src/app/o/[slug]/dashboard/models/page.tsx'),
      'utf8',
    );
    expect(models).not.toContain('DemoBanner');
  });

  it('customer / costs / traces API routes no longer auto-enable includeDemo', async () => {
    for (const rel of [
      'src/app/api/v1/customers/route.ts',
      'src/app/api/v1/costs/route.ts',
      'src/app/api/v1/traces/route.ts',
    ]) {
      const src = await readFile(path.join(ROOT, rel), 'utf8');
      expect(src, rel).not.toMatch(/includeDemo:\s*true/);
      expect(src, rel).not.toMatch(/!\(await hasAnyRealEvents/);
    }
  });

  it('DemoBanner component is removed', async () => {
    await expect(
      readFile(path.join(ROOT, 'src/components/dashboard/DemoBanner.tsx'), 'utf8'),
    ).rejects.toThrow();
  });
});
