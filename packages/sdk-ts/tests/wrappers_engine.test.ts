// runWithEngine integration tests. Drives the wrapper-side engine glue
// without booting a real provider SDK. Covers the major paths the
// per-wrapper test files would otherwise duplicate.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Provider, RuleStatus, RuleType, RuleWarningCode } from '@pylva/shared';
import { FAILOVER_CFG_BASE } from './helpers/failover_fixtures.js';

const cachedRules: unknown[] = [];

vi.mock('../src/core/rules_cache.js', () => ({
  ensureRulesCache: vi.fn(async () => {}),
  getCachedRules: () => cachedRules,
  isPassthrough: () => false,
}));

vi.mock('../src/core/budget_accumulator.js', () => ({
  check: vi.fn(() => ({ over_limit: false, accumulated_usd: 0, projected_usd: 0 })),
}));

const { runWithEngine, attachPylvaMetadata } = await import('../src/wrappers/_engine.js');
const { _resetEngineForTests } = await import('../src/core/rules_engine.js');
const { check } = await import('../src/core/budget_accumulator.js');
const { init, _resetConfigForTests } = await import('../src/core/config.js');
const { _resetFailoverForTests, ensureState, recordOutcome } =
  await import('../src/core/failover.js');
const { PylvaBudgetExceeded } = await import('../src/errors/budget_exceeded.js');

const FALLBACK = {
  on_cross_provider_auth_error: true,
  on_access_denied: true,
  on_model_not_found: true,
  use_original_model: true,
  skip_same_provider_401: true,
};

const FAILOVER_CFG = FAILOVER_CFG_BASE;

beforeEach(() => {
  cachedRules.length = 0;
  vi.mocked(check).mockReset();
  vi.mocked(check).mockReturnValue({ over_limit: false, accumulated_usd: 0, projected_usd: 0 });
  _resetEngineForTests();
  _resetFailoverForTests();
  _resetConfigForTests();
});

