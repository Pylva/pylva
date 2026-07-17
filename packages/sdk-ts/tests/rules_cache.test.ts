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
  it('enters passthrough instead of poisoning the wrapper with a non-array rules field', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ rules: { id: 'not-an-array' } }), { status: 200 }),
    );

    await expect(ensureRulesCache()).resolves.toBeUndefined();

    expect(getCachedRules()).toEqual([]);
    expect(isPassthrough()).toBe(true);
    expect(() => maybeEnforcePreCall({ customer_id: 'cust_test', estimated_usd: 0 })).not.toThrow();
  });
});
