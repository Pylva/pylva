import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetConfigForTests, init } from '../src/core/config.js';
import {
  _resetControlClientForTests,
  commitUsage,
  extendUsage,
  releaseUsage,
} from '../src/core/control_client.js';
import { PylvaControlApiError, PylvaControlValidationError } from '../src/errors/control.js';

const KEY = `pv_live_aabbccdd_${'a'.repeat(32)}`;
const RESERVATION_ID = '44444444-4444-4444-8444-444444444444';
const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const EXTENSION_ID = '77777777-7777-4777-8777-777777777777';

const commitResponse = {
  schema_version: '1.0',
  state: 'committed',
  reservation_id: RESERVATION_ID,
  operation_id: OPERATION_ID,
  reserved_usd: '5',
  actual_usd: '3.25',
  released_usd: '1.75',
  overage_usd: '0',
  budget_exceeded_after_commit: false,
  committed_at: '2026-07-14T09:01:00.000Z',
  idempotent_replay: false,
  late: false,
};

const releaseResponse = {
  schema_version: '1.0',
  state: 'released',
  reservation_id: RESERVATION_ID,
  operation_id: OPERATION_ID,
  released_usd: '5',
  released_at: '2026-07-14T09:01:00.000Z',
  idempotent_replay: false,
};

const extendResponse = {
  schema_version: '1.0',
  state: 'reserved',
  reservation_id: RESERVATION_ID,
  operation_id: OPERATION_ID,
  extension_id: EXTENSION_ID,
  expires_at: '2026-07-14T09:10:00.000Z',
  idempotent_replay: false,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('authoritative reservation lifecycle client', () => {
  beforeEach(() => {
    _resetControlClientForTests();
    _resetConfigForTests();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'legacy' } });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    _resetControlClientForTests();
    _resetConfigForTests();
  });

  it('commits an LLM reservation in legacy mode and maps exact settlement fields', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(json({ ...commitResponse, additive_future_field: true }));
    await expect(
      commitUsage({
        reservationId: RESERVATION_ID,
        kind: 'llm',
        status: 'success',
        latencyMs: 123,
        streamAborted: false,
        actualInputTokens: 100,
        actualOutputTokens: 20,
      }),
    ).resolves.toEqual({
      schemaVersion: '1.0',
      state: 'committed',
      reservationId: RESERVATION_ID,
      operationId: OPERATION_ID,
      reservedUsd: '5',
      actualUsd: '3.25',
      releasedUsd: '1.75',
      overageUsd: '0',
      budgetExceededAfterCommit: false,
      committedAt: '2026-07-14T09:01:00.000Z',
      idempotentReplay: false,
      late: false,
    });
    const [url, request] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(`https://control.test/api/v1/budget/reservations/${RESERVATION_ID}/commit`);
    expect(JSON.parse(String(request?.body))).toEqual({
      schema_version: '1.0',
      status: 'success',
      latency_ms: 123,
      stream_aborted: false,
      kind: 'llm',
      actual_input_tokens: 100,
      actual_output_tokens: 20,
    });
    expect(new Headers(request?.headers).get('x-pylva-sdk-version')).toBe('1.2.0');
  });

  it('normalizes exact tool usage, and identical retries keep an identical body', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(commitResponse))
      .mockResolvedValueOnce(json({ ...commitResponse, idempotent_replay: true }));
    const input = {
      reservationId: RESERVATION_ID,
      kind: 'tool' as const,
      status: 'success' as const,
      latencyMs: 20,
      streamAborted: false,
      actualValue: 2,
    };
    await commitUsage(input);
    await expect(commitUsage(input)).resolves.toMatchObject({ idempotentReplay: true });
    expect(fetchSpy.mock.calls[0]?.[1]?.body).toBe(fetchSpy.mock.calls[1]?.[1]?.body);
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toMatchObject({
      kind: 'tool',
      actual_value: '2',
    });
  });

  it('releases only for an explicit uncharged reason', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(releaseResponse));
    await expect(
      releaseUsage({ reservationId: RESERVATION_ID, reason: 'provider_not_called' }),
    ).resolves.toEqual({
      schemaVersion: '1.0',
      state: 'released',
      reservationId: RESERVATION_ID,
      operationId: OPERATION_ID,
      releasedUsd: '5',
      releasedAt: '2026-07-14T09:01:00.000Z',
      idempotentReplay: false,
    });
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
      schema_version: '1.0',
      reason: 'provider_not_called',
    });
  });

  it('extends with caller-owned extension identity and verifies it in the response', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(extendResponse));
    await expect(
      extendUsage({
        reservationId: RESERVATION_ID,
        extensionId: EXTENSION_ID,
        extendBySeconds: 300,
      }),
    ).resolves.toEqual({
      schemaVersion: '1.0',
      state: 'reserved',
      reservationId: RESERVATION_ID,
      operationId: OPERATION_ID,
      extensionId: EXTENSION_ID,
      expiresAt: '2026-07-14T09:10:00.000Z',
      idempotentReplay: false,
    });
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
      schema_version: '1.0',
      extension_id: EXTENSION_ID,
      extend_by_seconds: 300,
    });
  });

  it.each([
    () =>
      commitUsage({
        reservationId: 'bad-id',
        kind: 'llm',
        status: 'success',
        latencyMs: 1,
        streamAborted: false,
        actualInputTokens: 1,
        actualOutputTokens: 1,
      }),
    () =>
      commitUsage({
        reservationId: RESERVATION_ID,
        kind: 'tool',
        status: 'success',
        latencyMs: 1,
        streamAborted: false,
        actualValue: 1.5,
      }),
    () =>
      releaseUsage({
        reservationId: RESERVATION_ID,
        reason: 'charged' as never,
      }),
    () =>
      extendUsage({
        reservationId: RESERVATION_ID,
        extensionId: EXTENSION_ID,
        extendBySeconds: 29,
      }),
    () =>
      extendUsage({
        reservationId: RESERVATION_ID,
        extensionId: 'bad-id',
        extendBySeconds: 300,
      }),
  ])('rejects invalid lifecycle input before fetch %#', async (call) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(call()).rejects.toBeInstanceOf(PylvaControlValidationError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('surfaces deterministic 404/409 API errors rather than pretending settlement succeeded', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(
      json(
        {
          error: {
            type: 'invalid_request_error',
            code: 'RESOURCE_NOT_FOUND',
            message: 'details',
          },
        },
        404,
      ),
    );
    await expect(
      releaseUsage({ reservationId: RESERVATION_ID, reason: 'provider_not_called' }),
    ).rejects.toMatchObject({ status: 404, code: 'RESOURCE_NOT_FOUND' });

    fetchSpy.mockResolvedValueOnce(
      json(
        {
          error: {
            type: 'invalid_request_error',
            code: 'RESERVATION_STATE_CONFLICT',
            message: 'details',
          },
        },
        409,
      ),
    );
    await expect(
      releaseUsage({ reservationId: RESERVATION_ID, reason: 'provider_not_called' }),
    ).rejects.toBeInstanceOf(PylvaControlApiError);
  });

  it.each([
    ['commitUsage', { ...commitResponse, reservation_id: EXTENSION_ID }],
    ['releaseUsage', { ...releaseResponse, reservation_id: EXTENSION_ID }],
    ['extendUsage', { ...extendResponse, extension_id: OPERATION_ID }],
  ])('rejects mismatched lifecycle identity from %s', async (operation, response) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(response));
    let call: Promise<unknown>;
    if (operation === 'commitUsage') {
      call = commitUsage({
        reservationId: RESERVATION_ID,
        kind: 'llm',
        status: 'success',
        latencyMs: 1,
        streamAborted: false,
        actualInputTokens: 1,
        actualOutputTokens: 1,
      });
    } else if (operation === 'releaseUsage') {
      call = releaseUsage({ reservationId: RESERVATION_ID, reason: 'provider_not_called' });
    } else {
      call = extendUsage({
        reservationId: RESERVATION_ID,
        extensionId: EXTENSION_ID,
        extendBySeconds: 300,
      });
    }
    await expect(call).rejects.toMatchObject({
      name: 'PylvaControlUnavailableError',
      reason: 'invalid_response',
      retryable: false,
      operation,
      reservationId: RESERVATION_ID,
      unavailableResponse: null,
    });
  });

  it('enforces lifecycle timeout and never treats onUnavailable=allow as settlement success', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => {}));
    init({
      apiKey: KEY,
      endpoint: 'https://control.test',
      control: { mode: 'enforce', onUnavailable: 'allow', timeoutMs: 100 },
    });
    const pending = releaseUsage({
      reservationId: RESERVATION_ID,
      reason: 'provider_not_called',
    });
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'PylvaControlUnavailableError',
      reason: 'timeout',
      retryable: true,
      operation: 'releaseUsage',
      reservationId: RESERVATION_ID,
    });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });
});
