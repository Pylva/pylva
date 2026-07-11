// Enforce-ALL budget semantics (contract-pinned, shared with the Python SDK
// via tests/contracts/budget-rule-selection-contract.json) plus local spend
// recording: every applicable budget rule is checked pre-call, a
// customer-specific cap is never shadowed by a newer global rule, and
// recordLlmSpend prices completed calls into every applicable rule's
// accumulator so hard stops react without waiting for the backend flag.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const cachedRules: unknown[] = [];
let passthrough = false;

vi.mock('../src/core/rules_cache.js', () => ({
  ensureRulesCache: vi.fn(async () => {}),
  getCachedRules: () => cachedRules,
  isPassthrough: () => passthrough,
}));

const pricingTable = new Map<string, { input_per_1m: number; output_per_1m: number }>();
vi.mock('../src/core/pricing_cache.js', () => ({
  ensurePricingCache: vi.fn(async () => {}),
  getPricing: (provider: string, model: string) => {
    const entry = pricingTable.get(`${provider}|${model}`);
    return entry ? { provider, model, ...entry } : undefined;
  },
}));

const { maybeEnforcePreCall } = await import('../src/wrappers/_budget.js');
const { recordLlmSpend, periodStartUtc } = await import('../src/core/budget_rules.js');
const { add, get, _resetAccumulatorForTests } = await import('../src/core/budget_accumulator.js');
const { PylvaBudgetExceeded } = await import('../src/errors/budget_exceeded.js');

interface ContractRule {
  type: string;
  enabled: boolean;
  customer_id: string | null;
  config: Record<string, unknown>;
}
interface ContractCase {
  name: string;
  rules: ContractRule[];
  customer_id: string;
  accumulated: Array<{
    rule_index: number;
    scope_customer_id: string | null;
    period: 'hour' | 'day' | 'week' | 'month';
    amount_usd: number;
  }>;
  expect: { blocked: boolean; blocked_by?: number; blocked_customer_id?: string | null };
}

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../tests/contracts/budget-rule-selection-contract.json',
);
const contract = JSON.parse(readFileSync(fixturePath, 'utf8')) as { cases: ContractCase[] };

function loadRules(rules: ContractRule[]): void {
  cachedRules.length = 0;
  rules.forEach((rule, i) => {
    cachedRules.push({ id: `rule-${i}`, ...rule });
  });
}

beforeEach(() => {
  cachedRules.length = 0;
  pricingTable.clear();
  passthrough = false;
  _resetAccumulatorForTests();
});

describe('budget rule selection contract (shared with sdk-py)', () => {
  for (const c of contract.cases) {
    it(c.name, () => {
      loadRules(c.rules);
      for (const acc of c.accumulated) {
        const scope = acc.scope_customer_id === null ? 'pooled' : 'per_customer';
        add(
          {
            rule_id: `rule-${acc.rule_index}`,
            scope,
            customer_id: acc.scope_customer_id,
            period_start: periodStartUtc(acc.period),
          },
          acc.amount_usd,
        );
      }

      let thrown: unknown = null;
      try {
        maybeEnforcePreCall({ customer_id: c.customer_id, estimated_usd: 0 });
      } catch (err) {
        thrown = err;
      }

      if (!c.expect.blocked) {
        expect(thrown).toBeNull();
        return;
      }
      expect(thrown).toBeInstanceOf(PylvaBudgetExceeded);
      const refusal = thrown as InstanceType<typeof PylvaBudgetExceeded>;
      expect(refusal.rule_id).toBe(`rule-${c.expect.blocked_by}`);
      if ('blocked_customer_id' in c.expect) {
        expect(refusal.customer_id).toBe(c.expect.blocked_customer_id);
      }
    });
  }
});

