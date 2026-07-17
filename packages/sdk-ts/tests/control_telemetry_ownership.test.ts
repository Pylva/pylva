import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetConfigForTests, init } from '../src/core/config.js';
import {
  _resetControlClientForTests,
  commitUsage,
  reserveUsage,
  shouldSuppressLegacyTelemetry,
  type ReserveUsageInput,
  type ReserveUsageResult,
  type ReservedUsageResult,
} from '../src/core/control_client.js';
import { _resetTelemetryForTests, bufferSize } from '../src/core/telemetry.js';

const KEY_A = `pv_live_aabbccdd_${'a'.repeat(32)}`;
const KEY_B = `pv_live_bbccddee_${'b'.repeat(32)}`;
const OPERATION_A = '11111111-1111-4111-8111-111111111111';
const OPERATION_B = '22222222-2222-4222-8222-222222222222';
const TRACE_ID = '33333333-3333-4333-8333-333333333333';
const SPAN_A = '44444444-4444-4444-8444-444444444444';
const SPAN_B = '55555555-5555-4555-8555-555555555555';
const RESERVATION_A = '66666666-6666-4666-8666-666666666666';
const RESERVATION_B = '77777777-7777-4777-8777-777777777777';
const DECISION_ID = '88888888-8888-4888-8888-888888888888';

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

function llmInput(
  operationId = OPERATION_A,
  spanId = SPAN_A,
  parentSpanId: string | null = null,
): ReserveUsageInput {
  return {
    kind: 'llm',
    operationId,
    customerId: 'customer_acme',
    traceId: TRACE_ID,
    spanId,
    parentSpanId,
    provider: 'openai',
    model: 'gpt-4.1',
    estimatedInputTokens: 10,
    maxOutputTokens: 20,
  };
}

function reserved(operationId = OPERATION_A, reservationId = RESERVATION_A) {
  return {
    schema_version: '1.0',
    decision: 'reserved',
    allowed: true,
    decision_id: DECISION_ID,
    operation_id: operationId,
    reservation_id: reservationId,
    state: 'reserved',
    reserved_usd: '0.125',
    remaining_usd: '9.875',
    expires_at: '2026-07-14T09:05:00.000Z',
    warnings: [],
  };
}

function ownership(result: unknown, operationId = OPERATION_A, reservationId = RESERVATION_A) {
  return shouldSuppressLegacyTelemetry(result, { operationId, reservationId });
}

function resetAll(): void {
  _resetControlClientForTests();
  _resetTelemetryForTests();
  _resetConfigForTests();
}

