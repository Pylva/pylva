import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pylva, init as publicInit } from '../src/index.js';
import { _resetConfigForTests } from '../src/core/config.js';
import { _resetTelemetryForTests, bufferSize, enqueue, flush } from '../src/core/telemetry.js';
import { _resetAccumulatorForTests, add, get } from '../src/core/budget_accumulator.js';
import {
  _resetPricingCacheForTests,
  ensurePricingCache,
  getPricing,
} from '../src/core/pricing_cache.js';
import {
  _resetRulesCacheForTests,
  ensureRulesCache,
  getCachedRules,
} from '../src/core/rules_cache.js';
import { _resetNonLlmPolicyForTests, decideNonLlmTool } from '../src/core/non_llm_policy.js';
import {
  _resetControlClientForTests,
  commitUsage,
  reserveUsage,
} from '../src/core/control_client.js';
import { _resetClientRegistry, getRegisteredClient } from '../src/core/client_registry.js';
import { _resetFailoverForTests, isActive, recordOutcome } from '../src/core/failover.js';
import type { ReliabilityFailoverConfig } from '@pylva/shared/rules';

const KEY_A = `pv_live_aabbccdd_${'a'.repeat(32)}`;
const KEY_B = `pv_live_bbccddee_${'b'.repeat(32)}`;
const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const TRACE_ID = '22222222-2222-4222-8222-222222222222';
const SPAN_ID = '33333333-3333-4333-8333-333333333333';
const RESERVATION_ID = '44444444-4444-4444-8444-444444444444';
const DECISION_ID = '55555555-5555-4555-8555-555555555555';

const capabilities = {
  schema_version: '1.0',
  control_enabled: true,
  min_reservation_ttl_seconds: 30,
  default_reservation_ttl_seconds: 300,
  max_reservation_ttl_seconds: 3600,
  server_time: '2026-07-14T09:00:00.000Z',
};

const reserved = {
  schema_version: '1.0',
  decision: 'reserved',
  allowed: true,
  decision_id: DECISION_ID,
  operation_id: OPERATION_ID,
  reservation_id: RESERVATION_ID,
  state: 'reserved',
  reserved_usd: '0.125',
  remaining_usd: '9.875',
  expires_at: '2026-07-14T09:05:00.000Z',
  warnings: [],
};

const committed = {
  schema_version: '1.0',
  state: 'committed',
  reservation_id: RESERVATION_ID,
  operation_id: OPERATION_ID,
  reserved_usd: '0.125',
  actual_usd: '0.1',
  released_usd: '0.025',
  overage_usd: '0',
  budget_exceeded_after_commit: false,
  committed_at: '2026-07-14T09:01:00.000Z',
  idempotent_replay: false,
  late: false,
};

const failoverConfig: ReliabilityFailoverConfig = {
  customer_id: 'customer-old',
  primary_provider: 'openai',
  backup_provider: 'anthropic',
  enabled: true,
  consent_to_cost_shift: true,
  trigger_error_rate_pct: 10,
  window_seconds: 300,
  recover_error_rate_pct: 5,
  recover_after_seconds: 300,
  recovery_probe_after_seconds: 1_800,
};

