// B4-2 — pure-unit coverage of the SDK rules engine.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  RuleConflictResolution,
  RuleDecisionAction,
  RuleStatus,
  RuleType,
} from '@pylva/shared';
import {
  evaluatePreCall,
  _resetEngineForTests,
  type CachedRule,
  type PreCallContext,
} from '../src/core/rules_engine.js';

const NOW_ISO = '2026-04-26T12:00:00Z';

function rule(overrides: Partial<CachedRule> & Pick<CachedRule, 'type' | 'config'>): CachedRule {
  return {
    id: 'rule-' + Math.random().toString(36).slice(2, 8),
    enabled: true,
    status: RuleStatus.ACTIVE,
    customer_id: null,
    updated_at: NOW_ISO,
    ...overrides,
  };
}

function ctx(overrides: Partial<PreCallContext> = {}): PreCallContext {
  return {
    customer_id: 'cust_1',
    step_name: 'summarize',
    provider: 'openai',
    model: 'gpt-4o',
    ...overrides,
  };
}

const FALLBACK = {
  on_cross_provider_auth_error: true,
  on_access_denied: true,
  on_model_not_found: true,
  use_original_model: true,
  skip_same_provider_401: true,
};

describe('evaluatePreCall — narrowing', () => {
  beforeEach(() => _resetEngineForTests());

  it('skips rules missing required fields', () => {
    const out = evaluatePreCall([{ broken: true }, null, undefined, 'not-a-rule'], ctx());
    expect(out.decision.action).toBe(RuleDecisionAction.ALLOW);
  });

  it('skips disabled rules', () => {
    const r = rule({
      type: RuleType.MODEL_ROUTING,
      enabled: false,
      config: {
        scope: 'per_customer',
        match: { step_name: 'summarize' },
        route_to: { provider: 'openai', model: 'gpt-4o-mini' },
        fallback: FALLBACK,
      },
    });
    const out = evaluatePreCall([r], ctx());
    expect(out.decision.action).toBe(RuleDecisionAction.ALLOW);
  });

  it('skips draft rules', () => {
    const r = rule({
      type: RuleType.MODEL_ROUTING,
      status: RuleStatus.DRAFT,
      config: {
        scope: 'per_customer',
        match: { step_name: 'summarize' },
        route_to: { provider: 'openai', model: 'gpt-4o-mini' },
        fallback: FALLBACK,
      },
    });
    const out = evaluatePreCall([r], ctx());
    expect(out.decision.action).toBe(RuleDecisionAction.ALLOW);
  });
});

