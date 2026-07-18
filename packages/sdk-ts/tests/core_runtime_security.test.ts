import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  AuthenticatedRoute,
  InvalidApiKeyError as RuntimeInvalidApiKeyError,
  InvalidControlConfigError as RuntimeInvalidControlConfigError,
  _resetCoreRuntimeForTests,
  coreRuntime,
} from '../src/internal/core-runtime-state.js';
import { InvalidApiKeyError, InvalidControlConfigError, init } from '../src/core/config.js';
import { canonicalRuntimeExternalPlugin } from '../tsup.shared.js';

const KEY_A = `pv_live_aabbccdd_${'a'.repeat(32)}`;
const KEY_B = `pv_live_bbccddee_${'b'.repeat(32)}`;

describe('canonical core runtime security boundary', () => {
  beforeEach(() => _resetCoreRuntimeForTests({ clearResetters: true }));
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for('@pylva/sdk-runtime/v2/core-coordinator')
    ];
  });

  it('keeps authority module-private and returns only frozen redacted config', () => {
    init({
      apiKey: KEY_A,
      endpoint: 'https://self-host.test/base///',
      control: { mode: 'enforce', onUnavailable: 'deny' },
    });

    expect(Object.getPrototypeOf(coreRuntime)).toBeNull();
    expect(Object.isFrozen(coreRuntime)).toBe(true);
    expect(Object.values(coreRuntime).every(Object.isFrozen)).toBe(true);
    expect(coreRuntime.getConfig()).toEqual({
      endpoint: 'https://self-host.test/base',
      batchSize: 100,
      flushInterval: 5_000,
      localMode: false,
      control: { mode: 'enforce', onUnavailable: 'deny', timeoutMs: 2_000 },
    });
    expect(JSON.stringify(coreRuntime)).not.toContain(KEY_A);
    expect(JSON.stringify(coreRuntime.getConfig())).not.toContain(KEY_A);

    const published = Object.getOwnPropertySymbols(globalThis)
      .filter((symbol) => Symbol.keyFor(symbol)?.startsWith('@pylva/sdk-runtime/'))
      .map((symbol) => (globalThis as Record<PropertyKey, unknown>)[symbol]);
    expect(published).not.toContain(coreRuntime);
    expect(JSON.stringify(published)).not.toContain(KEY_A);
    expect(Object.hasOwn(coreRuntime, 'install')).toBe(false);
    expect(Object.hasOwn(coreRuntime, 'installResolved')).toBe(false);
    expect(() => Object.defineProperty(coreRuntime, 'install', { value: () => {} })).toThrow();
    expect(coreRuntime.getConfig()?.control.mode).toBe('enforce');
  });

  it('keeps raw config validation in root init while deep runtimes use named canonical state', () => {
    let resolve!: (args: { importer: string; path: string }) => unknown;
    canonicalRuntimeExternalPlugin.setup({
      onResolve(_options, callback) {
        resolve = callback as typeof resolve;
      },
    } as never);

    expect(
      resolve({
        importer: '/workspace/packages/sdk-ts/src/core/control_client.ts',
        path: './config.js',
      }),
    ).toEqual({ path: '#pylva/core-runtime', external: true });
    expect(
      resolve({
        importer: '/workspace/packages/sdk-ts/src/wrappers/openai_controlled.ts',
        path: '../core/config.js',
      }),
    ).toEqual({ path: '#pylva/core-runtime', external: true });
    expect(
      resolve({
        importer: '/workspace/packages/sdk-ts/src/index.ts',
        path: './core/config.js',
      }),
    ).toBeUndefined();
    expect(
      resolve({
        importer: '/workspace/packages/sdk-ts/src/core/identity.ts',
        path: './config.js',
      }),
    ).toBeUndefined();
    expect(
      resolve({
        importer: '/workspace/packages/sdk-ts/src/feature/consumer.ts',
        path: '../unrelated/config.js',
      }),
    ).toBeUndefined();
  });

  it('canonicalizes config catch paths and keeps development builds on the production topology', () => {
    expect(InvalidApiKeyError).toBe(RuntimeInvalidApiKeyError);
    expect(InvalidControlConfigError).toBe(RuntimeInvalidControlConfigError);

    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.['dev']).toBe('node scripts/build.mjs');
    expect(packageJson.scripts?.['dev']).not.toContain('tsup --watch');
  });

  it('is unaffected by deleting or replacing SDK-shaped global symbols', async () => {
    init({ apiKey: KEY_A, endpoint: 'https://self-host.test' });
    const decoy = Symbol.for('@pylva/sdk-runtime/v2/core-coordinator');
    Object.defineProperty(globalThis, decoy, {
      value: Object.freeze({ authenticatedRequest: () => new Response('attacker') }),
      configurable: true,
    });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    await coreRuntime.authenticatedRequest({ route: AuthenticatedRoute.PRICING });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get('X-Pylva-Key')).toBe(KEY_A);

    delete (globalThis as Record<PropertyKey, unknown>)[decoy];
    await coreRuntime.authenticatedRequest({ route: AuthenticatedRoute.RULES });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses only closed routes and adds the hidden key at the installed endpoint', async () => {
    init({ apiKey: KEY_A, endpoint: 'https://self-host.test/base/' });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    await coreRuntime.authenticatedRequest({ route: AuthenticatedRoute.PRICING });
    const [url, requestInit] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://self-host.test/base/api/v1/pricing');
    expect(requestInit).toMatchObject({ method: 'GET' });
    expect(new Headers(requestInit?.headers).get('X-Pylva-Key')).toBe(KEY_A);

    await expect(
      coreRuntime.authenticatedRequest({ route: 'https://attacker.test' } as never),
    ).rejects.toThrow('route is not supported');
    await expect(
      coreRuntime.authenticatedRequest({
        route: AuthenticatedRoute.PRICING,
        headers: { Authorization: KEY_B },
      } as never),
    ).rejects.toThrow('unknown field');
    await expect(
      coreRuntime.authenticatedRequest(
        new Proxy({ route: AuthenticatedRoute.PRICING }, {}) as never,
      ),
    ).rejects.toThrow('plain object');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps every authenticated operation to its fixed route and method', async () => {
    const reservationId = '018f4f2d-ae60-7f42-8f7e-ea9a30f88080';
    const cases = [
      [AuthenticatedRoute.PRICING, '/api/v1/pricing', 'GET', false],
      [AuthenticatedRoute.RULES, '/api/v1/rules', 'GET', false],
      [AuthenticatedRoute.NON_LLM_POLICY, '/api/v1/sdk/non-llm-policy', 'GET', false],
      [AuthenticatedRoute.NON_LLM_DISCOVERIES, '/api/v1/sdk/non-llm-discoveries', 'POST', false],
      [AuthenticatedRoute.EVENTS, '/api/v1/events', 'POST', false],
      [AuthenticatedRoute.BUDGET_SYNC, '/api/v1/budget/sync', 'POST', false],
      [AuthenticatedRoute.CONTROL_CAPABILITIES, '/api/v1/budget/capabilities', 'GET', true],
      [AuthenticatedRoute.CONTROL_RESERVE, '/api/v1/budget/reservations', 'POST', true],
      [
        AuthenticatedRoute.CONTROL_COMMIT,
        `/api/v1/budget/reservations/${reservationId}/commit`,
        'POST',
        true,
      ],
      [
        AuthenticatedRoute.CONTROL_RELEASE,
        `/api/v1/budget/reservations/${reservationId}/release`,
        'POST',
        true,
      ],
      [
        AuthenticatedRoute.CONTROL_EXTEND,
        `/api/v1/budget/reservations/${reservationId}/extend`,
        'POST',
        true,
      ],
    ] as const;
    init({ apiKey: KEY_A, endpoint: 'https://self-host.test/base' });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () => new Response('{"ok":true}', { status: 200, statusText: 'OK' }),
      );

    for (const [route, path, method] of cases) {
      const request =
        method === 'GET'
          ? { route }
          : route === AuthenticatedRoute.CONTROL_COMMIT ||
              route === AuthenticatedRoute.CONTROL_RELEASE ||
              route === AuthenticatedRoute.CONTROL_EXTEND
            ? { route, reservationId, body: '{}' }
            : { route, body: '{}' };
      const result = await coreRuntime.authenticatedRequest(request);
      expect(Object.getPrototypeOf(result)).toBeNull();
      expect(Object.isFrozen(result)).toBe(true);
      expect(result).toEqual({ ok: true, status: 200, statusText: 'OK', bodyText: '{"ok":true}' });
      const [url, requestInit] = fetchMock.mock.calls.at(-1)!;
      expect(url).toBe(`https://self-host.test/base${path}`);
      expect(requestInit?.method).toBe(method);
      expect(new Headers(requestInit?.headers).get('X-Pylva-Key')).toBe(KEY_A);
      expect(new Headers(requestInit?.headers).get('Content-Type')).toBe(
        method === 'POST' ? 'application/json' : null,
      );
    }

    expect(fetchMock).toHaveBeenCalledTimes(cases.length);
    for (const [index, testCase] of cases.entries()) {
      const headers = new Headers(fetchMock.mock.calls[index]![1]?.headers);
      if (testCase[3]) expect(headers.get('X-Pylva-SDK-Version')).toEqual(expect.any(String));
      else expect(headers.get('X-Pylva-SDK-Version')).toBeNull();
      expect(fetchMock.mock.calls[index]![1]?.cache).toBe(testCase[3] ? 'no-store' : undefined);
    }
  });

  it('rejects hostile config descriptors and array extras without invoking them', () => {
    let getterCalls = 0;
    const accessorConfig = { apiKey: KEY_A } as Record<string, unknown>;
    Object.defineProperty(accessorConfig, 'endpoint', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'https://attacker.test';
      },
    });
    expect(() => init(accessorConfig as never)).toThrow('data properties');
    expect(getterCalls).toBe(0);

    const symbolConfig = { apiKey: KEY_A, [Symbol('secret')]: 'value' };
    expect(() => init(symbolConfig)).toThrow('symbol field');
    expect(() => init({ apiKey: KEY_A, unexpected: true } as never)).toThrow('unknown field');
    expect(() => init(new Proxy({ apiKey: KEY_A }, {}))).toThrow('requires a config object');

    const arrayWithExtra = [1] as unknown[] & Record<string, unknown>;
    arrayWithExtra['extra'] = true;
    expect(() => init({ apiKey: KEY_A, nonLlm: arrayWithExtra as never })).toThrow(
      'arrays cannot contain extra fields',
    );
    const sparse = new Array(2) as unknown[];
    sparse[1] = true;
    expect(() => init({ apiKey: KEY_A, nonLlm: sparse as never })).toThrow('dense data arrays');

    expect(() => init({ apiKey: KEY_A, control: new Date() as never })).toThrow(
      'control must be a plain object',
    );
    expect(() =>
      init({
        apiKey: KEY_A,
        nonLlm: { policy: { sources: new Array(6_000).fill(0) } } as never,
      }),
    ).toThrow('cannot exceed 10000 nodes and properties');

    const nestedAccessor = { mode: 'policy' } as Record<string, unknown>;
    Object.defineProperty(nestedAccessor, 'policy', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return {};
      },
    });
    expect(() => init({ apiKey: KEY_A, nonLlm: nestedAccessor })).toThrow('data properties');
    expect(getterCalls).toBe(0);

    const cycle = Object.create(null) as Record<string, unknown>;
    cycle['policy'] = cycle;
    expect(() => init({ apiKey: KEY_A, nonLlm: cycle })).toThrow('bounded acyclic');

    const sharedSource = {
      slug: 'shared',
      status: 'tracked',
      matchers: ['shared'],
    };
    expect(() =>
      init({
        apiKey: KEY_A,
        nonLlm: { policy: { sources: [sharedSource, sharedSource] } } as never,
      }),
    ).toThrow('bounded acyclic');
    expect(() => init({ apiKey: KEY_A, nonLlm: new Proxy({ mode: 'policy' }, {}) })).toThrow(
      'bounded acyclic',
    );
  });

  it('does not reset for the same identity or publish invalid replacement config', () => {
    init({ apiKey: KEY_A, endpoint: 'https://one.test' });
    const generation = coreRuntime.generation();
    const resetter = vi.fn();
    coreRuntime.registerIdentityResetter(resetter);

    init({
      apiKey: KEY_A,
      endpoint: 'https://one.test/',
      control: { mode: 'enforce', onUnavailable: 'deny' },
    });
    expect(resetter).not.toHaveBeenCalled();
    expect(coreRuntime.generation()).toBe(generation);
    expect(coreRuntime.getConfig()?.control.mode).toBe('enforce');

    expect(() => init({ apiKey: KEY_B, endpoint: 'https://two.test', batchSize: 0 })).toThrow(
      'positive integer',
    );
    expect(resetter).not.toHaveBeenCalled();
    expect(coreRuntime.getConfig()?.endpoint).toBe('https://one.test');
    expect(coreRuntime.generation()).toBe(generation);
  });

  it('bounds response consumption and keeps credentials out of failures', async () => {
    init({ apiKey: KEY_A, endpoint: 'https://one.test' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('x'.repeat(1024 * 1024 + 1), { status: 200 }),
    );

    let failure: unknown;
    try {
      await coreRuntime.authenticatedRequest({ route: AuthenticatedRoute.EVENTS, body: '{}' });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(TypeError);
    expect(String(failure)).toContain('response body exceeds limit');
    expect(String(failure)).not.toContain(KEY_A);
  });

  it('applies the larger catalog cap and supports responses with no body', async () => {
    init({ apiKey: KEY_A, endpoint: 'https://one.test' });
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const empty = await coreRuntime.authenticatedRequest({
      route: AuthenticatedRoute.EVENTS,
      body: '{}',
    });
    expect(empty).toEqual({ ok: true, status: 204, statusText: '', bodyText: '' });

    fetchMock.mockResolvedValueOnce(new Response('x'.repeat(8 * 1024 * 1024 + 1), { status: 200 }));
    await expect(
      coreRuntime.authenticatedRequest({ route: AuthenticatedRoute.PRICING }),
    ).rejects.toThrow('response body exceeds limit');
  });

  it('rejects invalid and oversized POST requests before provider I/O', async () => {
    init({ apiKey: KEY_A, endpoint: 'https://one.test' });
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(
      coreRuntime.authenticatedRequest({
        route: AuthenticatedRoute.EVENTS,
        body: 'x'.repeat(16 * 1024 * 1024 + 1),
      }),
    ).rejects.toThrow('body must be bounded serialized JSON');
    await expect(
      coreRuntime.authenticatedRequest({
        route: AuthenticatedRoute.CONTROL_COMMIT,
        reservationId: '../attacker',
        body: '{}',
      }),
    ).rejects.toThrow('reservationId must be a UUID');
    await expect(
      coreRuntime.authenticatedRequest({
        route: AuthenticatedRoute.CONTROL_RESERVE,
      } as never),
    ).rejects.toThrow('missing field');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates caller abort while a response body is stalled', async () => {
    init({ apiKey: KEY_A, endpoint: 'https://one.test' });
    let bodyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull: () => {
        bodyStarted();
        return new Promise<void>(() => undefined);
      },
      cancel,
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }));
    const caller = new AbortController();
    const pending = coreRuntime.authenticatedRequest({
      route: AuthenticatedRoute.RULES,
      signal: caller.signal,
    });

    await started;
    caller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('aborts old requests and runs every synchronous reset before publishing a new identity', async () => {
    init({ apiKey: KEY_A, endpoint: 'https://one.test' });
    const order: string[] = [];
    let requestSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          requestSignal = init?.signal ?? undefined;
          requestSignal?.addEventListener('abort', () => {
            order.push('fetch-abort');
            reject(new DOMException('aborted'));
          });
        }),
    );
    const pending = coreRuntime
      .authenticatedRequest({ route: AuthenticatedRoute.RULES })
      .catch(() => undefined);
    coreRuntime.registerIdentityResetter(() => {
      order.push(`first:${String(requestSignal?.aborted)}`);
    });
    coreRuntime.registerIdentityResetter(() => {
      order.push('second');
    });

    init({ apiKey: KEY_B, endpoint: 'https://two.test' });
    await pending;
    expect(order).toEqual(['fetch-abort', 'first:true', 'second']);
    expect(coreRuntime.getConfig()?.endpoint).toBe('https://two.test');
  });

  it('cancels a stalled response body before resetters and new identity publication', async () => {
    init({ apiKey: KEY_A, endpoint: 'https://one.test' });
    const order: string[] = [];
    let bodyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      pull: () => {
        bodyStarted();
        return new Promise<void>(() => undefined);
      },
      cancel: () => {
        order.push('body-cancel');
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }));
    coreRuntime.registerIdentityResetter(() => {
      order.push(`resetter:${coreRuntime.getConfig()?.endpoint}`);
    });

    const pending = coreRuntime
      .authenticatedRequest({ route: AuthenticatedRoute.RULES })
      .catch(() => undefined);
    await started;
    init({ apiKey: KEY_B, endpoint: 'https://two.test' });
    await pending;

    expect(order).toEqual(['body-cancel', 'resetter:https://one.test']);
    expect(coreRuntime.getConfig()?.endpoint).toBe('https://two.test');
  });

  it('attempts all resetters and keeps the old identity when cleanup fails', () => {
    init({ apiKey: KEY_A, endpoint: 'https://one.test' });
    const generation = coreRuntime.generation();
    const calls: string[] = [];
    coreRuntime.registerIdentityResetter(() => {
      calls.push('throws');
      throw new Error('cleanup failed');
    });
    coreRuntime.registerIdentityResetter(() => {
      calls.push('still-runs');
    });
    coreRuntime.registerIdentityResetter((() => Promise.resolve()) as unknown as () => void);

    expect(() => init({ apiKey: KEY_B, endpoint: 'https://two.test' })).toThrow(AggregateError);
    expect(calls).toEqual(['throws', 'still-runs']);
    expect(coreRuntime.getConfig()?.endpoint).toBe('https://one.test');
    expect(coreRuntime.generation()).toBe(generation);
  });
});
