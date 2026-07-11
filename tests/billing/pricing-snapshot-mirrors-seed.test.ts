// Root-cause guard for pricing drift (see PR "pricing drift: ...").
//
// Two failure modes this test exists to prevent:
//   1. The committed packages/shared/pricing-snapshot.json silently being `[]`.
//      When LiteLLM upstream breaks for 3+ days the escalation runs
//      syncFromSnapshot() (litellm-sync.ts) to repopulate llm_pricing from this
//      file. An empty snapshot makes that fallback a no-op (it aborts with
//      `snapshot_empty`), so llm_pricing keeps drifting from live provider rates
//      with no safety net. The snapshot MUST carry real data.
//   2. The snapshot and the seed (db/seeds/llm_pricing_seed.json) drifting apart.
//      The seed is what populates llm_pricing on db:seed; the snapshot is the
//      disaster-recovery mirror of those same prices. If a price is corrected in
//      one but not the other, a LiteLLM-outage fallback would silently roll the
//      live table back to the stale number. They must agree, entry for entry.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface PriceEntry {
  provider: string;
  model: string;
  input_per_1m: number;
  output_per_1m: number;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function load(relPath: string): PriceEntry[] {
  const raw = fs.readFileSync(path.join(repoRoot, relPath), 'utf-8');
  return JSON.parse(raw) as PriceEntry[];
}

const key = (e: PriceEntry) => `${e.provider}/${e.model}`;

describe('pricing snapshot mirrors the LLM pricing seed', () => {
  const seed = load('db/seeds/llm_pricing_seed.json');
  const snapshot = load('packages/shared/pricing-snapshot.json');

  it('snapshot is non-empty (the DR fallback must carry data)', () => {
    expect(Array.isArray(snapshot)).toBe(true);
    expect(snapshot.length).toBeGreaterThan(0);
  });

  it('every seed entry has a matching snapshot entry with identical prices', () => {
    const snapshotByKey = new Map(snapshot.map((e) => [key(e), e]));

    for (const s of seed) {
      const snap = snapshotByKey.get(key(s));
      expect(snap, `snapshot is missing ${key(s)}`).toBeDefined();
      expect(snap!.input_per_1m, `input price mismatch for ${key(s)}`).toBe(s.input_per_1m);
      expect(snap!.output_per_1m, `output price mismatch for ${key(s)}`).toBe(s.output_per_1m);
    }
  });

  it('snapshot has no extra entries the seed does not define', () => {
    const seedKeys = new Set(seed.map(key));
    const extra = snapshot.filter((e) => !seedKeys.has(key(e))).map(key);
    expect(extra, `snapshot has entries absent from the seed: ${extra.join(', ')}`).toEqual([]);
  });
});