describe('evaluatePreCall — model routing', () => {
  beforeEach(() => _resetEngineForTests());

  it('matches on step_name and routes', () => {
    const r = rule({
      type: RuleType.MODEL_ROUTING,
      config: {
        scope: 'per_customer',
        match: { step_name: 'summarize' },
        route_to: { provider: 'openai', model: 'gpt-4o-mini' },
        fallback: FALLBACK,
      },
    });
    const out = evaluatePreCall([r], ctx());
    expect(out.decision.action).toBe(RuleDecisionAction.ROUTE_MODEL);
    if (out.decision.action === RuleDecisionAction.ROUTE_MODEL) {
      expect(out.decision.model).toBe('gpt-4o-mini');
      expect(out.decision.original_model).toBe('gpt-4o');
    }
  });

  it('does not route when step_name does not match', () => {
    const r = rule({
      type: RuleType.MODEL_ROUTING,
      config: {
        scope: 'per_customer',
        match: { step_name: 'never_run' },
        route_to: { provider: 'openai', model: 'gpt-4o-mini' },
        fallback: FALLBACK,
      },
    });
    const out = evaluatePreCall([r], ctx());
    expect(out.decision.action).toBe(RuleDecisionAction.ALLOW);
  });

  it('most-specific wins: customer+step+model beats global', () => {
    const global_ = rule({
      type: RuleType.MODEL_ROUTING,
      id: 'global',
      config: {
        scope: 'per_customer',
        match: { step_name: 'summarize' },
        route_to: { provider: 'openai', model: 'gpt-4o-mini' },
        fallback: FALLBACK,
      },
    });
    const specific = rule({
      type: RuleType.MODEL_ROUTING,
      id: 'specific',
      customer_id: 'cust_1',
      config: {
        scope: 'per_customer',
        match: { step_name: 'summarize', model: 'gpt-4o' },
        route_to: { provider: 'openai', model: 'gpt-3.5-turbo' },
        fallback: FALLBACK,
      },
    });
    const out = evaluatePreCall([global_, specific], ctx());
    if (out.decision.action !== RuleDecisionAction.ROUTE_MODEL) throw new Error('expected route');
    expect(out.decision.rule_id).toBe('specific');
    expect(out.decision.model).toBe('gpt-3.5-turbo');
  });

  it('does not fall through from empty rule customer_id to match.customer_id', () => {
    const r = rule({
      type: RuleType.MODEL_ROUTING,
      customer_id: '',
      config: {
        scope: 'per_customer',
        match: { customer_id: 'cust_1', step_name: 'summarize' },
        route_to: { provider: 'openai', model: 'gpt-4o-mini' },
        fallback: FALLBACK,
      },
    });
    const out = evaluatePreCall([r], ctx({ customer_id: 'cust_1' }));
    expect(out.decision.action).toBe(RuleDecisionAction.ALLOW);
  });

  it('same specificity: most recently updated wins', () => {
    const older = rule({
      type: RuleType.MODEL_ROUTING,
      id: 'older',
      updated_at: '2026-04-20T10:00:00Z',
      config: {
        scope: 'per_customer',
        match: { step_name: 'summarize' },
        route_to: { provider: 'openai', model: 'old-model' },
        fallback: FALLBACK,
      },
    });
    const newer = rule({
      type: RuleType.MODEL_ROUTING,
      id: 'newer',
      updated_at: '2026-04-25T10:00:00Z',
      config: {
        scope: 'per_customer',
        match: { step_name: 'summarize' },
        route_to: { provider: 'openai', model: 'new-model' },
        fallback: FALLBACK,
      },
    });
    const out = evaluatePreCall([older, newer], ctx());
    if (out.decision.action !== RuleDecisionAction.ROUTE_MODEL) throw new Error('expected route');
    expect(out.decision.rule_id).toBe('newer');
  });

  it('exposes routing.score for downstream introspection', () => {
    const r = rule({
      type: RuleType.MODEL_ROUTING,
      customer_id: 'cust_1',
      config: {
        scope: 'per_customer',
        match: { step_name: 'summarize', model: 'gpt-4o' },
        route_to: { provider: 'openai', model: 'gpt-4o-mini' },
        fallback: FALLBACK,
      },
    });
    const out = evaluatePreCall([r], ctx());
    expect(out.routing?.score).toBe(RuleConflictResolution.CUSTOMER_STEP_MODEL);
  });
});

