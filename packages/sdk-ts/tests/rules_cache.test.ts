import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Provider, RuleStatus, RuleType } from '@pylva/shared';
import { _resetConfigForTests, init as initConfig } from '../src/core/config.js';
import {
  _resetRulesCacheForTests,
  ensureRulesCache,
  getCachedRules,
  isPassthrough,
} from '../src/core/rules_cache.js';
import { maybeEnforcePreCall } from '../src/wrappers/_budget.js';
import { runWithEngine } from '../src/wrappers/_engine.js';

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

  it.each([401, 403])(
    'clears warmed rules when the backend definitively rejects the SDK identity with %s',
    async (status) => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ rules: [{ id: 'warmed-routing-rule' }] }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'restricted' }), { status }));

      await ensureRulesCache();
      expect(getCachedRules()).toEqual([{ id: 'warmed-routing-rule' }]);

      now.mockReturnValue(1_060_001);
      await ensureRulesCache();

      expect(getCachedRules()).toEqual([]);
      expect(isPassthrough()).toBe(true);
    },
  );

  it('quarantines expired warmed routing before a fire-and-forget 403 refresh completes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const warmedRules = [
      {
        id: 'route-before-suspension',
        type: RuleType.MODEL_ROUTING,
        enabled: true,
        status: RuleStatus.ACTIVE,
        customer_id: null,
        updated_at: '2026-07-23T00:00:00Z',
        config: {
          scope: 'per_customer',
          match: { provider: Provider.OPENAI, model: 'gpt-4o' },
          route_to: { provider: Provider.OPENAI, model: 'gpt-4o-mini' },
          fallback: {
            on_cross_provider_auth_error: true,
            on_access_denied: true,
            on_model_not_found: true,
            use_original_model: true,
            skip_same_provider_401: true,
          },
        },
      },
    ];
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ rules: warmedRules }), {
          status: 200,
        }),
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 'workspace_suspended' }), {
          status: 403,
        }),
      );

    await ensureRulesCache();
    now.mockReturnValue(1_060_001);
    const calls: string[] = [];
    const issueCall = () =>
      runWithEngine({
        request: { model: 'gpt-4o' },
        providerId: Provider.OPENAI,
        ctx: {
          customer_id: 'cust_1',
          step_name: null,
          provider: Provider.OPENAI,
          model: 'gpt-4o',
        },
        call: async (request) => {
          calls.push(request['model'] as string);
          return { ok: true };
        },
      });

    const first = await issueCall();
    await ensureRulesCache();
    const second = await issueCall();

    expect(calls).toEqual(['gpt-4o', 'gpt-4o']);
    expect(first.metadata.routing_applied).toBe(false);
    expect(first.metadata.failover_active).toBe(false);
    expect(second.metadata.routing_applied).toBe(false);
    expect(second.metadata.failover_active).toBe(false);
    expect(getCachedRules()).toEqual([]);
    expect(isPassthrough()).toBe(true);
  });
});
