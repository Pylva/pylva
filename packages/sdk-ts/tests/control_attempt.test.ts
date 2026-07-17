import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetConfigForTests, init } from '../src/core/config.js';
import { _resetControlClientForTests } from '../src/core/control_client.js';
import {
  currentControlledAttempt,
  executeControlledAttempt,
  type ExecuteControlledAttemptInput,
} from '../src/core/control_attempt.js';

const KEY = `pv_live_aabbccdd_${'a'.repeat(32)}`;
const SECOND_KEY = `pv_live_eeff0011_${'b'.repeat(32)}`;
const RESERVATION_ID = '44444444-4444-4444-8444-444444444444';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}

function installFetch(onReserve?: (body: Record<string, unknown>) => void) {
  let operationId = '';
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, request) => {
    const href = String(url);
    if (href.endsWith('/capabilities')) {
      return json({
        schema_version: '1.0',
        control_enabled: true,
        min_reservation_ttl_seconds: 30,
        default_reservation_ttl_seconds: 300,
        max_reservation_ttl_seconds: 3600,
        server_time: '2026-07-14T09:00:00.000Z',
      });
    }
    if (href.endsWith('/reservations')) {
      const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
      onReserve?.(body);
      operationId = String(body['operation_id']);
      return json({
        schema_version: '1.0',
        decision: 'reserved',
        allowed: true,
        decision_id: '55555555-5555-4555-8555-555555555555',
        operation_id: operationId,
        reservation_id: RESERVATION_ID,
        state: 'reserved',
        reserved_usd: '0.1',
        remaining_usd: '1',
        expires_at: '2026-07-14T09:00:30.000Z',
        warnings: [],
      });
    }
    if (href.endsWith('/extend')) {
      const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
      return json({
        schema_version: '1.0',
        state: 'reserved',
        reservation_id: RESERVATION_ID,
        operation_id: operationId,
        extension_id: body['extension_id'],
        expires_at: '2026-07-14T09:05:30.000Z',
        idempotent_replay: false,
      });
    }
    throw new Error(`unexpected ${href}`);
  });
}

function reset(): void {
  _resetControlClientForTests();
  _resetConfigForTests();
}

