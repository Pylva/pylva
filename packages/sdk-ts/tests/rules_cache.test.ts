import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetConfigForTests, init as initConfig } from '../src/core/config.js';
import {
  _resetRulesCacheForTests,
  ensureRulesCache,
  getCachedRules,
  isPassthrough,
} from '../src/core/rules_cache.js';
import { maybeEnforcePreCall } from '../src/wrappers/_budget.js';

const VALID_KEY = `pv_live_12345678_${'a'.repeat(32)}`;

beforeEach(() => {
  vi.restoreAllMocks();
  _resetConfigForTests();
  _resetRulesCacheForTests();
  initConfig({ apiKey: VALID_KEY, endpoint: 'http://mock' });
});

describe('rules cache response validation', () => {
  it.each([
    ['invalid JSON', new Response('{', { status: 200 })],
    ['a non-object body', new Response('null', { status: 200 })],
    ['a missing rules field', new Response('{}', { status: 200 })],
    [
      'a non-array rules field',
      new Response(JSON.stringify({ rules: { id: 'not-an-array' } }), { status: 200 }),
    ],
  ])('enters passthrough when the backend returns %s', async (_case, response) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);

    await expect(ensureRulesCache()).resolves.toBeUndefined();

    expect(getCachedRules()).toEqual([]);
    expect(isPassthrough()).toBe(true);
    expect(() => maybeEnforcePreCall({ customer_id: 'cust_test', estimated_usd: 0 })).not.toThrow();
  });

  it('preserves a valid stale cache when a later refresh has a malformed shape', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ rules: [{ id: 'known-good' }] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ rules: { id: 'not-an-array' } }), { status: 200 }),
      );

    await ensureRulesCache();
    now.mockReturnValue(1_060_001);
    await ensureRulesCache();

    expect(getCachedRules()).toEqual([{ id: 'known-good' }]);
    expect(isPassthrough()).toBe(true);
  });
});
