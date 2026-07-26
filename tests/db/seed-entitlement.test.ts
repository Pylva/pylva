import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('self-hosted seed entitlement', () => {
  it('creates explicit active self-hosted workspaces without a commercial plan', async () => {
    const source = await readFile(path.resolve(__dirname, '../../db/seed.ts'), 'utf8');

    expect(source).toContain('BuilderAccessState.ACTIVE');
    expect(source).toContain('EntitlementSource.SELF_HOSTED');
    expect(source).toMatch(
      /INSERT INTO builders \(email, name, tier, access_state, entitlement_source, slug\)/,
    );
    expect(source).not.toMatch(/VALUES\s*\([^;]*['"](?:free|pro|scale|enterprise)['"]/i);
    expect(source).not.toContain('alice-free');
  });

  it('never changes an existing workspace entitlement or slug on rerun', async () => {
    const source = await readFile(path.resolve(__dirname, '../../db/seed.ts'), 'utf8');
    const builderSection = source.slice(
      source.indexOf('// --- Builders ---'),
      source.indexOf('// --- Users + Owner Memberships ---'),
    );
    const conflictClauses = builderSection.match(
      /ON CONFLICT \(email\) DO UPDATE SET[\s\S]*?RETURNING id/g,
    );

    expect(conflictClauses).toHaveLength(3);
    for (const clause of conflictClauses ?? []) {
      expect(clause).toMatch(/name = COALESCE\(builders\.name, EXCLUDED\.name\)/);
      expect(clause).not.toMatch(/\b(?:tier|access_state|entitlement_source|slug)\s*=/);
    }
  });
});
