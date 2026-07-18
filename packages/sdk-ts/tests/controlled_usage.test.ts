import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentControlledOperation } from '../src/core/control_correlation.js';
import { _resetConfigForTests, init } from '../src/core/config.js';
import * as controlClient from '../src/core/control_client.js';
import {
  _resetControlClientForTests,
  type ReservedUsageResult,
} from '../src/core/control_client.js';
import { controlledExactUsage, controlledUsage } from '../src/core/controlled_usage.js';
import { _resetTelemetryForTests, bufferSize } from '../src/core/telemetry.js';
import { PylvaControlUnavailableError } from '../src/errors/control.js';
import { reportUsage } from '../src/reporting/usage.js';
import { controlledTavilySearch } from '../src/adapters/tavily.js';

const KEY_A = `pv_live_aabbccdd_${'a'.repeat(32)}`;
const KEY_B = `pv_live_bbccddee_${'b'.repeat(32)}`;
const DECISION_ID = '55555555-5555-4555-8555-555555555555';
const RESERVATION_IDS = [
  '66666666-6666-4666-8666-666666666666',
  '77777777-7777-4777-8777-777777777777',
  '88888888-8888-4888-8888-888888888888',
];

const capabilities = {
  schema_version: '1.0',
  control_enabled: true,
  min_reservation_ttl_seconds: 30,
  default_reservation_ttl_seconds: 300,
  max_reservation_ttl_seconds: 3600,
  server_time: '2026-07-14T09:00:00.000Z',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type ReserveDecision = 'reserved' | 'bypassed' | 'unavailable' | 'denied';

class ControlHarness {
  reserveDecision: ReserveDecision = 'reserved';
  commitFails = false;
  extensionFails = false;
  reservationBodies: Array<Record<string, unknown>> = [];
  commitBodies: Array<Record<string, unknown>> = [];
  releaseBodies: Array<Record<string, unknown>> = [];
  extensionBodies: Array<Record<string, unknown>> = [];
  operationByReservation = new Map<string, string>();
  beforeReserveResponse: ((body: Record<string, unknown>) => void | Promise<void>) | undefined;

  readonly fetch = vi.fn(async (url: string | URL | Request, request?: RequestInit) => {
    const href = String(url);
    if (href.endsWith('/api/v1/budget/capabilities')) return json(capabilities);
    if (href.endsWith('/api/v1/budget/reservations')) {
      const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
      const reservationIndex = this.reservationBodies.push(body) - 1;
      if (this.beforeReserveResponse !== undefined) {
        await this.beforeReserveResponse(body);
      }
      const operationId = String(body['operation_id']);
      if (this.reserveDecision === 'bypassed') {
        return json({
          schema_version: '1.0',
          decision: 'bypassed',
          allowed: true,
          decision_id: DECISION_ID,
          operation_id: operationId,
          reason: 'shadow_would_deny',
          would_have_denied: true,
          warnings: [],
        });
      }
      if (this.reserveDecision === 'unavailable') {
        return json({
          schema_version: '1.0',
          decision: 'unavailable',
          allowed: false,
          decision_id: null,
          operation_id: operationId,
          reason: 'pricing_unavailable',
          retryable: false,
        });
      }
      if (this.reserveDecision === 'denied') {
        return json({
          schema_version: '1.0',
          decision: 'denied',
          allowed: false,
          decision_id: DECISION_ID,
          operation_id: operationId,
          state: 'refused',
          deciding_rule: {
            rule_id: '99999999-9999-4999-8999-999999999999',
            scope: 'pooled',
            customer_id: null,
            period: 'day',
            period_start: '2026-07-14T00:00:00.000Z',
            period_end: '2026-07-15T00:00:00.000Z',
          },
          committed_usd: '1',
          reserved_usd: '1',
          unresolved_usd: '0',
          requested_usd: '1',
          limit_usd: '1',
          remaining_usd: '0',
          warnings: [],
        });
      }
      const reservationId = RESERVATION_IDS[reservationIndex]!;
      this.operationByReservation.set(reservationId, operationId);
      return json({
        schema_version: '1.0',
        decision: 'reserved',
        allowed: true,
        decision_id: DECISION_ID,
        operation_id: operationId,
        reservation_id: reservationId,
        state: 'reserved',
        reserved_usd: '1',
        remaining_usd: '9',
        expires_at: '2026-07-14T09:05:00.000Z',
        warnings: [],
      });
    }

    const lifecycle = href.match(/\/reservations\/([^/]+)\/(commit|release|extend)$/);
    if (!lifecycle) throw new Error(`unexpected control URL ${href}`);
    const reservationId = lifecycle[1]!;
    const operationId = this.operationByReservation.get(reservationId)!;
    const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
    if (lifecycle[2] === 'commit') {
      this.commitBodies.push(body);
      if (this.commitFails) throw new Error('lost commit ACK with private details');
      const actual = String(body['actual_value']);
      const over = BigInt(actual) > 1n;
      return json({
        schema_version: '1.0',
        state: 'committed',
        reservation_id: reservationId,
        operation_id: operationId,
        reserved_usd: '1',
        actual_usd: actual,
        released_usd: over ? '0' : String(1 - Number(actual)),
        overage_usd: over ? String(Number(actual) - 1) : '0',
        budget_exceeded_after_commit: over,
        committed_at: '2026-07-14T09:01:00.000Z',
        idempotent_replay: false,
        late: false,
      });
    }
    if (lifecycle[2] === 'release') {
      this.releaseBodies.push(body);
      return json({
        schema_version: '1.0',
        state: 'released',
        reservation_id: reservationId,
        operation_id: operationId,
        released_usd: '1',
        released_at: '2026-07-14T09:01:00.000Z',
        idempotent_replay: false,
      });
    }
    this.extensionBodies.push(body);
    if (this.extensionFails) throw new Error('extension failed');
    return json({
      schema_version: '1.0',
      state: 'reserved',
      reservation_id: reservationId,
      operation_id: operationId,
      extension_id: body['extension_id'],
      expires_at: '2026-07-14T09:10:00.000Z',
      idempotent_replay: false,
    });
  });
}

function resetAll(): void {
  _resetControlClientForTests();
  _resetTelemetryForTests();
  _resetConfigForTests();
}

function configure(mode: 'legacy' | 'shadow' | 'enforce', onUnavailable: 'allow' | 'deny') {
  init({
    apiKey: KEY_A,
    endpoint: 'https://control.test',
    control: { mode, onUnavailable },
  });
}

describe('controlled non-LLM usage', () => {
  beforeEach(resetAll);
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetAll();
  });

  it('reserves content-free identity, commits exact over-bound actual, and retains provider value', async () => {
    const harness = new ControlHarness();
    vi.stubGlobal('fetch', harness.fetch);
    configure('enforce', 'deny');
    const secret = 'query and URL https://private.example?q=secret';
    const providerValue = { pages: 2, url: secret };

    const result = await controlledUsage({
      costSourceSlug: 'document-parser',
      toolName: 'Document Parser',
      metric: 'page',
      maximumValue: '1',
      customerId: 'customer_acme',
      invoke: async () => providerValue,
      extractActual: (value) => value.pages,
    });

    expect(result.value).toBe(providerValue);
    expect(result.control).toMatchObject({
      settlement: 'committed',
      actualValue: '2',
      maximumValue: '1',
      boundViolated: true,
      authoritativeOwnership: true,
      legacyTelemetryEmitted: false,
    });
    expect(harness.commitBodies[0]).toMatchObject({ kind: 'tool', actual_value: '2' });
    const controlPayload = JSON.stringify(harness.reservationBodies);
    expect(controlPayload).not.toContain(secret);
    expect(JSON.stringify(result.control)).not.toContain('private.example');
    expect(bufferSize()).toBe(0);
  });

  it('snapshots generic bounded identity and dispatch callbacks before delayed reserve', async () => {
    const harness = new ControlHarness();
    vi.stubGlobal('fetch', harness.fetch);
    configure('enforce', 'deny');
    const originalInvoke = vi.fn(async () => ({ pages: 1 }));
    const replacementInvoke = vi.fn(async () => ({ pages: 99 }));
    const input = {
      costSourceSlug: 'document-parser',
      toolName: 'Document Parser',
      metric: 'page',
      maximumValue: '1.000',
      customerId: 'customer_acme',
      invoke: originalInvoke,
      extractActual: (value: { pages: number }) => value.pages,
    };
    harness.beforeReserveResponse = async () => {
      input.costSourceSlug = 'mutated-source';
      input.toolName = 'Mutated Tool';
      input.metric = 'mutated';
      input.maximumValue = '99';
      input.invoke = replacementInvoke;
      input.extractActual = () => 99;
      await Promise.resolve();
    };

    const result = await controlledUsage(input);

    expect(originalInvoke).toHaveBeenCalledOnce();
    expect(replacementInvoke).not.toHaveBeenCalled();
    expect(harness.reservationBodies[0]).toMatchObject({
      cost_source_slug: 'document-parser',
      tool_name: 'Document Parser',
      metric: 'page',
      maximum_value: '1',
    });
    expect(harness.commitBodies[0]).toMatchObject({ actual_value: '1' });
    expect(result.control).toMatchObject({
      maximumValue: '1',
      actualValue: '1',
      settlement: 'committed',
    });
  });

  it('snapshots exact-usage quantity and invocation before delayed reserve', async () => {
    const harness = new ControlHarness();
    vi.stubGlobal('fetch', harness.fetch);
    configure('enforce', 'deny');
    const originalInvoke = vi.fn(async () => 'original');
    const replacementInvoke = vi.fn(async () => 'replacement');
    const input = {
      costSourceSlug: 'document-parser',
      toolName: 'Document Parser',
      metric: 'page',
      value: '1.000',
      customerId: 'customer_acme',
      invoke: originalInvoke,
    };
    harness.beforeReserveResponse = async () => {
      input.value = '99';
      input.invoke = replacementInvoke;
      await Promise.resolve();
    };

    const result = await controlledExactUsage(input);

    expect(originalInvoke).toHaveBeenCalledOnce();
    expect(replacementInvoke).not.toHaveBeenCalled();
    expect(harness.reservationBodies[0]).toMatchObject({ maximum_value: '1' });
    expect(harness.commitBodies[0]).toMatchObject({ actual_value: '1' });
    expect(result).toMatchObject({
      value: 'original',
      control: { maximumValue: '1', actualValue: '1', settlement: 'committed' },
    });
  });

  it('rejects hostile generic and exact top-level inputs without invoking descriptors or control', async () => {
    const harness = new ControlHarness();
    vi.stubGlobal('fetch', harness.fetch);
    configure('enforce', 'deny');
    const invoke = vi.fn(async () => ({ pages: 1 }));
    const base = {
      costSourceSlug: 'document-parser',
      toolName: 'Document Parser',
      metric: 'page',
      maximumValue: '1',
      customerId: 'customer_acme',
      invoke,
      extractActual: (value: { pages: number }) => value.pages,
    };
    let accessorCalls = 0;
    const accessor = { ...base } as Record<string, unknown>;
    delete accessor['maximumValue'];
    Object.defineProperty(accessor, 'maximumValue', {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return '1';
      },
    });
    const nonEnumerable = { ...base };
    Object.defineProperty(nonEnumerable, 'maximumValue', {
      enumerable: false,
      value: '1',
    });
    const symbolInput = { ...base } as Record<PropertyKey, unknown>;
    symbolInput[Symbol('hidden')] = true;
    const protoInput = Object.assign(Object.create(null) as Record<string, unknown>, base);
    Object.defineProperty(protoInput, '__proto__', { enumerable: true, value: {} });
    let proxyTrapCalls = 0;
    const proxyInput = new Proxy(
      { ...base },
      {
        ownKeys(target) {
          proxyTrapCalls += 1;
          return Reflect.ownKeys(target);
        },
      },
    );

    for (const input of [accessor, nonEnumerable, symbolInput, protoInput, proxyInput]) {
      await expect(
        controlledUsage(input as unknown as Parameters<typeof controlledUsage>[0]),
      ).rejects.toMatchObject({ name: 'PylvaControlValidationError' });
    }

    const exactAccessor = {
      costSourceSlug: 'document-parser',
      toolName: 'Document Parser',
      metric: 'page',
      customerId: 'customer_acme',
      invoke,
    } as Record<string, unknown>;
    Object.defineProperty(exactAccessor, 'value', {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return '1';
      },
    });
    await expect(
      controlledExactUsage(exactAccessor as unknown as Parameters<typeof controlledExactUsage>[0]),
    ).rejects.toMatchObject({ name: 'PylvaControlValidationError' });

    expect(accessorCalls).toBe(0);
    expect(proxyTrapCalls).toBe(0);
    expect(invoke).not.toHaveBeenCalled();
    expect(harness.fetch).not.toHaveBeenCalled();
  });

  it('implements legacy, shadow, enforce+allow, and enforce+deny mode semantics', async () => {
    const legacyHarness = new ControlHarness();
    vi.stubGlobal('fetch', legacyHarness.fetch);
    configure('legacy', 'deny');
    let calls = 0;
    const legacy = await controlledExactUsage({
      costSourceSlug: 'document-parser',
      toolName: 'Document Parser',
      metric: 'page',
      value: 1,
      customerId: 'customer_acme',
      invoke: () => ++calls,
    });
    expect(calls).toBe(1);
    expect(legacy.control).toMatchObject({ decision: 'bypassed', legacyTelemetryEmitted: true });
    expect(
      legacyHarness.fetch.mock.calls.filter(([url]) => String(url).includes('/api/v1/budget/')),
    ).toHaveLength(0);
    expect(bufferSize()).toBe(1);

    resetAll();
    const shadowHarness = new ControlHarness();
    shadowHarness.reserveDecision = 'bypassed';
    vi.stubGlobal('fetch', shadowHarness.fetch);
    configure('shadow', 'deny');
    const shadow = await controlledExactUsage({
      costSourceSlug: 'document-parser',
      toolName: 'Document Parser',
      metric: 'page',
      value: 1,
      customerId: 'customer_acme',
      invoke: () => ++calls,
    });
    expect(shadow.control).toMatchObject({
      decision: 'bypassed',
      decisionReason: 'shadow_would_deny',
      legacyTelemetryEmitted: true,
    });
    expect(bufferSize()).toBe(1);

    resetAll();
    const shadowUnavailable = new ControlHarness();
    shadowUnavailable.reserveDecision = 'unavailable';
    vi.stubGlobal('fetch', shadowUnavailable.fetch);
    configure('shadow', 'deny');
    const honestShadow = await controlledExactUsage({
      costSourceSlug: 'unknown-source',
      toolName: 'Unknown Tool',
      metric: 'call',
      value: 1,
      customerId: 'customer_acme',
      invoke: () => ++calls,
    });
    expect(honestShadow.control).toMatchObject({
      decision: 'unavailable',
      decisionReason: 'shadow_control_unavailable',
      legacyTelemetryEmitted: true,
    });

    resetAll();
    const allowHarness = new ControlHarness();
    allowHarness.reserveDecision = 'unavailable';
    vi.stubGlobal('fetch', allowHarness.fetch);
    configure('enforce', 'allow');
    const allowed = await controlledExactUsage({
      costSourceSlug: 'unknown-source',
      toolName: 'Unknown Tool',
      metric: 'call',
      value: 1,
      customerId: 'customer_acme',
      invoke: () => ++calls,
    });
    expect(allowed.control).toMatchObject({
      decision: 'unavailable',
      legacyTelemetryEmitted: true,
    });

    resetAll();
    const denyHarness = new ControlHarness();
    denyHarness.reserveDecision = 'unavailable';
    vi.stubGlobal('fetch', denyHarness.fetch);
    configure('enforce', 'deny');
    const beforeDeny = calls;
    await expect(
      controlledExactUsage({
        costSourceSlug: 'unknown-source',
        toolName: 'Unknown Tool',
        metric: 'call',
        value: 1,
        customerId: 'customer_acme',
        invoke: () => ++calls,
      }),
    ).rejects.toBeInstanceOf(PylvaControlUnavailableError);
    expect(calls).toBe(beforeDeny);
  });

  it('dispatches neither a generic controlled tool nor Tavily after authoritative denial', async () => {
    const harness = new ControlHarness();
    harness.reserveDecision = 'denied';
    vi.stubGlobal('fetch', harness.fetch);
    configure('enforce', 'deny');
    const genericInvoke = vi.fn(() => 'generic provider value');
    const tavilySearch = vi.fn(async () => ({ results: [], usage: { credits: 1 } }));

    await expect(
      controlledExactUsage({
        costSourceSlug: 'document-parser',
        toolName: 'Document Parser',
        metric: 'page',
        value: 1,
        customerId: 'customer_acme',
        invoke: genericInvoke,
      }),
    ).rejects.toMatchObject({ name: 'PylvaBudgetExceeded' });
    await expect(
      controlledTavilySearch(
        { search: tavilySearch },
        { query: 'private denied query', customerId: 'customer_acme' },
      ),
    ).rejects.toMatchObject({ name: 'PylvaBudgetExceeded' });

    expect(genericInvoke).not.toHaveBeenCalled();
    expect(tavilySearch).not.toHaveBeenCalled();
    expect(harness.reservationBodies).toHaveLength(2);
    expect(harness.commitBodies).toHaveLength(0);
    expect(harness.releaseBodies).toHaveLength(0);
  });

  it('leaves provider/extractor/commit ambiguity unresolved and never releases after dispatch', async () => {
    const harness = new ControlHarness();
    vi.stubGlobal('fetch', harness.fetch);
    configure('enforce', 'deny');
    const providerError = new Error('provider error with private URL');
    await expect(
      controlledUsage({
        costSourceSlug: 'document-parser',
        toolName: 'Document Parser',
        metric: 'page',
        maximumValue: 1,
        customerId: 'customer_acme',
        invoke: () => Promise.reject(providerError),
        extractActual: () => 1,
      }),
    ).rejects.toBe(providerError);
    expect(harness.releaseBodies).toHaveLength(0);
    expect(harness.commitBodies).toHaveLength(0);

    const providerValue = { ok: true };
    const extracted = await controlledUsage({
      costSourceSlug: 'document-parser',
      toolName: 'Document Parser',
      metric: 'page',
      maximumValue: 1,
      customerId: 'customer_acme',
      invoke: () => providerValue,
      extractActual: () => Promise.reject(new Error('secret extraction error')),
    });
    expect(extracted.value).toBe(providerValue);
    expect(extracted.control).toMatchObject({
      settlement: 'unresolved',
      issue: 'usage_extraction_failed',
    });

    harness.commitFails = true;
    const lostAck = await controlledExactUsage({
      costSourceSlug: 'document-parser',
      toolName: 'Document Parser',
      metric: 'page',
      value: 1,
      customerId: 'customer_acme',
      invoke: () => providerValue,
    });
    expect(lostAck.value).toBe(providerValue);
    expect(lostAck.control).toMatchObject({
      settlement: 'unresolved',
      issue: 'commit_failed',
      authoritativeOwnership: true,
      legacyTelemetryEmitted: false,
    });
    expect(JSON.stringify(lostAck.control)).not.toContain('private');
    expect(bufferSize()).toBe(0);
  });

  it('releases a definite pre-dispatch failure and calls the provider zero times', async () => {
    const harness = new ControlHarness();
    vi.stubGlobal('fetch', harness.fetch);
    configure('enforce', 'deny');
    let calls = 0;
    const preparationError = new Error('local preparation failed');

    await expect(
      controlledExactUsage({
        costSourceSlug: 'document-parser',
        toolName: 'Document Parser',
        metric: 'page',
        value: 1,
        customerId: 'customer_acme',
        beforeInvoke: () => {
          throw preparationError;
        },
        invoke: () => ++calls,
      }),
    ).rejects.toBe(preparationError);
    expect(calls).toBe(0);
    expect(harness.releaseBodies).toEqual([
      { schema_version: '1.0', reason: 'provider_not_called' },
    ]);
    expect(harness.commitBodies).toHaveLength(0);
  });

  it('extends long calls, surfaces extension failure, and stops heartbeats on completion', async () => {
    const harness = new ControlHarness();
    vi.stubGlobal('fetch', harness.fetch);
    configure('enforce', 'deny');

    const result = await controlledExactUsage({
      costSourceSlug: 'document-parser',
      toolName: 'Document Parser',
      metric: 'page',
      value: 1,
      customerId: 'customer_acme',
      heartbeatIntervalMs: 5,
      invoke: () => new Promise((resolve) => setTimeout(() => resolve('ok'), 25)),
    });
    expect(result.control.settlement).toBe('committed');
    expect(harness.extensionBodies.length).toBeGreaterThan(0);
    expect(new Set(harness.extensionBodies.map((body) => body['extension_id'])).size).toBe(
      harness.extensionBodies.length,
    );
    const extensionsAtTerminal = harness.extensionBodies.length;
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(harness.extensionBodies).toHaveLength(extensionsAtTerminal);

    harness.extensionFails = true;
    const failed = await controlledExactUsage({
      costSourceSlug: 'document-parser',
      toolName: 'Document Parser',
      metric: 'page',
      value: 1,
      customerId: 'customer_acme',
      heartbeatIntervalMs: 5,
      invoke: () => new Promise((resolve) => setTimeout(() => resolve('ok'), 25)),
    });
    expect(failed.control).toMatchObject({ settlement: 'committed', issue: 'extension_failed' });
  });

  it('fences forged receipts and identity reinit', async () => {
    const harness = new ControlHarness();
    vi.stubGlobal('fetch', harness.fetch);
    configure('enforce', 'deny');

    const forged = {
      schemaVersion: '1.0',
      decision: 'reserved',
      allowed: true,
      decisionId: DECISION_ID,
      operationId: '11111111-1111-4111-8111-111111111111',
      reservationId: RESERVATION_IDS[0]!,
      state: 'reserved',
      reservedUsd: '1',
      remainingUsd: '9',
      expiresAt: '2026-07-14T09:05:00.000Z',
      warnings: [],
    } satisfies ReservedUsageResult;
    const reserveSpy = vi.spyOn(controlClient, 'reserveUsage').mockResolvedValue(forged);
    let forgedCalls = 0;
    await expect(
      controlledExactUsage({
        costSourceSlug: 'document-parser',
        toolName: 'Document Parser',
        metric: 'page',
        value: 1,
        customerId: 'customer_acme',
        invoke: () => ++forgedCalls,
      }),
    ).rejects.toMatchObject({ name: 'PylvaControlValidationError' });
    expect(forgedCalls).toBe(0);
    reserveSpy.mockRestore();
    _resetControlClientForTests();

    const reinitResult = await controlledExactUsage({
      costSourceSlug: 'document-parser',
      toolName: 'Document Parser',
      metric: 'page',
      value: 1,
      customerId: 'customer_acme',
      invoke: () => {
        init({
          apiKey: KEY_B,
          endpoint: 'https://other.test',
          control: { mode: 'enforce', onUnavailable: 'deny' },
        });
        return 'provider value';
      },
    });
    expect(reinitResult.control).toMatchObject({
      settlement: 'unresolved',
      issue: 'configuration_changed',
      legacyTelemetryEmitted: false,
    });
    expect(harness.commitBodies).toHaveLength(0);
  });

  it('keeps the lease alive during async extraction and fences extractor reinitialization', async () => {
    const harness = new ControlHarness();
    vi.stubGlobal('fetch', harness.fetch);
    configure('enforce', 'deny');

    const result = await controlledUsage({
      costSourceSlug: 'document-parser',
      toolName: 'Document Parser',
      metric: 'page',
      maximumValue: 1,
      customerId: 'customer_acme',
      heartbeatIntervalMs: 5,
      invoke: () => ({ pages: 1 }),
      extractActual: async (value) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        init({
          apiKey: KEY_B,
          endpoint: 'https://other.test',
          control: { mode: 'enforce', onUnavailable: 'deny' },
        });
        return value.pages;
      },
    });

    expect(harness.extensionBodies.length).toBeGreaterThan(0);
    expect(harness.commitBodies).toHaveLength(0);
    expect(result.control).toMatchObject({
      settlement: 'unresolved',
      issue: 'configuration_changed',
      actualValue: null,
      legacyTelemetryEmitted: false,
    });
  });

  it('isolates exact correlation across concurrent identical tool calls', async () => {
    const harness = new ControlHarness();
    vi.stubGlobal('fetch', harness.fetch);
    configure('enforce', 'deny');
    const seen: Array<ReturnType<typeof currentControlledOperation>> = [];

    const call = () =>
      controlledExactUsage({
        costSourceSlug: 'document-parser',
        toolName: 'Document Parser',
        metric: 'page',
        value: 1,
        customerId: 'same_customer',
        invoke: async () => {
          const active = currentControlledOperation();
          seen.push(active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          expect(currentControlledOperation()?.operationId).toBe(active?.operationId);
          return 'ok';
        },
      });

    const results = await Promise.all([call(), call()]);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({
      kind: 'tool',
      ownsReservation: true,
      legacyTelemetryRequired: false,
    });
    expect(seen[0]?.operationId).not.toBe(seen[1]?.operationId);
    expect(seen[0]?.reservationId).not.toBe(seen[1]?.reservationId);
    expect(results.every((result) => result.control.settlement === 'committed')).toBe(true);
    expect(currentControlledOperation()).toBeUndefined();
  });

  it('lets exact tool correlation suppress callback telemetry while helper emits one fallback', async () => {
    const harness = new ControlHarness();
    harness.reserveDecision = 'bypassed';
    vi.stubGlobal('fetch', harness.fetch);
    configure('shadow', 'deny');

    const result = await controlledExactUsage({
      costSourceSlug: 'document-parser',
      toolName: 'Document Parser',
      metric: 'page',
      value: 1,
      customerId: 'customer_acme',
      invoke: () => {
        const active = currentControlledOperation();
        if (active?.kind !== 'tool') {
          reportUsage({
            tool: 'Document Parser',
            metric: 'page',
            value: 1,
            customer_id: 'customer_acme',
          });
        }
        expect(active).toMatchObject({
          kind: 'tool',
          ownsReservation: false,
          legacyTelemetryRequired: true,
        });
        return 'ok';
      },
    });

    expect(result.control.legacyTelemetryEmitted).toBe(true);
    expect(bufferSize()).toBe(1);
  });

  it('controls Tavily basic search as tavily-search/credit without exposing the query', async () => {
    const harness = new ControlHarness();
    vi.stubGlobal('fetch', harness.fetch);
    configure('enforce', 'deny');
    const query = 'private launch research https://secret.example';
    const calls: Array<[string, Readonly<Record<string, unknown>> | undefined]> = [];
    const client = {
      async search(value: string, options?: Readonly<Record<string, unknown>>) {
        calls.push([value, options]);
        return { results: [], usage: { credits: 1 } };
      },
    };

    const result = await controlledTavilySearch(client, {
      query,
      customerId: 'customer_acme',
      searchOptions: { maxResults: 3, includeUsage: false },
    });

    expect(calls).toEqual([
      [
        query,
        {
          maxResults: 3,
          includeUsage: true,
          searchDepth: 'basic',
          autoParameters: false,
        },
      ],
    ]);
    expect(harness.reservationBodies[0]).toMatchObject({
      cost_source_slug: 'tavily-search',
      tool_name: 'Tavily Search',
      metric: 'credit',
      maximum_value: '1',
    });
    expect(JSON.stringify(harness.reservationBodies[0])).not.toContain(query);
    expect(harness.commitBodies[0]).toMatchObject({ actual_value: '1' });
    expect(result.control).toMatchObject({ settlement: 'committed', boundViolated: false });
  });

  it('detaches nested Tavily options and binds transport before delayed reserve', async () => {
    const harness = new ControlHarness();
    vi.stubGlobal('fetch', harness.fetch);
    configure('enforce', 'deny');
    const originalCalls: Array<[string, Readonly<Record<string, unknown>> | undefined]> = [];
    const replacementSearch = vi.fn(async () => ({ usage: { credits: 2 } }));
    const client = {
      async search(query: string, options?: Readonly<Record<string, unknown>>) {
        originalCalls.push([query, options]);
        return { usage: { credits: 1 } };
      },
    };
    const callerOptions = { includeDomains: ['original.example'] };
    const input = {
      query: 'original query',
      customerId: 'customer_acme',
      searchOptions: callerOptions,
    };
    harness.beforeReserveResponse = async () => {
      callerOptions.includeDomains.push('mutated.example');
      input.query = 'mutated query';
      client.search = replacementSearch;
      await Promise.resolve();
    };

    const result = await controlledTavilySearch(client, input);

    expect(replacementSearch).not.toHaveBeenCalled();
    expect(originalCalls).toEqual([
      [
        'original query',
        {
          includeDomains: ['original.example'],
          searchDepth: 'basic',
          autoParameters: false,
          includeUsage: true,
        },
      ],
    ]);
    expect(harness.commitBodies[0]).toMatchObject({ actual_value: '1' });
    expect(result.control).toMatchObject({ settlement: 'committed', actualValue: '1' });
  });

  it('refuses an undetachable Tavily option before control or provider dispatch', async () => {
    const harness = new ControlHarness();
    vi.stubGlobal('fetch', harness.fetch);
    configure('enforce', 'deny');
    const search = vi.fn(async () => ({ usage: { credits: 1 } }));

    await expect(
      controlledTavilySearch(
        { search },
        {
          query: 'private',
          customerId: 'customer_acme',
          searchOptions: { opaque: () => 'not cloneable' },
        },
      ),
    ).rejects.toMatchObject({ name: 'PylvaControlValidationError' });

    expect(search).not.toHaveBeenCalled();
    expect(harness.reservationBodies).toHaveLength(0);
    expect(harness.fetch).not.toHaveBeenCalled();
  });

  it('accepts a bounded null-prototype Tavily option tree and keeps its snapshot isolated', async () => {
    const harness = new ControlHarness();
    vi.stubGlobal('fetch', harness.fetch);
    configure('enforce', 'deny');
    const nested = Object.create(null) as Record<string, unknown>;
    nested['domains'] = ['safe.example'];
    const options = Object.create(null) as Record<string, unknown>;
    options['maxResults'] = 3;
    options['nested'] = nested;
    const input = Object.create(null) as Record<string, unknown>;
    input['query'] = 'private';
    input['customerId'] = 'customer_acme';
    input['searchOptions'] = options;
    let seenOptions: Readonly<Record<string, unknown>> | undefined;

    const result = await controlledTavilySearch(
      {
        async search(_query, received) {
          seenOptions = received;
          return { usage: { credits: 1 } };
        },
      },
      input as unknown as Parameters<typeof controlledTavilySearch>[1],
    );

    expect(result.control.settlement).toBe('committed');
    expect(Object.getPrototypeOf(seenOptions)).toBeNull();
    expect(Object.getPrototypeOf(seenOptions?.['nested'])).toBeNull();
    expect(seenOptions).toMatchObject({
      maxResults: 3,
      nested: { domains: ['safe.example'] },
      searchDepth: 'basic',
      autoParameters: false,
      includeUsage: true,
    });
  });

  it('rejects hostile, shared, sparse, built-in, and oversized Tavily option graphs', async () => {
    const harness = new ControlHarness();
    vi.stubGlobal('fetch', harness.fetch);
    configure('enforce', 'deny');
    const search = vi.fn(async () => ({ usage: { credits: 1 } }));
    let accessorCalls = 0;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return 'unsafe';
      },
    });
    const nonEnumerable = { visible: true } as Record<string, unknown>;
    Object.defineProperty(nonEnumerable, 'hidden', { enumerable: false, value: true });
    const symbolKey = { visible: true } as Record<PropertyKey, unknown>;
    symbolKey[Symbol('hidden')] = true;
    const ownProto = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(ownProto, '__proto__', { enumerable: true, value: { polluted: true } });
    const nestedProto = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(nestedProto, '__proto__', {
      enumerable: true,
      value: { polluted: true },
    });
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    const sharedChild = { value: 'shared' };
    const shared = { first: sharedChild, second: sharedChild };
    const sparse = new Array(2);
    sparse[0] = 'present';
    class CustomArray extends Array<unknown> {}
    class CustomRecord {
      value = 'custom';
    }
    const tooManyKeys = Object.fromEntries(
      Array.from({ length: 129 }, (_value, index) => [`key${index}`, index]),
    );
    let tooDeep: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 10; depth += 1) tooDeep = { child: tooDeep };
    const tooManyNodes = {
      groups: Array.from({ length: 5 }, () => Array.from({ length: 256 }, () => 1)),
    };
    const proxyTarget = { value: 'hidden' };
    let proxyTrapCalls = 0;
    const proxied = new Proxy(proxyTarget, {
      ownKeys(target) {
        proxyTrapCalls += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, key) {
        proxyTrapCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const hostile: Array<readonly [string, Readonly<Record<string, unknown>>]> = [
      ['accessor', { nested: accessor }],
      ['non-enumerable', nonEnumerable],
      ['symbol', symbolKey as Readonly<Record<string, unknown>>],
      ['top-level __proto__', ownProto],
      ['nested __proto__', { nested: nestedProto }],
      ['cycle', cycle],
      ['shared graph', shared],
      ['sparse array', { values: sparse }],
      ['custom array', { values: new CustomArray('value') }],
      ['custom class', { nested: new CustomRecord() }],
      ['Date', { nested: new Date() }],
      ['Map', { nested: new Map([['key', 'value']]) }],
      ['proxy', { nested: proxied }],
      ['too many keys', tooManyKeys],
      ['array too long', { values: Array.from({ length: 257 }, () => 1) }],
      ['string too long', { value: 'x'.repeat(16_385) }],
      ['too deep', tooDeep],
      ['too many nodes', tooManyNodes],
    ];

    for (const [label, searchOptions] of hostile) {
      await expect(
        controlledTavilySearch(
          { search },
          { query: 'private', customerId: 'customer_acme', searchOptions },
        ),
        label,
      ).rejects.toMatchObject({ name: 'PylvaControlValidationError' });
    }
    for (const input of [
      { query: 'private', customerId: 'customer_acme', searchOptions: null },
      { query: 'private', customerId: 'customer_acme', searchDepth: null },
      { query: 'private', customerId: 'customer_acme', autoParameters: null },
    ]) {
      await expect(
        controlledTavilySearch(
          { search },
          input as unknown as Parameters<typeof controlledTavilySearch>[1],
        ),
      ).rejects.toMatchObject({ name: 'PylvaControlValidationError' });
    }

    expect(accessorCalls).toBe(0);
    expect(proxyTrapCalls).toBe(0);
    expect(search).not.toHaveBeenCalled();
    expect(harness.reservationBodies).toHaveLength(0);
    expect(harness.fetch).not.toHaveBeenCalled();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('rejects accessor, proxy, non-enumerable, symbol, __proto__, and hostile client inputs', async () => {
    const harness = new ControlHarness();
    vi.stubGlobal('fetch', harness.fetch);
    configure('enforce', 'deny');
    const search = vi.fn(async () => ({ usage: { credits: 1 } }));
    let accessorCalls = 0;
    const accessorInput = { customerId: 'customer_acme' } as Record<string, unknown>;
    Object.defineProperty(accessorInput, 'query', {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return 'private';
      },
    });
    const nonEnumerableInput = { customerId: 'customer_acme' } as Record<string, unknown>;
    Object.defineProperty(nonEnumerableInput, 'query', {
      enumerable: false,
      value: 'private',
    });
    const symbolInput = { query: 'private', customerId: 'customer_acme' } as Record<
      PropertyKey,
      unknown
    >;
    symbolInput[Symbol('hidden')] = true;
    const protoInput = Object.create(null) as Record<string, unknown>;
    protoInput['query'] = 'private';
    protoInput['customerId'] = 'customer_acme';
    Object.defineProperty(protoInput, '__proto__', { enumerable: true, value: {} });
    let inputProxyTrapCalls = 0;
    const proxyInput = new Proxy(
      { query: 'private', customerId: 'customer_acme' },
      {
        ownKeys(target) {
          inputProxyTrapCalls += 1;
          return Reflect.ownKeys(target);
        },
      },
    );

    for (const input of [accessorInput, nonEnumerableInput, symbolInput, protoInput, proxyInput]) {
      await expect(
        controlledTavilySearch(
          { search },
          input as unknown as Parameters<typeof controlledTavilySearch>[1],
        ),
      ).rejects.toMatchObject({ name: 'PylvaControlValidationError' });
    }

    const accessorClient = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessorClient, 'search', {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return search;
      },
    });
    const proxyClient = new Proxy(
      { search },
      {
        get(target, key, receiver) {
          inputProxyTrapCalls += 1;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    const proxySearch = new Proxy(search, {
      apply(target, thisArg, argumentsList) {
        inputProxyTrapCalls += 1;
        return Reflect.apply(target, thisArg, argumentsList);
      },
    });
    for (const client of [accessorClient, proxyClient, { search: proxySearch }]) {
      await expect(
        controlledTavilySearch(client as unknown as Parameters<typeof controlledTavilySearch>[0], {
          query: 'private',
          customerId: 'customer_acme',
        }),
      ).rejects.toMatchObject({ name: 'PylvaControlValidationError' });
    }

    expect(accessorCalls).toBe(0);
    expect(inputProxyTrapCalls).toBe(0);
    expect(search).not.toHaveBeenCalled();
    expect(harness.reservationBodies).toHaveLength(0);
    expect(harness.fetch).not.toHaveBeenCalled();
  });

  it('commits unexpected Tavily two-credit usage and refuses advanced/auto before invocation', async () => {
    const harness = new ControlHarness();
    vi.stubGlobal('fetch', harness.fetch);
    configure('enforce', 'deny');
    let calls = 0;
    const client = {
      async search() {
        calls += 1;
        return { usage: { credits: 2 } };
      },
    };
    const result = await controlledTavilySearch(client, {
      query: 'private',
      customerId: 'customer_acme',
    });
    expect(result.control).toMatchObject({
      settlement: 'committed',
      actualValue: '2',
      boundViolated: true,
    });
    expect(harness.commitBodies[0]).toMatchObject({ actual_value: '2' });

    const before = calls;
    await expect(
      controlledTavilySearch(client, {
        query: 'private',
        customerId: 'customer_acme',
        searchDepth: 'advanced',
      }),
    ).rejects.toMatchObject({ name: 'PylvaControlValidationError' });
    await expect(
      controlledTavilySearch(client, {
        query: 'private',
        customerId: 'customer_acme',
        autoParameters: true,
      }),
    ).rejects.toMatchObject({ name: 'PylvaControlValidationError' });
    for (const searchOptions of [
      { search_depth: 'advanced' },
      { auto_parameters: true },
      { include_usage: false },
    ]) {
      await expect(
        controlledTavilySearch(client, {
          query: 'private',
          customerId: 'customer_acme',
          searchOptions,
        }),
      ).rejects.toMatchObject({ name: 'PylvaControlValidationError' });
    }
    expect(calls).toBe(before);
    expect(harness.reservationBodies).toHaveLength(1);
  });

  it.each([undefined, 0, 1.5])(
    'returns Tavily provider value but leaves missing, zero, or fractional credit evidence unresolved',
    async (credits) => {
      const harness = new ControlHarness();
      vi.stubGlobal('fetch', harness.fetch);
      configure('enforce', 'deny');
      const providerValue = { results: ['kept'], usage: { credits } };
      const result = await controlledTavilySearch(
        { search: async () => providerValue },
        { query: 'private', customerId: 'customer_acme' },
      );
      expect(result.value).toBe(providerValue);
      expect(result.control).toMatchObject({
        settlement: 'unresolved',
        issue: 'usage_extraction_failed',
      });
      expect(harness.commitBodies).toHaveLength(0);
    },
  );
});
