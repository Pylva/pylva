// Guard: seeded API keys must stay parseable by the live key validator.
// The original seed ids ('ka01'…) silently failed API_KEY_PATTERN's
// [a-f0-9]{8} keyId segment, so seeded keys could never authenticate against
// POST /api/v1/events — found by the tier-limits cap smoke (2026-07-02).

import { describe, expect, it } from 'vitest';
import { SEED_API_KEY_IDS } from '../../db/seed.js';
import { API_KEY_PATTERN } from '../../src/lib/auth/api-key-format.js';

describe('seed API key format', () => {
  const ids = Object.entries(SEED_API_KEY_IDS);

  it('uses 8-char lowercase hex key ids', () => {
    for (const [label, id] of ids) {
      expect(id, `${label} key id`).toMatch(/^[a-f0-9]{8}$/);
    }
  });

  it('produces keys the live validator can parse', () => {
    const randomPart = 'a'.repeat(32);
    for (const [label, id] of ids) {
      const fullKey = `pv_live_${id}_${randomPart}`;
      expect(fullKey, `${label} full key`).toMatch(API_KEY_PATTERN);
    }
  });
});