describe('controlled attempt lifecycle and correlation', () => {
  beforeEach(reset);
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    reset();
  });

  it('exposes exact correlation only during the real provider dispatch', async () => {
    installFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    let inside: ReturnType<typeof currentControlledAttempt>;
    const result = await executeControlledAttempt({
      provider: 'openai',
      model: 'gpt-test-2026-01-01',
      estimatedInputTokens: 10,
      maxOutputTokens: 20,
      dispatch: () => {
        inside = currentControlledAttempt();
        return 'provider-result';
      },
    });
    expect(result.value).toBe('provider-result');
    expect(inside).toMatchObject({
      operationId: result.attempt.operationId,
      reservationId: RESERVATION_ID,
      provider: 'openai',
      model: 'gpt-test-2026-01-01',
      ownsReservation: true,
      legacyTelemetryRequired: false,
    });
    expect(currentControlledAttempt()).toBeUndefined();
  });

  it('does not consume a provider-specific lazy thenable during dispatch', async () => {
    installFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const providerPromise = { then: vi.fn() };

    const result = await executeControlledAttempt({
      provider: 'openai',
      model: 'gpt-test-2026-01-01',
      estimatedInputTokens: 10,
      maxOutputTokens: 20,
      dispatch: () => providerPromise,
    });

    expect(result.value).toBe(providerPromise);
    expect(providerPromise.then).not.toHaveBeenCalled();
    expect(currentControlledAttempt()).toBeUndefined();
  });

  it('schedules the default heartbeat at one third of a short TTL and stops cleanly', async () => {
    const fetchSpy = installFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const result = await executeControlledAttempt({
      provider: 'openai',
      model: 'gpt-test-2026-01-01',
      estimatedInputTokens: 10,
      maxOutputTokens: 20,
      reservationTtlSeconds: 30,
      dispatch: () => 'provider-result',
    });
    vi.useFakeTimers();
    const stop = result.attempt.startHeartbeat();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/extend'))).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/extend'))).toBe(true);
    const count = fetchSpy.mock.calls.length;
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(count);
  });

  it('snapshots heartbeat options before the asynchronous reservation boundary', async () => {
    const input = {
      provider: 'openai',
      model: 'gpt-test-2026-01-01',
      estimatedInputTokens: 10,
      maxOutputTokens: 20,
      reservationTtlSeconds: 30,
      heartbeatIntervalMs: 5_000,
      heartbeatExtendBySeconds: 45,
      dispatch: () => 'provider-result',
    };
    const fetchSpy = installFetch(() => {
      input.heartbeatIntervalMs = 30_000;
      input.heartbeatExtendBySeconds = 1;
    });
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });

    const result = await executeControlledAttempt(input);
    vi.useFakeTimers();
    const stop = result.attempt.startHeartbeat();
    await vi.advanceTimersByTimeAsync(5_000);

    const extend = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/extend'));
    expect(extend).toBeDefined();
    expect(JSON.parse(String(extend?.[1]?.body))).toMatchObject({ extend_by_seconds: 45 });
    stop();
  });

  it('snapshots reservation, correlation, check, and dispatch inputs before awaiting reserve', async () => {
    let inside: ReturnType<typeof currentControlledAttempt>;
    let reserveBody: Record<string, unknown> | undefined;
    const originalCheck = vi.fn();
    const replacementCheck = vi.fn();
    const originalDispatch = vi.fn(() => {
      inside = currentControlledAttempt();
      return 'original-provider-result';
    });
    const replacementDispatch = vi.fn(() => 'mutated-provider-result');
    const input: ExecuteControlledAttemptInput<string> = {
      provider: 'openai',
      model: 'gpt-test-2026-01-01',
      estimatedInputTokens: 10,
      maxOutputTokens: 20,
      reservationTtlSeconds: 30,
      predispatchCheck: originalCheck,
      dispatch: originalDispatch,
    };
    installFetch((body) => {
      reserveBody = body;
      input.provider = 'anthropic';
      input.model = 'mutated-model';
      input.estimatedInputTokens = 999;
      input.maxOutputTokens = 888;
      input.reservationTtlSeconds = 300;
      input.predispatchCheck = replacementCheck;
      input.dispatch = replacementDispatch;
    });
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });

    const result = await executeControlledAttempt(input);

    expect(reserveBody).toMatchObject({
      provider: 'openai',
      model: 'gpt-test-2026-01-01',
      estimated_input_tokens: 10,
      max_output_tokens: 20,
      reservation_ttl_seconds: 30,
    });
    expect(result.value).toBe('original-provider-result');
    expect(originalCheck).toHaveBeenCalledOnce();
    expect(replacementCheck).not.toHaveBeenCalled();
    expect(originalDispatch).toHaveBeenCalledOnce();
    expect(replacementDispatch).not.toHaveBeenCalled();
    expect(inside).toMatchObject({
      provider: 'openai',
      model: 'gpt-test-2026-01-01',
    });
  });

  it('snapshots the synchronous dispatch-error observer before awaiting reserve', async () => {
    const providerError = new Error('provider dispatch failed');
    const originalObserver = vi.fn();
    const replacementObserver = vi.fn();
    const originalDispatch = vi.fn((): string => {
      throw providerError;
    });
    const replacementDispatch = vi.fn(() => 'mutated-provider-result');
    const input: ExecuteControlledAttemptInput<string> = {
      provider: 'openai',
      model: 'gpt-test-2026-01-01',
      estimatedInputTokens: 10,
      maxOutputTokens: 20,
      dispatchThrew: originalObserver,
      dispatch: originalDispatch,
    };
    installFetch(() => {
      input.dispatchThrew = replacementObserver;
      input.dispatch = replacementDispatch;
    });
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });

    await expect(executeControlledAttempt(input)).rejects.toBe(providerError);

    expect(originalDispatch).toHaveBeenCalledOnce();
    expect(replacementDispatch).not.toHaveBeenCalled();
    expect(originalObserver).toHaveBeenCalledOnce();
    expect(originalObserver.mock.calls[0]?.[0]).toBe(providerError);
    expect(replacementObserver).not.toHaveBeenCalled();
  });

  it('clears the heartbeat interval when its owning SDK identity becomes stale', async () => {
    const fetchSpy = installFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const result = await executeControlledAttempt({
      provider: 'openai',
      model: 'gpt-test-2026-01-01',
      estimatedInputTokens: 10,
      maxOutputTokens: 20,
      reservationTtlSeconds: 30,
      dispatch: () => 'provider-result',
    });
    vi.useFakeTimers();
    result.attempt.startHeartbeat();
    expect(vi.getTimerCount()).toBe(1);

    init({ apiKey: SECOND_KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/extend'))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a heartbeat interval that could miss expiry before reserve or dispatch', async () => {
    const fetchSpy = installFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const dispatch = vi.fn();
    await expect(
      executeControlledAttempt({
        provider: 'openai',
        model: 'gpt-test-2026-01-01',
        estimatedInputTokens: 10,
        maxOutputTokens: 20,
        reservationTtlSeconds: 30,
        heartbeatIntervalMs: 30_000,
        dispatch,
      }),
    ).rejects.toThrow('heartbeatIntervalMs');
    expect(dispatch).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
