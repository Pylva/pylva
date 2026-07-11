import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe("migration 037 — builders.tier default = 'free'", () => {
  it('alters the column default back to free', async () => {
    const src = await readFile(
      path.resolve(__dirname, '../../db/migrations/037_builders_tier_default_free.sql'),
      'utf8',
    );
    expect(src).toMatch(/ALTER TABLE\s+builders\s+ALTER COLUMN\s+tier\s+SET DEFAULT\s+'free'/i);
  });
});