describe('runWithEngine — pass-through (no rules)', () => {
  it('issues the call with the original request and returns minimal metadata', async () => {
    const calls: Array<{ model?: string }> = [];
    const out = await runWithEngine<{ ok: true; model: string }>({
      request: { model: 'gpt-4o' },
      providerId: Provider.OPENAI,
      ctx: {
        customer_id: 'cust_1',
        step_name: 'summarize',
        provider: Provider.OPENAI,
        model: 'gpt-4o',
      },
      call: async (req) => {
        calls.push(req);
        return { ok: true, model: req['model'] as string };
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model: 'gpt-4o' });
    expect(out.metadata.routing_applied).toBe(false);
    expect(out.metadata.original_model).toBe('gpt-4o');
    expect(out.metadata.warnings).toBeUndefined();
  });
});

describe('runWithEngine — same-provider model routing', () => {
  it('mutates request.model and reports routing_applied=true', async () => {
    cachedRules.push({
      id: 'r1',
      type: RuleType.MODEL_ROUTING,
      enabled: true,
      status: RuleStatus.ACTIVE,
      customer_id: null,
      updated_at: '2026-04-26T00:00:00Z',
      config: {
        scope: 'per_customer',
        match: { step_name: 'summarize', provider: Provider.OPENAI, model: 'gpt-4o' },
        route_to: { provider: Provider.OPENAI, model: 'gpt-4o-mini' },
        fallback: FALLBACK,
      },
    });
    const calls: Array<{ model?: string }> = [];
    const out = await runWithEngine<{ ok: true; model: string }>({
      request: { model: 'gpt-4o' },
      providerId: Provider.OPENAI,
      ctx: {
        customer_id: 'cust_1',
        step_name: 'summarize',
        provider: Provider.OPENAI,
        model: 'gpt-4o',
      },
      call: async (req) => {
        calls.push(req);
        return { ok: true, model: req['model'] as string };
      },
    });
    expect(calls[0]?.model).toBe('gpt-4o-mini');
    expect(out.metadata.routing_applied).toBe(true);
    expect(out.metadata.routed_model).toBe('gpt-4o-mini');
    expect(out.metadata.original_model).toBe('gpt-4o');
  });

  it('falls back to original model on 404 + reports the fallback', async () => {
    cachedRules.push({
      id: 'r1',
      type: RuleType.MODEL_ROUTING,
      enabled: true,
      status: RuleStatus.ACTIVE,
      customer_id: null,
      updated_at: '2026-04-26T00:00:00Z',
      config: {
        scope: 'per_customer',
        match: { step_name: 'summarize', model: 'gpt-4o' },
        route_to: { provider: Provider.OPENAI, model: 'gpt-future' },
        fallback: FALLBACK,
      },
    });
    const calls: string[] = [];
    const out = await runWithEngine<{ ok: true; model: string }>({
      request: { model: 'gpt-4o' },
      providerId: Provider.OPENAI,
      ctx: {
        customer_id: 'cust_1',
        step_name: 'summarize',
        provider: Provider.OPENAI,
        model: 'gpt-4o',
      },
      call: async (req) => {
        const m = req['model'] as string;
        calls.push(m);
        if (m === 'gpt-future') {
          const err = new Error('model not found') as Error & { status: number };
          err.status = 404;
          throw err;
        }
        return { ok: true, model: m };
      },
    });
    expect(calls).toEqual(['gpt-future', 'gpt-4o']);
    expect(out.metadata.routing_applied).toBe(false);
    expect(out.metadata.warnings?.[0]?.code).toBe(RuleWarningCode.ROUTING_FALLBACK_NOT_FOUND_404);
  });

  it('does NOT retry on same-provider 401 (D25)', async () => {
    cachedRules.push({
      id: 'r1',
      type: RuleType.MODEL_ROUTING,
      enabled: true,
      status: RuleStatus.ACTIVE,
      customer_id: null,
      updated_at: '2026-04-26T00:00:00Z',
      config: {
        scope: 'per_customer',
        match: { step_name: 'summarize' },
        route_to: { provider: Provider.OPENAI, model: 'gpt-4o-mini' },
        fallback: FALLBACK,
      },
    });
    const calls: string[] = [];
    await expect(
      runWithEngine<{ ok: true }>({
        request: { model: 'gpt-4o' },
        providerId: Provider.OPENAI,
        ctx: {
          customer_id: 'cust_1',
          step_name: 'summarize',
          provider: Provider.OPENAI,
          model: 'gpt-4o',
        },
        call: async (req) => {
          calls.push(req['model'] as string);
          const err = new Error('auth') as Error & { status: number };
          err.status = 401;
          throw err;
        },
      }),
    ).rejects.toThrow('auth');
    expect(calls).toEqual(['gpt-4o-mini']);
  });
});

describe('runWithEngine — cross-provider routing skipped', () => {
  it('skips cross-provider routing inside the same wrapper, emits warning', async () => {
    cachedRules.push({
      id: 'r1',
      type: RuleType.MODEL_ROUTING,
      enabled: true,
      status: RuleStatus.ACTIVE,
      customer_id: null,
      updated_at: '2026-04-26T00:00:00Z',
      config: {
        scope: 'per_customer',
        match: { step_name: 'summarize' },
        route_to: { provider: Provider.ANTHROPIC, model: 'claude-sonnet' },
        fallback: FALLBACK,
      },
    });
    const calls: Array<{ model?: string }> = [];
    const out = await runWithEngine<{ ok: true; model: string }>({
      request: { model: 'gpt-4o' },
      providerId: Provider.OPENAI,
      ctx: {
        customer_id: 'cust_1',
        step_name: 'summarize',
        provider: Provider.OPENAI,
        model: 'gpt-4o',
      },
      call: async (req) => {
        calls.push(req);
        return { ok: true, model: req['model'] as string };
      },
    });
    expect(calls[0]?.model).toBe('gpt-4o');
    expect(out.metadata.routing_applied).toBe(false);
    expect(
      out.metadata.warnings?.some((w) => w.code === RuleWarningCode.ROUTING_CROSS_PROVIDER_SKIPPED),
    ).toBe(true);
  });
});

describe('runWithEngine — budget hard-block', () => {
  it('throws PylvaBudgetExceeded before issuing the call', async () => {
    vi.mocked(check).mockReturnValueOnce({
      over_limit: true,
      accumulated_usd: 10,
      projected_usd: 10,
    });
    cachedRules.push({
      id: 'r1',
      type: RuleType.BUDGET_LIMIT,
      enabled: true,
      customer_id: 'cust_1',
      config: { limit_usd: 5, period: 'day', hard_stop: true, scope: 'per_customer' },
    });
    const calls: unknown[] = [];
    await expect(
      runWithEngine({
        request: { model: 'gpt-4o' },
        providerId: Provider.OPENAI,
        ctx: { customer_id: 'cust_1', step_name: null, provider: Provider.OPENAI, model: 'gpt-4o' },
        call: async (req) => {
          calls.push(req);
          return { ok: true };
        },
      }),
    ).rejects.toBeInstanceOf(PylvaBudgetExceeded);
    expect(calls).toHaveLength(0);
  });
});

describe('runWithEngine — failover outcome recording', () => {
  function pushFailoverRule() {
    cachedRules.push({
      id: 'r1',
      type: RuleType.RELIABILITY_FAILOVER,
      enabled: true,
      status: RuleStatus.ACTIVE,
      customer_id: 'cust_1',
      updated_at: '2026-04-26T00:00:00Z',
      config: FAILOVER_CFG,
    });
  }

  it('records ok=true on successful call', async () => {
    pushFailoverRule();
    await runWithEngine({
      request: { model: 'gpt-4o' },
      providerId: Provider.OPENAI,
      ctx: { customer_id: 'cust_1', step_name: null, provider: Provider.OPENAI, model: 'gpt-4o' },
      call: async () => ({ ok: true }),
    });
    const samples = ensureState(FAILOVER_CFG).samples;
    expect(samples).toHaveLength(1);
    expect(samples[0]?.ok).toBe(true);
  });

  it('records ok=false when the underlying call throws', async () => {
    pushFailoverRule();
    await expect(
      runWithEngine({
        request: { model: 'gpt-4o' },
        providerId: Provider.OPENAI,
        ctx: { customer_id: 'cust_1', step_name: null, provider: Provider.OPENAI, model: 'gpt-4o' },
        call: async () => {
          throw new Error('upstream 500');
        },
      }),
    ).rejects.toThrow('upstream 500');
    const samples = ensureState(FAILOVER_CFG).samples;
    expect(samples).toHaveLength(1);
    expect(samples[0]?.ok).toBe(false);
  });

  it('does not record a late old-identity provider failure in the new tenant state', async () => {
    pushFailoverRule();
    init({ apiKey: `pv_live_aabbccdd_${'a'.repeat(32)}`, localMode: true });
    let rejectProvider!: (error: Error) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const providerCall = new Promise<never>((_resolve, reject) => {
      rejectProvider = reject;
    });
    const pending = runWithEngine({
      request: { model: 'gpt-4o' },
      providerId: Provider.OPENAI,
      ctx: {
        customer_id: 'cust_old',
        step_name: null,
        provider: Provider.OPENAI,
        model: 'gpt-4o',
      },
      call: async () => {
        markStarted();
        return providerCall;
      },
    });
    await started;

    init({ apiKey: `pv_live_bbccddee_${'b'.repeat(32)}`, localMode: true });
    rejectProvider(new Error('late tenant-A failure'));

    await expect(pending).rejects.toThrow('late tenant-A failure');
    expect(ensureState(FAILOVER_CFG).samples).toHaveLength(0);
  });

  it('mentions the Pylva alias in missing-backup warnings', async () => {
    pushFailoverRule();
    recordOutcome(FAILOVER_CFG, false, 0);

    const out = await runWithEngine({
      request: { model: 'gpt-4o' },
      providerId: Provider.OPENAI,
      ctx: { customer_id: 'cust_1', step_name: null, provider: Provider.OPENAI, model: 'gpt-4o' },
      call: async () => ({ ok: true }),
    });

    const warning = out.metadata.warnings?.find(
      (w) => w.code === RuleWarningCode.FAILOVER_MISSING_BACKUP,
    );
    expect(warning?.message).toContain('new Pylva({ providers: { "anthropic": client } })');
    expect(warning?.message).not.toContain('constructor alias');
  });
});

describe('attachPylvaMetadata', () => {
  it('attaches metadata to a response object', () => {
    const response = { ok: true };
    const result = attachPylvaMetadata(response, {
      original_model: 'gpt-4o',
      routing_applied: false,
      failover_active: false,
    });
    expect(result._pylva.original_model).toBe('gpt-4o');
    expect(result._pylva.routing_applied).toBe(false);
  });
});

describe('runWithEngine — malformed model_routing rule in cache (R1)', () => {
  it('issues the original call instead of throwing when config.match is missing', async () => {
    cachedRules.push({
      id: 'r-malformed',
      type: RuleType.MODEL_ROUTING,
      enabled: true,
      status: RuleStatus.ACTIVE,
      customer_id: null,
      updated_at: '2026-04-26T00:00:00Z',
      // No `match`, no `route_to` — the shape a backend schema bump could
      // leave behind. Pre-fix this threw TypeError out of evaluatePreCall,
      // which the provider wrappers rethrow to the host agent.
      config: { scope: 'per_customer', fallback: FALLBACK },
    });
    const calls: Array<{ model?: string }> = [];
    const out = await runWithEngine<{ ok: true }>({
      request: { model: 'gpt-4o' },
      providerId: Provider.OPENAI,
      ctx: {
        customer_id: 'cust_1',
        step_name: 'summarize',
        provider: Provider.OPENAI,
        model: 'gpt-4o',
      },
      call: async (req) => {
        calls.push(req);
        return { ok: true };
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model: 'gpt-4o' });
    expect(out.metadata.routing_applied).toBe(false);
  });
});
