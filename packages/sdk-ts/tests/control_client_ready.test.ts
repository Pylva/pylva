import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetConfigForTests, init } from '../src/core/config.js';
import { _resetControlClientForTests, controlStatus, ready } from '../src/core/control_client.js';
import { PylvaControlApiError, PylvaControlUnavailableError } from '../src/errors/control.js';

const KEY_A = `pv_live_aabbccdd_${'a'.repeat(32)}`;
const KEY_B = `pv_live_bbccddee_${'b'.repeat(32)}`;

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

describe('authoritative-control readiness', () => {
  beforeEach(() => {
    _resetControlClientForTests();
    _resetConfigForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    _resetControlClientForTests();
    _resetConfigForTests();
  });

  it('coalesces concurrent reads, caches capabilities, and sends SDK identity headers', async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    init({
      apiKey: KEY_A,
      endpoint: 'https://control.test/',
      control: { mode: 'enforce' },
    });

    const first = controlStatus();
    const second = controlStatus();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    resolveFetch(json({ ...capabilities, additive_future_field: true }));

    await expect(first).resolves.toMatchObject({ ready: true, supported: true });
    await expect(second).resolves.toMatchObject({ ready: true, supported: true });
    await expect(ready()).resolves.toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [url, request] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://control.test/api/v1/budget/capabilities');
    const headers = new Headers(request?.headers);
    expect(headers.get('x-pylva-key')).toBe(KEY_A);
    expect(headers.get('x-pylva-sdk-version')).toBe('1.2.0');
    expect(headers.get('x-pylva-sdk-language')).toBe('typescript');
    expect(headers.get('accept')).toBe('application/json');
  });

  it('reports legacy mode and disabled server capability without claiming readiness', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(capabilities));
    init({ apiKey: KEY_A, endpoint: 'https://control.test' });
    await expect(controlStatus()).resolves.toMatchObject({
      ready: false,
      supported: true,
      controlEnabled: true,
      mode: 'legacy',
      reason: 'control_disabled',
    });

    _resetControlClientForTests();
    vi.mocked(fetch).mockResolvedValue(json({ ...capabilities, control_enabled: false }));
    init({
      apiKey: KEY_A,
      endpoint: 'https://control.test',
      control: { mode: 'enforce' },
    });
    await expect(controlStatus()).resolves.toMatchObject({
      ready: false,
      supported: true,
      controlEnabled: false,
      reason: 'control_disabled',
    });
  });

  it.each([404, 405])('treats an old backend HTTP %s as unsupported', async (status) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status }));
    init({
      apiKey: KEY_A,
      endpoint: 'https://old.test',
      control: { mode: 'enforce', onUnavailable: 'deny' },
    });
    await expect(controlStatus()).resolves.toEqual({
      ready: false,
      supported: false,
      controlEnabled: null,
      mode: 'enforce',
      capabilities: null,
      reason: 'unsupported_backend',
      retryable: false,
    });
    await expect(ready()).resolves.toBe(false);
  });

  it('returns a sanitized invalid-response readiness result for malformed success bodies', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ control_enabled: true }));
    init({ apiKey: KEY_A, control: { mode: 'shadow' } });
    await expect(controlStatus()).resolves.toMatchObject({
      ready: false,
      supported: null,
      reason: 'invalid_response',
      retryable: false,
    });
  });

  it('does not turn deterministic authentication errors into availability results', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(
        {
          error: {
            type: 'authentication_error',
            code: 'INVALID_API_KEY',
            message: 'do not expose this backend text',
          },
        },
        401,
      ),
    );
    init({ apiKey: KEY_A, control: { mode: 'enforce', onUnavailable: 'allow' } });
    try {
      await ready();
      expect.fail('ready should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PylvaControlApiError);
      expect(error).toMatchObject({
        name: 'PylvaControlApiError',
        status: 401,
        code: 'INVALID_API_KEY',
      });
      expect(String(error)).not.toContain('do not expose this backend text');
    }
  });

  it('enforces the configured timeout even when fetch ignores AbortSignal', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => {}));
    init({ apiKey: KEY_A, control: { mode: 'enforce', timeoutMs: 100 } });
    const result = controlStatus();
    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toMatchObject({
      ready: false,
      reason: 'timeout',
      retryable: true,
    });
  });

  it('keeps the same timeout active while a response body stalls after headers', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream({
          start() {
            // Deliberately never enqueue or close.
          },
        }),
        { status: 200 },
      ),
    );
    init({ apiKey: KEY_A, control: { mode: 'enforce', timeoutMs: 100 } });
    const pending = controlStatus();
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toMatchObject({
      ready: false,
      reason: 'timeout',
      retryable: true,
    });
  });

  it('invalidates cache ownership when endpoint or key changes and discards a late old response', async () => {
    let resolveOld!: (response: Response) => void;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce(json(capabilities));
    init({ apiKey: KEY_A, endpoint: 'https://one.test', control: { mode: 'enforce' } });
    const oldRead = controlStatus();

    init({ apiKey: KEY_B, endpoint: 'https://two.test', control: { mode: 'enforce' } });
    resolveOld(json(capabilities));
    await expect(oldRead).resolves.toMatchObject({ reason: 'configuration_changed' });
    await expect(ready()).resolves.toBe(true);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://one.test/api/v1/budget/capabilities');
    expect(fetchSpy.mock.calls[1]?.[0]).toBe('https://two.test/api/v1/budget/capabilities');
    expect(new Headers(fetchSpy.mock.calls[1]?.[1]?.headers).get('x-pylva-key')).toBe(KEY_B);
  });

  it('never copies a transport exception message into public output', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('secret proxy hostname'));
    init({ apiKey: KEY_A, control: { mode: 'enforce' } });
    const result = await controlStatus();
    expect(result.reason).toBe('network_error');
    expect(JSON.stringify(result)).not.toContain('secret proxy hostname');
  });

  it('throws a typed availability error from ready under fail-closed transport policy', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('private network detail'));
    init({
      apiKey: KEY_A,
      control: { mode: 'enforce', onUnavailable: 'deny' },
    });

    await expect(ready()).rejects.toMatchObject({
      name: 'PylvaControlUnavailableError',
      operation: 'ready',
      reason: 'network_error',
      retryable: true,
    });
    await expect(ready()).rejects.toBeInstanceOf(PylvaControlUnavailableError);
  });
});