// bug_013 class, TS side: malformed model_routing config must never throw
// out of evaluatePreCall — the wrapper rethrows engine errors to the host
// (R1 violation) and the provider call is never issued. sdk-py already
// guards this (`cfg.get("match") or {}` / `decision.model and
// decision.fallback`); these pin the TS engine to the same semantics.
describe('evaluatePreCall — malformed model_routing config (R1)', () => {
  beforeEach(() => _resetEngineForTests());

  it('does not throw when match is missing; treats it as match-any (sdk-py parity)', () => {
    const r = rule({
      type: RuleType.MODEL_ROUTING,
      config: {
        scope: 'per_customer',
        route_to: { provider: 'openai', model: 'gpt-4o-mini' },
        fallback: FALLBACK,
      },
    });
    const out = evaluatePreCall([r], ctx());
    expect(out.decision.action).toBe(RuleDecisionAction.ROUTE_MODEL);
    if (out.decision.action === RuleDecisionAction.ROUTE_MODEL) {
      expect(out.decision.model).toBe('gpt-4o-mini');
    }
    expect(out.routing?.score).toBe(RuleConflictResolution.GLOBAL);
  });

  it('does not throw when match is not an object', () => {
    const r = rule({
      type: RuleType.MODEL_ROUTING,
      config: {
        scope: 'per_customer',
        match: 'summarize',
        route_to: { provider: 'openai', model: 'gpt-4o-mini' },
        fallback: FALLBACK,
      },
    });
    const out = evaluatePreCall([r], ctx());
    expect(out.decision.action).toBe(RuleDecisionAction.ROUTE_MODEL);
  });

  it('degrades to allow when route_to is missing', () => {
    const r = rule({
      type: RuleType.MODEL_ROUTING,
      config: {
        scope: 'per_customer',
        match: { step_name: 'summarize' },
        fallback: FALLBACK,
      },
    });
    const out = evaluatePreCall([r], ctx());
    expect(out.decision.action).toBe(RuleDecisionAction.ALLOW);
  });

  it('degrades to allow when route_to.model is not a string', () => {
    const r = rule({
      type: RuleType.MODEL_ROUTING,
      config: {
        scope: 'per_customer',
        match: { step_name: 'summarize' },
        route_to: { provider: 'openai' },
        fallback: FALLBACK,
      },
    });
    const out = evaluatePreCall([r], ctx());
    expect(out.decision.action).toBe(RuleDecisionAction.ALLOW);
  });

  it('degrades to allow when fallback is missing', () => {
    const r = rule({
      type: RuleType.MODEL_ROUTING,
      config: {
        scope: 'per_customer',
        match: { step_name: 'summarize' },
        route_to: { provider: 'openai', model: 'gpt-4o-mini' },
      },
    });
    const out = evaluatePreCall([r], ctx());
    expect(out.decision.action).toBe(RuleDecisionAction.ALLOW);
  });

  it('degrades to allow when fallback is an array (sdk-py parity)', () => {
    const r = rule({
      type: RuleType.MODEL_ROUTING,
      config: {
        scope: 'per_customer',
        match: { step_name: 'summarize' },
        route_to: { provider: 'openai', model: 'gpt-4o-mini' },
        fallback: [],
      },
    });
    const out = evaluatePreCall([r], ctx());
    expect(out.decision.action).toBe(RuleDecisionAction.ALLOW);
  });

  it('keeps the malformed winner — does not promote a less specific valid rule (sdk-py parity)', () => {
    const validGlobal = rule({
      type: RuleType.MODEL_ROUTING,
      id: 'valid-global',
      config: {
        scope: 'per_customer',
        match: { step_name: 'summarize' },
        route_to: { provider: 'openai', model: 'gpt-4o-mini' },
        fallback: FALLBACK,
      },
    });
    const malformedSpecific = rule({
      type: RuleType.MODEL_ROUTING,
      id: 'malformed-specific',
      customer_id: 'cust_1',
      config: {
        scope: 'per_customer',
        match: { step_name: 'summarize', model: 'gpt-4o' },
        fallback: FALLBACK,
      },
    });
    const out = evaluatePreCall([validGlobal, malformedSpecific], ctx());
    expect(out.decision.action).toBe(RuleDecisionAction.ALLOW);
  });

  it('still surfaces a matching failover rule when routing degrades', () => {
    const malformed = rule({
      type: RuleType.MODEL_ROUTING,
      config: {
        scope: 'per_customer',
        match: { step_name: 'summarize' },
        fallback: FALLBACK,
      },
    });
    const failover = rule({
      type: RuleType.RELIABILITY_FAILOVER,
      config: {
        customer_id: 'cust_1',
        primary_provider: 'openai',
        backup_provider: 'anthropic',
        enabled: true,
        consent_to_cost_shift: true,
        trigger_error_rate_pct: 10,
        window_seconds: 300,
        recover_error_rate_pct: 5,
        recover_after_seconds: 300,
        recovery_probe_after_seconds: 1800,
      },
    });
    const out = evaluatePreCall([malformed, failover], ctx());
    expect(out.decision.action).toBe(RuleDecisionAction.ALLOW);
    expect(out.failover?.cfg.backup_provider).toBe('anthropic');
  });
});

describe('evaluatePreCall — failover', () => {
  beforeEach(() => _resetEngineForTests());

  it('surfaces a matching enabled failover rule', () => {
    const r = rule({
      type: RuleType.RELIABILITY_FAILOVER,
      config: {
        customer_id: 'cust_1',
        primary_provider: 'openai',
        backup_provider: 'anthropic',
        enabled: true,
        consent_to_cost_shift: true,
        trigger_error_rate_pct: 10,
        window_seconds: 300,
        recover_error_rate_pct: 5,
        recover_after_seconds: 300,
        recovery_probe_after_seconds: 1800,
      },
    });
    const out = evaluatePreCall([r], ctx());
    expect(out.failover?.cfg.backup_provider).toBe('anthropic');
  });

  it('skips disabled failover rules', () => {
    const r = rule({
      type: RuleType.RELIABILITY_FAILOVER,
      config: {
        customer_id: 'cust_1',
        primary_provider: 'openai',
        backup_provider: 'anthropic',
        enabled: false,
        consent_to_cost_shift: true,
        trigger_error_rate_pct: 10,
        window_seconds: 300,
        recover_error_rate_pct: 5,
        recover_after_seconds: 300,
        recovery_probe_after_seconds: 1800,
      },
    });
    const out = evaluatePreCall([r], ctx());
    expect(out.failover).toBeUndefined();
  });

  it('does not match when primary_provider differs', () => {
    const r = rule({
      type: RuleType.RELIABILITY_FAILOVER,
      config: {
        customer_id: 'cust_1',
        primary_provider: 'anthropic',
        backup_provider: 'openai',
        enabled: true,
        consent_to_cost_shift: true,
        trigger_error_rate_pct: 10,
        window_seconds: 300,
        recover_error_rate_pct: 5,
        recover_after_seconds: 300,
        recovery_probe_after_seconds: 1800,
      },
    });
    const out = evaluatePreCall([r], ctx({ provider: 'openai' }));
    expect(out.failover).toBeUndefined();
  });
});