function makeEvent(spanId: string): Parameters<typeof enqueue>[0] {
  return {
    run_id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    parent_run_id: null,
    trace_id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
    span_id: spanId,
    parent_span_id: null,
    customer_id: 'cust_test',
    step_name: 'identity-test',
    model: 'gpt-4.1',
    provider: 'openai',
    tokens_in: 1,
    tokens_out: 1,
    latency_ms: 1,
    tool_name: null,
    status: 'success',
    framework: 'none',
    instrumentation_tier: 'sdk_wrapper',
    cost_source: 'auto',
    metric: null,
    metric_value: null,
    stream_aborted: false,
    abort_savings_usd: 0,
    timestamp: '2026-07-14T09:00:00.000Z',
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function resetAll(): void {
  _resetControlClientForTests();
  _resetTelemetryForTests();
  _resetAccumulatorForTests();
  _resetRulesCacheForTests();
  _resetPricingCacheForTests();
  _resetNonLlmPolicyForTests();
  _resetClientRegistry();
  _resetFailoverForTests();
  _resetConfigForTests();
}

describe('SDK identity-change barrier', () => {
  beforeEach(resetAll);
  afterEach(() => {
    vi.restoreAllMocks();
    resetAll();
  });

  it('never requeues or flushes old-builder telemetry under new credentials during concurrent reinit', async () => {
    let resolveOldEvents!: (response: Response) => void;
    const eventRequests: Array<{ key: string | null; body: Record<string, unknown> }> = [];
    let eventCall = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, request) => {
      const href = String(url);
      if (href.endsWith('/api/v1/pricing')) return json({ models: [] });
      if (href.endsWith('/api/v1/rules')) return json({ rules: [] });
      if (href.endsWith('/api/v1/events')) {
        eventCall += 1;
        eventRequests.push({
          key: new Headers(request?.headers).get('x-pylva-key'),
          body: JSON.parse(String(request?.body)) as Record<string, unknown>,
        });
        if (eventCall === 1) {
          return new Promise<Response>((resolve) => {
            // Deliberately ignore AbortSignal: epoch fencing must still make a
            // late old response unable to mutate or requeue new identity state.
            resolveOldEvents = resolve;
          });
        }
        return json({ accepted: 1, rejected: 0 });
      }
      throw new Error(`unexpected URL ${href}`);
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    publicInit({
      apiKey: KEY_A,
      endpoint: 'https://same.test',
      batchSize: 100,
      flushInterval: 60_000,
    });
    enqueue(makeEvent('11111111-1111-4111-8111-111111111111'));
    const oldFlush = flush();
    await vi.waitFor(() => expect(eventRequests).toHaveLength(1));

    publicInit({
      apiKey: KEY_B,
      endpoint: 'https://same.test',
      batchSize: 100,
      flushInterval: 60_000,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      '[pylva] SDK identity changed; dropped 1 buffered telemetry events',
    );
    enqueue(makeEvent('22222222-2222-4222-8222-222222222222'));
    await flush();

    resolveOldEvents(json({ accepted: 1, rejected: 0 }));
    await oldFlush;
    expect(bufferSize()).toBe(0);
    expect(eventRequests).toHaveLength(2);
    expect(eventRequests[0]?.key).toBe(KEY_A);
    expect(eventRequests[1]?.key).toBe(KEY_B);
    expect((eventRequests[0]?.body['events'] as Array<{ span_id: string }>)[0]?.span_id).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    expect((eventRequests[1]?.body['events'] as Array<{ span_id: string }>)[0]?.span_id).toBe(
      '22222222-2222-4222-8222-222222222222',
    );
  });

  it('preserves buffered state on same-identity reinit and validates before any destructive reset', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).endsWith('/pricing') ? json({ models: [] }) : json({ rules: [] }),
    );
    publicInit({ apiKey: KEY_A, endpoint: 'https://same.test', batchSize: 100 });
    enqueue(makeEvent('11111111-1111-4111-8111-111111111111'));
    publicInit({
      apiKey: KEY_A,
      endpoint: 'https://same.test',
      batchSize: 200,
      control: { mode: 'enforce' },
    });
    expect(bufferSize()).toBe(1);

    expect(() =>
      publicInit({
        apiKey: KEY_B,
        endpoint: 'https://other.test',
        control: { mode: 'enforce', timeoutMs: 1 },
      }),
    ).toThrow();
    expect(bufferSize()).toBe(1);
  });

  it('clears tenant-owned accumulator and non-LLM policy state on identity change', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).endsWith('/pricing') ? json({ models: [] }) : json({ rules: [] }),
    );
    publicInit({
      apiKey: KEY_A,
      endpoint: 'https://same.test',
      nonLlm: {
        mode: 'policy',
        policy: {
          sources: [{ slug: 'old-source', status: 'tracked', matchers: ['old.tool'] }],
        },
      },
    });
    add(
      {
        rule_id: 'rule-old',
        scope: 'per_customer',
        customer_id: 'customer-old',
        period_start: '2026-07-14T00:00:00.000Z',
      },
      9,
    );
    expect(decideNonLlmTool(['old.tool']).kind).toBe('tracked');

    publicInit({ apiKey: KEY_B, endpoint: 'https://same.test' });
    expect(
      get({
        rule_id: 'rule-old',
        scope: 'per_customer',
        customer_id: 'customer-old',
        period_start: '2026-07-14T00:00:00.000Z',
      }).total_usd,
    ).toBe(0);
    expect(decideNonLlmTool(['old.tool']).kind).toBe('unknown');
  });

  it('retains registered clients and failover state only for the same SDK identity', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).endsWith('/pricing') ? json({ models: [] }) : json({ rules: [] }),
    );
    const oldClient = { tenant: 'old' };
    new Pylva({
      apiKey: KEY_A,
      endpoint: 'https://same.test',
      providers: { openai: oldClient },
    });
    recordOutcome(failoverConfig, false);
    expect(getRegisteredClient('openai')).toBe(oldClient);
    expect(isActive(failoverConfig)).toBe(true);

    publicInit({ apiKey: KEY_A, endpoint: 'https://same.test' });
    expect(getRegisteredClient('openai')).toBe(oldClient);
    expect(isActive(failoverConfig)).toBe(true);

    publicInit({ apiKey: KEY_B, endpoint: 'https://same.test' });
    expect(getRegisteredClient('openai')).toBeNull();
    expect(isActive(failoverConfig)).toBe(false);
  });

  it('fences deliberately late rules and pricing responses from the old identity', async () => {
    let resolveOldPricing!: (response: Response) => void;
    let resolveOldRules!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, request) => {
      const href = String(url);
      const key = new Headers(request?.headers).get('x-pylva-key');
      if (href.endsWith('/api/v1/pricing')) {
        if (key === KEY_A) {
          return new Promise<Response>((resolve) => {
            resolveOldPricing = resolve;
          });
        }
        return Promise.resolve(
          json({
            models: [{ provider: 'openai', model: 'new-model', input_per_1m: 2, output_per_1m: 4 }],
          }),
        );
      }
      if (href.endsWith('/api/v1/rules')) {
        if (key === KEY_A) {
          return new Promise<Response>((resolve) => {
            resolveOldRules = resolve;
          });
        }
        return Promise.resolve(json({ rules: [{ id: 'new-rule' }] }));
      }
      throw new Error(`unexpected URL ${href}`);
    });

    publicInit({ apiKey: KEY_A, endpoint: 'https://same.test' });
    const oldPricing = ensurePricingCache();
    const oldRules = ensureRulesCache();
    publicInit({ apiKey: KEY_B, endpoint: 'https://same.test' });
    await Promise.all([ensurePricingCache(), ensureRulesCache()]);

    resolveOldPricing(
      json({
        models: [{ provider: 'openai', model: 'old-model', input_per_1m: 99, output_per_1m: 99 }],
      }),
    );
    resolveOldRules(json({ rules: [{ id: 'old-rule' }] }));
    await Promise.all([oldPricing, oldRules]);

    expect(getPricing('openai', 'new-model')).toMatchObject({ input_per_1m: 2 });
    expect(getPricing('openai', 'old-model')).toBeUndefined();
    expect(getCachedRules()).toEqual([{ id: 'new-rule' }]);
  });

  it.each(['allow', 'deny'] as const)(
    'fences a late reservation response after public reinit under %s policy',
    async (onUnavailable) => {
      let resolveOldReservation!: (response: Response) => void;
      vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
        const href = String(url);
        if (href.endsWith('/api/v1/pricing')) return Promise.resolve(json({ models: [] }));
        if (href.endsWith('/api/v1/rules')) return Promise.resolve(json({ rules: [] }));
        if (href.endsWith('/api/v1/budget/capabilities')) {
          return Promise.resolve(json(capabilities));
        }
        if (href.endsWith('/api/v1/budget/reservations')) {
          return new Promise<Response>((resolve) => {
            // Deliberately ignore AbortSignal; the generation fence owns safety.
            resolveOldReservation = resolve;
          });
        }
        throw new Error(`unexpected URL ${href}`);
      });
      publicInit({
        apiKey: KEY_A,
        endpoint: 'https://same.test',
        control: { mode: 'enforce', onUnavailable },
      });
      const pending = reserveUsage({
        kind: 'llm',
        operationId: OPERATION_ID,
        customerId: 'customer-old',
        traceId: TRACE_ID,
        spanId: SPAN_ID,
        parentSpanId: null,
        provider: 'openai',
        model: 'gpt-4.1',
        estimatedInputTokens: 1,
        maxOutputTokens: 1,
      });
      await vi.waitFor(() => expect(resolveOldReservation).toBeTypeOf('function'));

      publicInit({ apiKey: KEY_B, endpoint: 'https://same.test' });
      resolveOldReservation(json(reserved));

      if (onUnavailable === 'allow') {
        await expect(pending).resolves.toMatchObject({
          decision: 'unavailable',
          allowed: false,
          controlReason: 'configuration_changed',
          retryable: true,
        });
      } else {
        await expect(pending).rejects.toMatchObject({
          name: 'PylvaControlUnavailableError',
          reason: 'configuration_changed',
          operation: 'reserveUsage',
          operationId: OPERATION_ID,
        });
      }
    },
  );

  it('fences a late lifecycle response after public reinit even under allow policy', async () => {
    let resolveOldCommit!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const href = String(url);
      if (href.endsWith('/api/v1/pricing')) return Promise.resolve(json({ models: [] }));
      if (href.endsWith('/api/v1/rules')) return Promise.resolve(json({ rules: [] }));
      if (href.endsWith(`/${RESERVATION_ID}/commit`)) {
        return new Promise<Response>((resolve) => {
          // Deliberately ignore AbortSignal; the generation fence owns safety.
          resolveOldCommit = resolve;
        });
      }
      throw new Error(`unexpected URL ${href}`);
    });
    publicInit({
      apiKey: KEY_A,
      endpoint: 'https://same.test',
      control: { mode: 'enforce', onUnavailable: 'allow' },
    });
    const pending = commitUsage({
      reservationId: RESERVATION_ID,
      kind: 'llm',
      status: 'success',
      latencyMs: 10,
      streamAborted: false,
      actualInputTokens: 1,
      actualOutputTokens: 1,
    });
    await vi.waitFor(() => expect(resolveOldCommit).toBeTypeOf('function'));

    publicInit({ apiKey: KEY_B, endpoint: 'https://same.test' });
    resolveOldCommit(json(committed));
    await expect(pending).rejects.toMatchObject({
      name: 'PylvaControlUnavailableError',
      reason: 'configuration_changed',
      operation: 'commitUsage',
      reservationId: RESERVATION_ID,
    });
  });
});