describe('controlled reservation telemetry ownership', () => {
  beforeEach(resetAll);
  afterEach(() => {
    vi.restoreAllMocks();
    resetAll();
  });

  it('attaches an exact private proof only to the correlated reserved result', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(capabilities))
      .mockResolvedValueOnce(json(reserved()));
    init({
      apiKey: KEY_A,
      endpoint: 'https://control.test',
      control: { mode: 'enforce' },
    });
    const result = await reserveUsage(llmInput());

    expect(result.decision).toBe('reserved');
    expect(bufferSize()).toBe(0);
    expect(ownership(result)).toBe(true);
    expect(ownership({ ...result })).toBe(false);
    expect(ownership(result, OPERATION_B, RESERVATION_A)).toBe(false);
    expect(ownership(result, OPERATION_A, RESERVATION_B)).toBe(false);

    (result as ReservedUsageResult).operationId = OPERATION_B;
    expect(ownership(result)).toBe(false);
  });

  it('keeps reservation ownership through a lost commit acknowledgement and malformed commit response', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(capabilities))
      .mockResolvedValueOnce(json(reserved()))
      .mockRejectedValueOnce(new Error('commit acknowledgement lost'))
      .mockResolvedValueOnce(json({ schema_version: '1.0', state: 'committed' }));
    init({
      apiKey: KEY_A,
      endpoint: 'https://control.test',
      control: { mode: 'enforce' },
    });
    const reservation = await reserveUsage(llmInput());
    expect(ownership(reservation)).toBe(true);

    const commitInput = {
      reservationId: RESERVATION_A,
      kind: 'llm' as const,
      status: 'success' as const,
      latencyMs: 10,
      streamAborted: false,
      actualInputTokens: 8,
      actualOutputTokens: 4,
    };
    await expect(commitUsage(commitInput)).rejects.toMatchObject({
      name: 'PylvaControlUnavailableError',
      reason: 'network_error',
    });
    expect(ownership(reservation)).toBe(true);

    await expect(commitUsage(commitInput)).rejects.toMatchObject({
      name: 'PylvaControlUnavailableError',
      reason: 'invalid_response',
    });
    expect(ownership(reservation)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(bufferSize()).toBe(0);
  });

  it('never grants ownership to bypassed, unavailable, forged, or commit-only values', async () => {
    const bypassed = {
      schema_version: '1.0',
      decision: 'bypassed',
      allowed: true,
      decision_id: DECISION_ID,
      operation_id: OPERATION_A,
      reason: 'no_applicable_budget',
      would_have_denied: null,
      warnings: [],
    };
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(capabilities))
      .mockResolvedValueOnce(json(bypassed));
    init({ apiKey: KEY_A, control: { mode: 'enforce', onUnavailable: 'allow' } });
    const result = await reserveUsage(llmInput());
    expect(result.decision).toBe('bypassed');
    expect(ownership(result)).toBe(false);
    expect(
      ownership({
        decision: 'reserved',
        operationId: OPERATION_A,
        reservationId: RESERVATION_A,
      }),
    ).toBe(false);

    const commitShape = {
      state: 'committed',
      operationId: OPERATION_A,
      reservationId: RESERVATION_A,
    };
    expect(ownership(commitShape)).toBe(false);

    _resetControlClientForTests();
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 404 }));
    init({ apiKey: KEY_A, control: { mode: 'enforce', onUnavailable: 'allow' } });
    const unavailable: ReserveUsageResult = await reserveUsage(llmInput());
    expect(unavailable.decision).toBe('unavailable');
    expect(ownership(unavailable)).toBe(false);
  });

  it('invalidates ownership on key or endpoint reinit and never revives it', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(capabilities))
      .mockResolvedValueOnce(json(reserved()));
    init({ apiKey: KEY_A, endpoint: 'https://one.test', control: { mode: 'enforce' } });
    const result = await reserveUsage(llmInput());
    expect(ownership(result)).toBe(true);

    init({ apiKey: KEY_B, endpoint: 'https://one.test', control: { mode: 'enforce' } });
    expect(ownership(result)).toBe(false);
    init({ apiKey: KEY_A, endpoint: 'https://one.test', control: { mode: 'enforce' } });
    expect(ownership(result)).toBe(false);
  });

  it('keeps concurrent nested operations isolated by exact operation and reservation IDs', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, request) => {
      const href = String(url);
      if (href.endsWith('/api/v1/budget/capabilities')) return json(capabilities);
      if (href.endsWith('/api/v1/budget/reservations')) {
        const body = JSON.parse(String(request?.body)) as { operation_id: string };
        return body.operation_id === OPERATION_A
          ? json(reserved(OPERATION_A, RESERVATION_A))
          : json(reserved(OPERATION_B, RESERVATION_B));
      }
      throw new Error(`unexpected URL ${href}`);
    });
    init({ apiKey: KEY_A, endpoint: 'https://control.test', control: { mode: 'enforce' } });

    const [outer, nested] = await Promise.all([
      reserveUsage(llmInput(OPERATION_A, SPAN_A)),
      reserveUsage(llmInput(OPERATION_B, SPAN_B, SPAN_A)),
    ]);
    expect(ownership(outer, OPERATION_A, RESERVATION_A)).toBe(true);
    expect(ownership(nested, OPERATION_B, RESERVATION_B)).toBe(true);
    expect(ownership(outer, OPERATION_B, RESERVATION_B)).toBe(false);
    expect(ownership(nested, OPERATION_A, RESERVATION_A)).toBe(false);
  });
});