describe('recordLlmSpend — local budget accounting', () => {
  const dayRule = (overrides: Partial<ContractRule> = {}) => ({
    id: 'rule-local',
    type: 'budget_limit',
    enabled: true,
    customer_id: null,
    config: { limit_usd: 1, period: 'day', hard_stop: true, scope: 'per_customer' },
    ...overrides,
  });

  it('blocks the call after local spend crosses the limit — no backend flag involved', () => {
    cachedRules.push(dayRule());
    pricingTable.set('openai|gpt-test', { input_per_1m: 1, output_per_1m: 1 });

    // Two calls at $0.60 each ($0.30 in + $0.30 out): first passes, spend
    // accumulates to $1.20 > $1 limit, second is refused pre-call.
    maybeEnforcePreCall({ customer_id: 'alice', estimated_usd: 0 });
    recordLlmSpend({
      customer_id: 'alice',
      provider: 'openai',
      model: 'gpt-test',
      tokens_in: 300_000,
      tokens_out: 300_000,
    });
    maybeEnforcePreCall({ customer_id: 'alice', estimated_usd: 0 });
    recordLlmSpend({
      customer_id: 'alice',
      provider: 'openai',
      model: 'gpt-test',
      tokens_in: 300_000,
      tokens_out: 300_000,
    });

    expect(() => maybeEnforcePreCall({ customer_id: 'alice', estimated_usd: 0 })).toThrow(
      PylvaBudgetExceeded,
    );
    // Other customers are unaffected (per_customer scope).
    expect(() => maybeEnforcePreCall({ customer_id: 'bob', estimated_usd: 0 })).not.toThrow();
  });

  it('records into EVERY applicable rule key (global + customer-specific)', () => {
    cachedRules.push(
      dayRule({ id: 'rule-global' }),
      dayRule({ id: 'rule-alice', customer_id: 'alice' }),
    );
    pricingTable.set('openai|gpt-test', { input_per_1m: 1, output_per_1m: 0 });

    recordLlmSpend({
      customer_id: 'alice',
      provider: 'openai',
      model: 'gpt-test',
      tokens_in: 500_000,
      tokens_out: 0,
    });

    const key = { scope: 'per_customer' as const, customer_id: 'alice', period_start: periodStartUtc('day') };
    expect(get({ rule_id: 'rule-global', ...key }).total_usd).toBeCloseTo(0.5, 6);
    expect(get({ rule_id: 'rule-alice', ...key }).total_usd).toBeCloseTo(0.5, 6);
  });

  it('no-ops on unknown pricing, missing model, zero tokens, and passthrough', () => {
    cachedRules.push(dayRule());
    recordLlmSpend({
      customer_id: 'alice',
      provider: 'openai',
      model: 'unpriced-model',
      tokens_in: 500_000,
      tokens_out: 0,
    });
    recordLlmSpend({
      customer_id: 'alice',
      provider: null,
      model: null,
      tokens_in: 500_000,
      tokens_out: 0,
    });
    pricingTable.set('openai|gpt-test', { input_per_1m: 1, output_per_1m: 1 });
    recordLlmSpend({
      customer_id: 'alice',
      provider: 'openai',
      model: 'gpt-test',
      tokens_in: 0,
      tokens_out: 0,
    });
    passthrough = true;
    recordLlmSpend({
      customer_id: 'alice',
      provider: 'openai',
      model: 'gpt-test',
      tokens_in: 500_000,
      tokens_out: 0,
    });
    passthrough = false;

    const key = {
      rule_id: 'rule-local',
      scope: 'per_customer' as const,
      customer_id: 'alice',
      period_start: periodStartUtc('day'),
    };
    expect(get(key).total_usd).toBe(0);
    expect(() => maybeEnforcePreCall({ customer_id: 'alice', estimated_usd: 0 })).not.toThrow();
  });

  it('pooled rules accumulate one shared pot from every customer', () => {
    cachedRules.push(
      dayRule({ id: 'rule-pool', config: { limit_usd: 1, period: 'day', hard_stop: true, scope: 'pooled' } }),
    );
    pricingTable.set('openai|gpt-test', { input_per_1m: 1, output_per_1m: 0 });

    recordLlmSpend({ customer_id: 'alice', provider: 'openai', model: 'gpt-test', tokens_in: 600_000, tokens_out: 0 });
    recordLlmSpend({ customer_id: 'bob', provider: 'openai', model: 'gpt-test', tokens_in: 600_000, tokens_out: 0 });

    // $1.20 pooled ≥ $1 — every customer is now blocked.
    expect(() => maybeEnforcePreCall({ customer_id: 'carol', estimated_usd: 0 })).toThrow(
      PylvaBudgetExceeded,
    );
  });

  it('per_customer scope with no customer identity never leaks into the pooled bucket', () => {
    cachedRules.push(dayRule({ id: 'rule-pc' }));
    // Seed what the old null→'__pooled__' collapse would have read.
    add(
      { rule_id: 'rule-pc', scope: 'pooled', customer_id: null, period_start: periodStartUtc('day') },
      50,
    );
    // A per_customer check with null identity must not read the pooled token.
    expect(() => maybeEnforcePreCall({ customer_id: null, estimated_usd: 0 })).not.toThrow();
  });
});
