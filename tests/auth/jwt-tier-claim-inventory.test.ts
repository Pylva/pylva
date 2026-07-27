import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  collectJwtTierClaimInventory,
  validateJwtTierClaimInventory,
} from '../../scripts/jwt-tier-claim-inventory.mjs';

const manifest = JSON.parse(
  fs.readFileSync('scripts/jwt-tier-claim-inventory.json', 'utf8'),
) as Array<{ kind: string; path: string; snippet: string; occurrence: number }>;

describe('deprecated signed JWT tier-claim inventory', () => {
  it('matches every reviewed producer, read, schema, and reserved-claim site', () => {
    const observed = collectJwtTierClaimInventory(process.cwd());
    const result = validateJwtTierClaimInventory(observed, manifest);

    expect(result).toEqual({
      ok: true,
      errors: [],
      unexpected: [],
      missing: [],
    });
    expect(new Set(observed.map(({ kind }) => kind))).toEqual(
      new Set(['producer', 'read', 'reserved', 'schema']),
    );
  });

  it('detects a newly introduced signed-claim producer outside the reviewed inventory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jwt-tier-inventory-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src', 'new-session.ts'),
      [
        "import { signJwt } from './lib/auth/jwt.js';",
        "void signJwt({ builder_id: 'b', audience: 'dashboard', tier: 'pro' });",
      ].join('\n'),
    );

    const observed = collectJwtTierClaimInventory(root);
    const result = validateJwtTierClaimInventory(observed, []);

    expect(result.ok).toBe(false);
    expect(result.unexpected).toEqual([
      expect.objectContaining({
        kind: 'producer',
        path: 'src/new-session.ts',
        snippet: "tier: 'pro'",
        occurrence: 1,
      }),
    ]);
  });

  it('provides a hard zero-surface gate for the separate alias-removal release', () => {
    const observed = collectJwtTierClaimInventory(process.cwd());
    const result = validateJwtTierClaimInventory(observed, manifest, {
      requireZero: true,
    });

    expect(observed.length).toBeGreaterThan(0);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      `JWT tier-claim compatibility surface is not zero: ${observed.length}`,
    );
  });
});
