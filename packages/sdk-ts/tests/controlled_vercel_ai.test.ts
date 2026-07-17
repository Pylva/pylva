import { createOpenAI } from '@ai-sdk/openai';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const aiFunctions = vi.hoisted(() => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
}));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateText: (input: unknown) => aiFunctions.generateText(input),
    streamText: (input: unknown) => aiFunctions.streamText(input),
  };
});
import { _resetConfigForTests, init } from '../src/core/config.js';
import { _resetControlClientForTests } from '../src/core/control_client.js';
import {
  registerControlledCallback,
  withControlledCallbackScope,
} from '../src/core/control_correlation.js';
import { _resetTelemetryForTests, bufferSize } from '../src/core/telemetry.js';
import {
  _resetVercelAiPatchForTests,
  PylvaStrictProviderError,
  type ControlledOpenAIChatModel,
  createControlledOpenAIChatModel,
  controlledGenerateText,
  controlledStreamText,
} from '../src/wrappers/vercel-ai.js';

const KEY = `pv_live_aabbccdd_${'a'.repeat(32)}`;
const RESERVATION_ID = '44444444-4444-4444-8444-444444444444';
const nodeRequire = createRequire(import.meta.url);
let defaultManagedModel: ControlledOpenAIChatModel;

function _setControlledAiFunctionsForTests(
  functions: Partial<Record<'generateText' | 'streamText', (input: unknown) => unknown>>,
): void {
  if (functions.generateText) aiFunctions.generateText.mockImplementation(functions.generateText);
  if (functions.streamText) aiFunctions.streamText.mockImplementation(functions.streamText);
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function installFetch(
  options: { reserveDecision?: 'reserved' | 'denied'; afterReserve?: () => void } = {},
) {
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
      operationId = String(body['operation_id']);
      if (options.reserveDecision === 'denied') {
        return json({
          schema_version: '1.0',
          decision: 'denied',
          allowed: false,
          decision_id: '55555555-5555-4555-8555-555555555555',
          operation_id: operationId,
          state: 'refused',
          deciding_rule: {
            rule_id: '66666666-6666-4666-8666-666666666666',
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
      options.afterReserve?.();
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
        expires_at: '2026-07-14T09:05:00.000Z',
        warnings: [],
      });
    }
    if (href.endsWith('/commit')) {
      return json({
        schema_version: '1.0',
        state: 'committed',
        reservation_id: RESERVATION_ID,
        operation_id: operationId,
        reserved_usd: '0.1',
        actual_usd: '0.01',
        released_usd: '0.09',
        overage_usd: '0',
        budget_exceeded_after_commit: false,
        committed_at: '2026-07-14T09:01:00.000Z',
        idempotent_replay: false,
        late: false,
      });
    }
    if (href.endsWith('/release')) {
      return json({
        schema_version: '1.0',
        state: 'released',
        reservation_id: RESERVATION_ID,
        operation_id: operationId,
        released_usd: '0.1',
        released_at: '2026-07-14T09:01:00.000Z',
        idempotent_replay: false,
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
        expires_at: '2026-07-14T09:10:00.000Z',
        idempotent_replay: false,
      });
    }
    throw new Error(`unexpected ${href}`);
  });
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    model: defaultManagedModel,
    prompt: 'private prompt',
    maxOutputTokens: 20,
    providerOptions: { openai: { serviceTier: 'default' } },
    ...overrides,
  };
}

async function managedOpenAiChatModel(
  options: { apiKey: string; model: string } = {
    apiKey: 'test',
    model: 'gpt-test-2026-01-01',
  },
): Promise<ControlledOpenAIChatModel> {
  return await createControlledOpenAIChatModel(options);
}

function rawOpenAiChatModel() {
  return createOpenAI({ apiKey: 'test' }).chat('gpt-test-2026-01-01');
}

function usage(overrides: Record<string, unknown> = {}) {
  return {
    inputTokens: 8,
    outputTokens: 4,
    inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
    ...overrides,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function strictModelProbe(this: Record<string, unknown>): Promise<Record<string, unknown>> {
  const config = this['config'] as Record<string, unknown>;
  const url = config['url'] as (value: unknown) => unknown;
  const headers = config['headers'] as () => unknown;
  return {
    provider: this['provider'],
    modelId: this['modelId'],
    specificationVersion: this['specificationVersion'],
    supportedUrlKeys: Object.keys(this['supportedUrls'] as object),
    url: url({ path: '/chat/completions', modelId: this['modelId'] }),
    headers: headers(),
    fetch: config['fetch'],
    methodTypes: [typeof this['getArgs'], typeof this['doGenerate'], typeof this['doStream']],
  };
}

const cyclicZeroEvidence: Record<string, unknown> = {};
cyclicZeroEvidence['self'] = cyclicZeroEvidence;
const oversizedZeroArray = Array.from({ length: 257 }, () => 0);
const oversizedSparseArray: unknown[] = [];
oversizedSparseArray.length = 257;
const oversizedZeroRecord = Object.fromEntries(
  Array.from({ length: 257 }, (_, index) => [`zero_${index}`, 0]),
);
const oversizedUsageRecord = Object.assign(usage(), oversizedZeroRecord);
const oversizedUsageDetails = { noCacheTokens: 8, ...oversizedZeroRecord };
let tooDeepZeroEvidence: unknown = 0;
for (let depth = 0; depth < 10; depth += 1) {
  tooDeepZeroEvidence = { nested: tooDeepZeroEvidence };
}

function reset(): void {
  _resetVercelAiPatchForTests();
  _resetControlClientForTests();
  _resetTelemetryForTests();
  _resetConfigForTests();
}

describe('controlled Vercel AI one-step subset', () => {
  beforeEach(async () => {
    reset();
    aiFunctions.generateText.mockReset();
    aiFunctions.streamText.mockReset();
    defaultManagedModel = await managedOpenAiChatModel();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    reset();
  });

  it('forces zero retries, reserves before generateText, and commits exact unified usage', async () => {
    const fetchSpy = installFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const result = {
      text: 'answer',
      usage: usage(),
      providerMetadata: { openai: { serviceTier: 'default' } },
      response: { modelId: 'gpt-test-2026-01-01' },
    };
    const generateText = vi.fn(async () => result);
    _setControlledAiFunctionsForTests({ generateText });

    await expect(controlledGenerateText(request())).resolves.toBe(result);
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 0 }));
    expect(generateText.mock.invocationCallOrder[0]).toBeGreaterThan(
      fetchSpy.mock.invocationCallOrder[1] ?? 0,
    );
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(true);
    const reserveCall = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/reservations'));
    expect(String(reserveCall?.[1]?.body)).not.toContain('private prompt');
    expect(bufferSize()).toBe(0);
  });

  it('dispatches the detached bounded request when caller-owned nested data mutates during reserve', async () => {
    const model = await managedOpenAiChatModel();
    const message = { role: 'user', content: 'original message' };
    const providerOptions = { openai: { serviceTier: 'default' } };
    const stopSequences = ['ORIGINAL_STOP'];
    const timeout = { totalMs: 5_000 };
    const input = request({
      model,
      prompt: undefined,
      system: 'original system',
      messages: [message],
      providerOptions,
      stopSequences,
      timeout,
    });
    const fetchSpy = installFetch({
      afterReserve: () => {
        input.system = 'mutated system';
        message.content = 'mutated message';
        input.messages.push({ role: 'assistant', content: 'late message' });
        providerOptions.openai.serviceTier = 'priority';
        stopSequences[0] = 'MUTATED_STOP';
        timeout.totalMs = 1;
        input.maxOutputTokens = 4_000;
      },
    });
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    let dispatched: Record<string, unknown> | null = null;
    const result = {
      usage: usage(),
      providerMetadata: { openai: { serviceTier: 'default' } },
      response: { modelId: 'gpt-test-2026-01-01' },
    };
    _setControlledAiFunctionsForTests({
      generateText: async (candidate) => {
        dispatched = candidate as Record<string, unknown>;
        return result;
      },
    });

    await expect(controlledGenerateText(input)).resolves.toBe(result);
    expect(dispatched).toMatchObject({
      system: 'original system',
      messages: [{ role: 'user', content: 'original message' }],
      providerOptions: { openai: { serviceTier: 'default' } },
      stopSequences: ['ORIGINAL_STOP'],
      timeout: { totalMs: 5_000 },
      maxOutputTokens: 20,
    });
    expect((dispatched?.['messages'] as unknown[]).length).toBe(1);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(true);
  });

  it('passes an internally locked model to an injected generate function with deferred model reads', async () => {
    const fetchSpy = installFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const factoryInput = { apiKey: 'test', model: 'gpt-test-2026-01-01' };
    const model = await managedOpenAiChatModel(factoryInput);
    const entered = deferred();
    const release = deferred();
    let observed: unknown;
    const result = {
      usage: usage(),
      providerMetadata: { openai: { serviceTier: 'default' } },
      response: { modelId: 'gpt-test-2026-01-01' },
    };
    _setControlledAiFunctionsForTests({
      generateText: async (candidate) => {
        entered.resolve();
        await release.promise;
        const dispatchedModel = (candidate as Record<string, unknown>)['model'] as Record<
          string,
          unknown
        >;
        observed = await Reflect.apply(strictModelProbe, dispatchedModel, []);
        return result;
      },
    });

    const pending = controlledGenerateText(request({ model }));
    await entered.promise;
    factoryInput.apiKey = 'mutated-key';
    factoryInput.model = 'mutated-model';
    release.resolve();

    await expect(pending).resolves.toBe(result);
    expect(observed).toEqual({
      provider: 'openai.chat',
      modelId: 'gpt-test-2026-01-01',
      specificationVersion: 'v3',
      supportedUrlKeys: ['image/*'],
      url: 'https://api.openai.com/v1/chat/completions',
      headers: {
        authorization: 'Bearer test',
        'user-agent': 'ai-sdk/openai/3.0.84',
      },
      fetch: undefined,
      methodTypes: ['function', 'function', 'function'],
    });
    expect(Object.isFrozen(model)).toBe(true);
    expect(Reflect.ownKeys(model)).toEqual([]);
    expect(JSON.stringify(model)).toBe('{}');
    expect(JSON.stringify(model)).not.toContain('test');
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(true);
  });

  it('keeps the injected stream model locked when it is read after the helper returns', async () => {
    installFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const factoryInput = { apiKey: 'test', model: 'gpt-test-2026-01-01' };
    const model = await managedOpenAiChatModel(factoryInput);
    const release = deferred();
    const observed = deferred();
    let evidence: unknown;
    const nativeResult = { textStream: 'native-stream-result' };
    _setControlledAiFunctionsForTests({
      streamText: (candidate) => {
        const dispatchedModel = (candidate as Record<string, unknown>)['model'] as Record<
          string,
          unknown
        >;
        void (async () => {
          await release.promise;
          evidence = await Reflect.apply(strictModelProbe, dispatchedModel, []);
          observed.resolve();
        })();
        return nativeResult;
      },
    });

    await expect(controlledStreamText(request({ model }))).resolves.toBe(nativeResult);
    factoryInput.apiKey = 'mutated-key';
    factoryInput.model = 'mutated-model';
    release.resolve();
    await observed.promise;

    expect(evidence).toEqual({
      provider: 'openai.chat',
      modelId: 'gpt-test-2026-01-01',
      specificationVersion: 'v3',
      supportedUrlKeys: ['image/*'],
      url: 'https://api.openai.com/v1/chat/completions',
      headers: {
        authorization: 'Bearer test',
        'user-agent': 'ai-sdk/openai/3.0.84',
      },
      fetch: undefined,
      methodTypes: ['function', 'function', 'function'],
    });
    expect(Object.isFrozen(model)).toBe(true);
  });

  it('refuses direct, method-overridden, structural, and hostile raw models without reading them', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const generateText = vi.fn();
    _setControlledAiFunctionsForTests({ generateText });
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });

    await expect(
      controlledGenerateText(request({ model: rawOpenAiChatModel() })),
    ).rejects.toMatchObject({ reason: 'controlled_openai_chat_model_is_required' });
    for (const method of ['getArgs', 'doGenerate', 'doStream'] as const) {
      const model = rawOpenAiChatModel();
      Object.defineProperty(model, method, {
        configurable: true,
        enumerable: false,
        writable: true,
        value: vi.fn(),
      });
      await expect(controlledGenerateText(request({ model }))).rejects.toMatchObject({
        reason: 'controlled_openai_chat_model_is_required',
      });
    }

    const structuralModel = {
      specificationVersion: 'v3',
      supportedUrls: { 'image/*': [/^https?:\/\/.*$/] },
      provider: 'openai.chat',
      modelId: 'gpt-test-2026-01-01',
      config: {
        provider: 'openai.chat',
        url: ({ path }: { path: string }) => `https://api.openai.com/v1${path}`,
        headers: () => ({
          authorization: 'Bearer test',
          'user-agent': 'ai-sdk/openai/3.0.84',
        }),
        fetch: undefined,
      },
      getArgs: vi.fn(),
      doGenerate: vi.fn(),
      doStream: vi.fn(),
    };
    await expect(controlledGenerateText(request({ model: structuralModel }))).rejects.toMatchObject(
      {
        reason: 'controlled_openai_chat_model_is_required',
      },
    );

    const providerGetter = vi.fn(() => 'openai.chat');
    const hostileUrl = vi.fn(() => 'https://api.openai.com/v1/chat/completions');
    const hostileHeaders = vi.fn(() => ({ authorization: 'Bearer hostile' }));
    const hostileModel: Record<string, unknown> = {};
    Object.defineProperty(hostileModel, 'provider', { enumerable: true, get: providerGetter });
    Object.defineProperty(hostileModel, 'config', {
      enumerable: true,
      value: { url: hostileUrl, headers: hostileHeaders },
    });
    await expect(controlledGenerateText(request({ model: hostileModel }))).rejects.toMatchObject({
      reason: 'controlled_openai_chat_model_is_required',
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
    expect(providerGetter).not.toHaveBeenCalled();
    expect(hostileUrl).not.toHaveBeenCalled();
    expect(hostileHeaders).not.toHaveBeenCalled();
  });

  it('rejects unsafe managed-model factory options before callbacks or I/O', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const apiKeyGetter = vi.fn(() => 'test');
    const accessor: Record<string, unknown> = { model: 'gpt-test-2026-01-01' };
    Object.defineProperty(accessor, 'apiKey', { enumerable: true, get: apiKeyGetter });
    const oversized = Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [`field_${index}`, index]),
    );
    const nonEnumerable = { apiKey: 'test', model: 'gpt-test-2026-01-01' };
    Object.defineProperty(nonEnumerable, 'hidden', { value: true });
    const symbolKey = { apiKey: 'test', model: 'gpt-test-2026-01-01' };
    Object.defineProperty(symbolKey, Symbol('hidden'), { enumerable: true, value: true });
    const invalid = [
      accessor,
      new Proxy({ apiKey: 'test', model: 'gpt-test-2026-01-01' }, {}),
      { apiKey: 'test', model: 'gpt-test-2026-01-01', headers: {} },
      nonEnumerable,
      symbolKey,
      oversized,
      { apiKey: 'contains whitespace', model: 'gpt-test-2026-01-01' },
      { apiKey: 'test', model: 'contains whitespace' },
    ];

    for (const options of invalid) {
      await expect(
        createControlledOpenAIChatModel(options as unknown as { apiKey: string; model: string }),
      ).rejects.toBeInstanceOf(PylvaStrictProviderError);
    }
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, {
      apiKey: 'test',
      model: 'gpt-test-2026-01-01',
    });
    await expect(
      createControlledOpenAIChatModel(
        nullPrototype as unknown as { apiKey: string; model: string },
      ),
    ).resolves.toBeDefined();
    expect(apiKeyGetter).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('detaches factory options before its first async boundary', async () => {
    const factoryInput = {
      apiKey: 'provider-key-before-await',
      model: 'gpt-test-2026-01-01',
    };
    const pendingModel = createControlledOpenAIChatModel(factoryInput);
    factoryInput.apiKey = 'mutated-key-before-await';
    factoryInput.model = 'mutated-model-before-await';
    const model = await pendingModel;
    const fetchSpy = installFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    let observed: unknown;
    const result = {
      usage: usage(),
      providerMetadata: { openai: { serviceTier: 'default' } },
      response: { modelId: 'gpt-test-2026-01-01' },
    };
    _setControlledAiFunctionsForTests({
      generateText: async (candidate) => {
        const dispatchedModel = (candidate as Record<string, unknown>)['model'] as Record<
          string,
          unknown
        >;
        observed = await Reflect.apply(strictModelProbe, dispatchedModel, []);
        return result;
      },
    });

    await expect(controlledGenerateText(request({ model }))).resolves.toBe(result);
    expect(observed).toMatchObject({
      modelId: 'gpt-test-2026-01-01',
      headers: { authorization: 'Bearer provider-key-before-await' },
    });
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(true);
  });

  it('refuses forged, copied, cloned, inherited, and proxied managed-model tokens before I/O', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const generateText = vi.fn();
    _setControlledAiFunctionsForTests({ generateText });
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const token = await managedOpenAiChatModel();
    const candidates = [
      {},
      Object.freeze(Object.create(null) as object),
      { ...token },
      JSON.parse(JSON.stringify(token)) as unknown,
      structuredClone(token),
      Object.create(token) as object,
      new Proxy(token as object, {}),
    ];

    for (const model of candidates) {
      await expect(controlledGenerateText(request({ model }))).rejects.toMatchObject({
        name: 'PylvaStrictProviderError',
        reason: 'controlled_openai_chat_model_is_required',
      });
    }

    expect(generateText).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps managed-model evidence module-private and never exposes the provider key in denial errors', async () => {
    const legacyRegistry = Symbol.for('@pylva/sdk-runtime/v1/controlled-openai-chat-models');
    const secret = 'provider-private-key-never-log-this';
    const model = await managedOpenAiChatModel({
      apiKey: secret,
      model: 'gpt-test-2026-01-01',
    });

    expect(Object.getOwnPropertyDescriptor(globalThis, legacyRegistry)).toBeUndefined();
    expect(Object.getOwnPropertySymbols(globalThis)).not.toContain(legacyRegistry);
    expect(Object.getPrototypeOf(model)).toBeNull();
    expect(Reflect.ownKeys(model)).toEqual([]);
    expect(JSON.stringify(model)).toBe('{}');
    expect(JSON.stringify(model)).not.toContain(secret);

    const fetchSpy = installFetch({ reserveDecision: 'denied' });
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    let caught: unknown;
    try {
      await controlledGenerateText(request({ model }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ name: 'PylvaBudgetExceeded' });
    const errorRecord = caught as { stack?: unknown };
    const renderedError = [String(caught), JSON.stringify(caught), String(errorRecord.stack)].join(
      '\n',
    );
    expect(renderedError).not.toContain(secret);
    for (const [url, requestInit] of fetchSpy.mock.calls) {
      if (String(url).startsWith('https://control.test')) {
        expect(String(requestInit?.body ?? '')).not.toContain(secret);
      }
    }

    let factoryError: unknown;
    try {
      await createControlledOpenAIChatModel({ apiKey: secret, model: 'invalid model' });
    } catch (error) {
      factoryError = error;
    }
    expect(factoryError).toBeInstanceOf(PylvaStrictProviderError);
    expect(`${String(factoryError)}\n${JSON.stringify(factoryError)}`).not.toContain(secret);
  });

  it('uses native ESM peers even when their CommonJS cache entries are poisoned', async () => {
    const openAiPath = nodeRequire.resolve('@ai-sdk/openai');
    const aiPath = nodeRequire.resolve('ai');
    const aiPackagePath = nodeRequire.resolve('ai/package.json');
    nodeRequire(openAiPath);
    nodeRequire(aiPath);
    nodeRequire(aiPackagePath);
    const openAiEntry = nodeRequire.cache[openAiPath];
    const aiEntry = nodeRequire.cache[aiPath];
    const aiPackageEntry = nodeRequire.cache[aiPackagePath];
    expect(openAiEntry).toBeDefined();
    expect(aiEntry).toBeDefined();
    expect(aiPackageEntry).toBeDefined();
    const originalOpenAiExports = openAiEntry?.exports;
    const originalAiExports = aiEntry?.exports;
    const originalAiPackageExports = aiPackageEntry?.exports;
    const poisonedCreateOpenAI = vi.fn(() => {
      throw new Error('poisoned CJS OpenAI must not execute');
    });
    const poisonedGenerateText = vi.fn(() => {
      throw new Error('poisoned CJS AI must not execute');
    });

    try {
      if (openAiEntry) {
        openAiEntry.exports = { VERSION: '3.0.84', createOpenAI: poisonedCreateOpenAI };
      }
      if (aiEntry) aiEntry.exports = { generateText: poisonedGenerateText };
      if (aiPackageEntry) aiPackageEntry.exports = { version: '7.0.0' };
      _resetVercelAiPatchForTests();
      const model = await managedOpenAiChatModel({
        apiKey: 'native-esm-provider-key',
        model: 'gpt-test-2026-01-01',
      });
      const fetchSpy = installFetch();
      init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
      const result = {
        usage: usage(),
        providerMetadata: { openai: { serviceTier: 'default' } },
        response: { modelId: 'gpt-test-2026-01-01' },
      };
      _setControlledAiFunctionsForTests({ generateText: async () => result });

      await expect(controlledGenerateText(request({ model }))).resolves.toBe(result);
      expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(true);
      expect(poisonedCreateOpenAI).not.toHaveBeenCalled();
      expect(poisonedGenerateText).not.toHaveBeenCalled();
    } finally {
      if (openAiEntry) openAiEntry.exports = originalOpenAiExports;
      if (aiEntry) aiEntry.exports = originalAiExports;
      if (aiPackageEntry) aiPackageEntry.exports = originalAiPackageExports;
    }
  });

  it('accepts a normal null-prototype request without weakening its detached snapshot', async () => {
    const fetchSpy = installFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const input = Object.assign(Object.create(null) as Record<string, unknown>, request());
    const result = {
      usage: usage(),
      providerMetadata: { openai: { serviceTier: 'default' } },
      response: { modelId: 'gpt-test-2026-01-01' },
    };
    const generateText = vi.fn(async () => result);
    _setControlledAiFunctionsForTests({ generateText });

    await expect(controlledGenerateText(input)).resolves.toBe(result);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(true);
  });

  it('refuses mutable-accessor, proxy, sparse, and oversized nested request shapes before I/O', async () => {
    const getter = vi.fn(() => 'user');
    const getterMessage: Record<string, unknown> = { content: 'private' };
    Object.defineProperty(getterMessage, 'role', { enumerable: true, get: getter });
    const sparseMessages: unknown[] = [];
    sparseMessages.length = 1;
    const sparseStops: unknown[] = [];
    sparseStops.length = 1;
    const oversizedStops: unknown[] = [];
    oversizedStops.length = 100_001;
    const prototypeRequest = request();
    delete (prototypeRequest as Record<string, unknown>)['maxOutputTokens'];
    Object.defineProperty(prototypeRequest, '__proto__', {
      value: { maxOutputTokens: 1 },
      enumerable: true,
      configurable: true,
    });
    const prototypeMessage = { role: 'user', content: 'private' };
    Object.defineProperty(prototypeMessage, '__proto__', {
      value: { role: 'assistant', content: 'inherited' },
      enumerable: true,
      configurable: true,
    });
    const prototypeProviderOptions = { openai: { serviceTier: 'default' } };
    Object.defineProperty(prototypeProviderOptions, '__proto__', {
      value: { openai: { serviceTier: 'priority' } },
      enumerable: true,
      configurable: true,
    });
    const shadowedAbortSignal = new AbortController().signal;
    Object.defineProperty(shadowedAbortSignal, 'aborted', {
      value: false,
      configurable: true,
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const generateText = vi.fn();
    _setControlledAiFunctionsForTests({ generateText });
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });

    for (const invalid of [
      request({ prompt: undefined, messages: [getterMessage] }),
      request({ prompt: undefined, messages: new Proxy([{ role: 'user', content: 'x' }], {}) }),
      request({ prompt: undefined, messages: sparseMessages }),
      request({ stopSequences: sparseStops }),
      request({ stopSequences: oversizedStops }),
      request({ providerOptions: new Proxy({ openai: { serviceTier: 'default' } }, {}) }),
      request({ prompt: undefined, messages: [prototypeMessage] }),
      request({ providerOptions: prototypeProviderOptions }),
      request({ abortSignal: shadowedAbortSignal }),
      new Proxy(request(), {}),
      prototypeRequest,
    ]) {
      await expect(controlledGenerateText(invalid)).rejects.toMatchObject({
        name: 'PylvaStrictProviderError',
        code: 'strict_provider_unsupported',
      });
    }
    expect(getter).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses an AbortSignal mutated during peer loading before reservation or dispatch', async () => {
    const controller = new AbortController();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const generateText = vi.fn();
    _setControlledAiFunctionsForTests({ generateText });
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });

    const result = controlledGenerateText(request({ abortSignal: controller.signal }));
    Object.defineProperty(controller.signal, 'aborted', {
      value: false,
      configurable: true,
    });

    await expect(result).rejects.toMatchObject({
      code: 'strict_provider_unsupported',
      reason: 'abort_signal_is_invalid',
    });
    expect(generateText).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('passes an owned signal so late caller shadows cannot hide a real abort', async () => {
    const controller = new AbortController();
    const result = {
      usage: usage(),
      response: { modelId: 'gpt-test-2026-01-01' },
    };
    let providerSignal: AbortSignal | undefined;
    let resolveProvider = (_value: unknown): void => {};
    const providerResult = new Promise<unknown>((resolve) => {
      resolveProvider = resolve;
    });
    const generateText = vi.fn((input: unknown) => {
      providerSignal = (input as Record<string, unknown>)['abortSignal'] as AbortSignal;
      return providerResult;
    });
    _setControlledAiFunctionsForTests({ generateText });
    installFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });

    const pending = controlledGenerateText(request({ abortSignal: controller.signal }));
    await vi.waitFor(() => expect(generateText).toHaveBeenCalledTimes(1));
    expect(providerSignal).toBeInstanceOf(AbortSignal);
    expect(providerSignal).not.toBe(controller.signal);
    Object.defineProperty(controller.signal, 'reason', {
      value: 'masked',
      configurable: true,
    });
    controller.abort('real abort');
    expect(providerSignal?.aborted).toBe(true);
    expect(providerSignal?.reason).toBe('real abort');
    resolveProvider(result);
    await expect(pending).resolves.toBe(result);
  });

  it.each([
    { usage: undefined, response: { modelId: 'gpt-test-2026-01-01' } },
    {
      usage: usage({ inputTokenDetails: { cacheReadTokens: 1, cacheWriteTokens: 0 } }),
      response: { modelId: 'gpt-test-2026-01-01' },
    },
    { usage: usage(), response: { modelId: 'different-model' } },
    { usage: usage({ inputTokens: -1 }), response: { modelId: 'gpt-test-2026-01-01' } },
    {
      usage: usage({
        raw: { prompt_tokens_details: { cached_tokens: 1 } },
      }),
      response: { modelId: 'gpt-test-2026-01-01' },
    },
    {
      usage: usage({
        raw: {
          prompt_tokens: 8,
          completion_tokens: 4,
          total_tokens: 12,
          prompt_tokens_details: { audio_tokens: 1 },
        },
      }),
      response: { modelId: 'gpt-test-2026-01-01' },
    },
    {
      usage: usage({
        outputTokenDetails: { textTokens: 4, reasoningTokens: 0, audioTokens: 1 },
      }),
      response: { modelId: 'gpt-test-2026-01-01' },
    },
    {
      usage: usage({
        raw: {
          prompt_tokens: 8,
          completion_tokens: 4,
          total_tokens: 12,
          unknown_metered_usage: { premium_units: 1 },
        },
      }),
      response: { modelId: 'gpt-test-2026-01-01' },
    },
    {
      usage: usage(),
      providerMetadata: { openai: { serviceTier: 'default', audioTokens: 1 } },
      response: { modelId: 'gpt-test-2026-01-01' },
    },
    {
      usage: usage(),
      providerMetadata: { openai: { serviceTier: 'default', premium_units: 1 } },
      response: { modelId: 'gpt-test-2026-01-01' },
    },
    {
      usage: usage({ unknown_zero_usage: cyclicZeroEvidence }),
      response: { modelId: 'gpt-test-2026-01-01' },
    },
    {
      usage: usage({ unknown_zero_usage: oversizedZeroArray }),
      response: { modelId: 'gpt-test-2026-01-01' },
    },
    {
      usage: usage({ unknown_zero_usage: oversizedSparseArray }),
      response: { modelId: 'gpt-test-2026-01-01' },
    },
    {
      usage: usage({ unknown_zero_usage: oversizedZeroRecord }),
      response: { modelId: 'gpt-test-2026-01-01' },
    },
    {
      usage: usage({ unknown_zero_usage: tooDeepZeroEvidence }),
      response: { modelId: 'gpt-test-2026-01-01' },
    },
    {
      usage: oversizedUsageRecord,
      response: { modelId: 'gpt-test-2026-01-01' },
    },
    {
      usage: usage({ inputTokenDetails: oversizedUsageDetails }),
      response: { modelId: 'gpt-test-2026-01-01' },
    },
    {
      usage: usage({ totalTokens: 13 }),
      response: { modelId: 'gpt-test-2026-01-01' },
    },
    {
      usage: usage({ reasoningTokens: 5 }),
      response: { modelId: 'gpt-test-2026-01-01' },
    },
    {
      usage: usage({ inputTokenDetails: { noCacheTokens: 9 } }),
      response: { modelId: 'gpt-test-2026-01-01' },
    },
    {
      usage: usage({ outputTokenDetails: { reasoningTokens: 5 } }),
      response: { modelId: 'gpt-test-2026-01-01' },
    },
    {
      usage: usage({ raw: { prompt_tokens: 9 } }),
      response: { modelId: 'gpt-test-2026-01-01' },
    },
    {
      usage: usage({ raw: { completion_tokens: 5 } }),
      response: { modelId: 'gpt-test-2026-01-01' },
    },
    {
      usage: usage({ raw: { total_tokens: 13 } }),
      response: { modelId: 'gpt-test-2026-01-01' },
    },
    {
      usage: usage({ raw: { completion_tokens_details: { reasoning_tokens: 5 } } }),
      response: { modelId: 'gpt-test-2026-01-01' },
    },
    {
      usage: usage(),
      providerMetadata: { openai: { serviceTier: 'default', acceptedPredictionTokens: 5 } },
      response: { modelId: 'gpt-test-2026-01-01' },
    },
    {
      usage: usage(),
      providerMetadata: {
        openai: { serviceTier: 'default', service_tier: 'priority' },
      },
      response: { modelId: 'gpt-test-2026-01-01' },
    },
  ])('returns successful generateText result unchanged on unsafe evidence %#', async (result) => {
    const fetchSpy = installFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    _setControlledAiFunctionsForTests({ generateText: async () => result });
    await expect(controlledGenerateText(request())).resolves.toBe(result);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(false);
  });

  it('commits documented base usage with nonbilling metadata and preserves hostile results unresolved', async () => {
    const safeFetch = installFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const safeResult = {
      text: 'answer',
      usage: usage({
        totalTokens: 12,
        reasoningTokens: 2,
        inputTokenDetails: { noCacheTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 },
        outputTokenDetails: { textTokens: 2, reasoningTokens: 2 },
        raw: {
          prompt_tokens: 8,
          completion_tokens: 4,
          total_tokens: 12,
          prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0, audio_tokens: 0 },
          completion_tokens_details: {
            accepted_prediction_tokens: 1,
            reasoning_tokens: 2,
            rejected_prediction_tokens: 1,
            audio_tokens: 0,
          },
        },
      }),
      providerMetadata: {
        openai: {
          serviceTier: 'default',
          responseId: 'resp_nonbilling',
          systemFingerprint: 'fp_nonbilling',
          acceptedPredictionTokens: 1,
        },
      },
      response: { modelId: 'gpt-test-2026-01-01' },
    };
    _setControlledAiFunctionsForTests({ generateText: async () => safeResult });
    await expect(controlledGenerateText(request())).resolves.toBe(safeResult);
    expect(safeFetch.mock.calls.filter(([url]) => String(url).endsWith('/commit'))).toHaveLength(1);

    vi.restoreAllMocks();
    reset();
    const hostileFetch = installFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const hostileResult = {
      text: 'provider answer',
      response: { modelId: 'gpt-test-2026-01-01' },
      get usage(): unknown {
        throw new Error('hostile usage getter');
      },
    };
    _setControlledAiFunctionsForTests({ generateText: async () => hostileResult });
    await expect(controlledGenerateText(request())).resolves.toBe(hostileResult);
    expect(hostileFetch.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(false);
  });

  it('keeps legacy streamText synchronous while strict controlledStreamText is explicitly async', async () => {
    const fetchSpy = installFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    let captured: Record<string, unknown> | null = null;
    const streamResult = { textStream: 'native-stream-result' };
    _setControlledAiFunctionsForTests({
      streamText: (input) => {
        captured = input as Record<string, unknown>;
        return streamResult;
      },
    });
    const userFinish = vi.fn();
    const pending = controlledStreamText(request({ onFinish: userFinish }));
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).resolves.toBe(streamResult);
    expect(captured).toMatchObject({ maxRetries: 0 });
    const onFinish = captured?.['onFinish'] as ((event: unknown) => unknown) | undefined;
    onFinish?.({
      totalUsage: usage(),
      providerMetadata: { openai: { serviceTier: 'default' } },
      response: { modelId: 'gpt-test-2026-01-01' },
    });
    expect(userFinish).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(true);
    });
  });

  it('stops an owned stream on abort and ignores any later finish settlement evidence', async () => {
    const fetchSpy = installFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    let captured: Record<string, unknown> | null = null;
    _setControlledAiFunctionsForTests({
      streamText: (input) => {
        captured = input as Record<string, unknown>;
        return { textStream: 'native-stream-result' };
      },
    });
    await controlledStreamText(request());
    const onAbort = captured?.['onAbort'] as ((event: unknown) => unknown) | undefined;
    const onFinish = captured?.['onFinish'] as ((event: unknown) => unknown) | undefined;
    onAbort?.({ reason: 'caller_abort' });
    onFinish?.({
      totalUsage: usage(),
      providerMetadata: { openai: { serviceTier: 'default' } },
      response: { modelId: 'gpt-test-2026-01-01' },
    });
    await Promise.resolve();
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(false);
    expect(bufferSize()).toBe(0);
  });

  it('stops heartbeat immediately on caller abort and fences late chunks without terminal callbacks', async () => {
    vi.useFakeTimers();
    const fetchSpy = installFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const controller = new AbortController();
    const userOnChunk = vi.fn();
    let captured: Record<string, unknown> | null = null;
    _setControlledAiFunctionsForTests({
      streamText: (input) => {
        captured = input as Record<string, unknown>;
        return { textStream: 'native-stream-result' };
      },
    });
    await controlledStreamText(request({ abortSignal: controller.signal, onChunk: userOnChunk }));
    const onChunk = captured?.['onChunk'] as ((event: unknown) => unknown) | undefined;
    await onChunk?.({ type: 'text-delta' });
    await vi.advanceTimersByTimeAsync(100_000);
    const extensionCount = () =>
      fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/extend')).length;
    expect(extensionCount()).toBeGreaterThan(0);

    controller.abort(new DOMException('caller stopped', 'AbortError'));
    const extensionsAtAbort = extensionCount();
    await vi.advanceTimersByTimeAsync(500_000);
    expect(extensionCount()).toBe(extensionsAtAbort);

    await onChunk?.({ type: 'late-text-delta' });
    await vi.advanceTimersByTimeAsync(500_000);
    expect(extensionCount()).toBe(extensionsAtAbort);
    expect(userOnChunk).toHaveBeenCalledTimes(1);
  });

  it('aborts idempotently before propagating an unexpected native reader rejection', async () => {
    const fetchSpy = installFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const nativeReadError = new Error('native reader failed');
    const order: string[] = [];
    let providerAbortCount = 0;
    const nativeResult = Object.create({
      get textStream(): ReadableStream<unknown> {
        return new ReadableStream({
          pull(controller) {
            controller.error(nativeReadError);
          },
        });
      },
    }) as { readonly textStream: ReadableStream<unknown> };
    _setControlledAiFunctionsForTests({
      streamText: (input) => {
        const signal = (input as Record<string, unknown>)['abortSignal'] as AbortSignal;
        signal.addEventListener(
          'abort',
          () => {
            providerAbortCount += 1;
            order.push('abort');
          },
          { once: true },
        );
        return nativeResult;
      },
    });

    const result = await controlledStreamText<typeof nativeResult>(request());
    await expect(result.textStream.getReader().read()).rejects.toBe(nativeReadError);
    order.push('rejected');
    await expect(result.textStream.getReader().read()).rejects.toBe(nativeReadError);

    expect(order).toEqual(['abort', 'rejected']);
    expect(providerAbortCount).toBe(1);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(false);
  });

  it('stops heartbeat and unlinks caller abort on native EOF without an SDK terminal callback', async () => {
    vi.useFakeTimers();
    const fetchSpy = installFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const controller = new AbortController();
    let providerAbortCount = 0;
    const nativeResult = Object.create({
      get textStream(): ReadableStream<unknown> {
        return new ReadableStream({
          start(streamController) {
            streamController.close();
          },
        });
      },
    }) as { readonly textStream: ReadableStream<unknown> };
    _setControlledAiFunctionsForTests({
      streamText: (input) => {
        const signal = (input as Record<string, unknown>)['abortSignal'] as AbortSignal;
        signal.addEventListener('abort', () => {
          providerAbortCount += 1;
        });
        return nativeResult;
      },
    });

    const result = await controlledStreamText<typeof nativeResult>(
      request({ abortSignal: controller.signal }),
    );
    await expect(result.textStream.getReader().read()).resolves.toMatchObject({ done: true });
    expect(vi.getTimerCount()).toBe(0);
    controller.abort(new DOMException('late caller abort', 'AbortError'));
    expect(providerAbortCount).toBe(0);

    await vi.advanceTimersByTimeAsync(500_000);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/extend'))).toBe(false);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(false);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/release'))).toBe(false);
  });

  it('replays exactly one legacy terminal when abort fires synchronously during dispatch', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ prices: [] }));
    init({ apiKey: KEY, control: { mode: 'legacy' } });
    const controller = new AbortController();
    const userOnAbort = vi.fn();
    const nativeResult = { textStream: 'native-stream-result' };
    _setControlledAiFunctionsForTests({
      streamText: (input) => {
        controller.abort(new DOMException('sync caller abort', 'AbortError'));
        const onAbort = (input as Record<string, unknown>)['onAbort'] as
          | ((event: unknown) => unknown)
          | undefined;
        onAbort?.({ reason: 'sync provider abort' });
        return nativeResult;
      },
    });

    await expect(
      controlledStreamText(request({ abortSignal: controller.signal, onAbort: userOnAbort })),
    ).resolves.toBe(nativeResult);
    await vi.waitFor(() => expect(bufferSize()).toBe(1));
    expect(userOnAbort).toHaveBeenCalledTimes(1);
  });

  it('preserves stream finish callbacks while audio, unknown, and hostile evidence stay unresolved', async () => {
    const unsafeEvents: unknown[] = [
      {
        totalUsage: usage({
          raw: {
            prompt_tokens: 8,
            completion_tokens: 4,
            total_tokens: 12,
            completion_tokens_details: { audio_tokens: 1 },
          },
        }),
        providerMetadata: { openai: { serviceTier: 'default' } },
        response: { modelId: 'gpt-test-2026-01-01' },
      },
      {
        totalUsage: usage({ unknown_paid_usage: { units: 1 } }),
        providerMetadata: { openai: { serviceTier: 'default' } },
        response: { modelId: 'gpt-test-2026-01-01' },
      },
    ];

    for (const event of unsafeEvents) {
      reset();
      const fetchSpy = installFetch();
      init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
      let captured: Record<string, unknown> | null = null;
      const userFinish = vi.fn();
      const streamResult = { textStream: 'provider stream' };
      _setControlledAiFunctionsForTests({
        streamText: (input) => {
          captured = input as Record<string, unknown>;
          return streamResult;
        },
      });
      await expect(controlledStreamText(request({ onFinish: userFinish }))).resolves.toBe(
        streamResult,
      );
      const finish = captured?.['onFinish'] as ((value: unknown) => unknown) | undefined;
      expect(() => finish?.(event)).not.toThrow();
      expect(userFinish).toHaveBeenCalledWith(event);
      await Promise.resolve();
      expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(false);
      vi.restoreAllMocks();
    }

    reset();
    const hostileFetch = installFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    let captured: Record<string, unknown> | null = null;
    const userFinish = vi.fn();
    _setControlledAiFunctionsForTests({
      streamText: (input) => {
        captured = input as Record<string, unknown>;
        return { textStream: 'provider stream' };
      },
    });
    await controlledStreamText(request({ onFinish: userFinish }));
    const hostileEvent = {
      response: { modelId: 'gpt-test-2026-01-01' },
      get totalUsage(): unknown {
        throw new Error('hostile finish usage getter');
      },
    };
    const finish = captured?.['onFinish'] as ((value: unknown) => unknown) | undefined;
    expect(() => finish?.(hostileEvent)).not.toThrow();
    expect(userFinish).toHaveBeenCalledTimes(1);
    expect(userFinish.mock.calls[0]?.[0]).toBe(hostileEvent);
    await Promise.resolve();
    expect(hostileFetch.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(false);
  });

  it('refuses tools, media-like messages, multi-step hooks, retry overrides, and tiers before dispatch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const generateText = vi.fn();
    _setControlledAiFunctionsForTests({ generateText });
    for (const invalid of [
      request({ tools: {} }),
      request({ prepareStep: () => ({}) }),
      request({ stopWhen: () => true }),
      request({ maxRetries: 1 }),
      request({ providerOptions: { openai: { serviceTier: 'priority' } } }),
      request({ prompt: 1, messages: [{ role: 'user', content: 'private' }] }),
      request({ prompt: 'private', messages: { role: 'user', content: 'private' } }),
      request({
        prompt: undefined,
        messages: [{ role: 'user', content: [{ type: 'image', image: 'private' }] }],
      }),
    ]) {
      await expect(controlledGenerateText(invalid)).rejects.toMatchObject({
        code: 'strict_provider_unsupported',
        provider: 'vercel-ai',
      });
    }
    expect(generateText).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('calls the provider zero times when enforce-deny control is unavailable', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 404 }));
    init({
      apiKey: KEY,
      endpoint: 'https://control.test',
      control: { mode: 'enforce', onUnavailable: 'deny' },
    });
    const generateText = vi.fn();
    _setControlledAiFunctionsForTests({ generateText });

    await expect(controlledGenerateText(request())).rejects.toMatchObject({
      name: 'PylvaControlUnavailableError',
    });
    expect(generateText).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('calls the provider zero times on an authoritative budget denial', async () => {
    const fetchSpy = installFetch({ reserveDecision: 'denied' });
    init({
      apiKey: KEY,
      endpoint: 'https://control.test',
      control: { mode: 'enforce', onUnavailable: 'deny' },
    });
    const generateText = vi.fn();
    _setControlledAiFunctionsForTests({ generateText });

    await expect(controlledGenerateText(request())).rejects.toMatchObject({
      name: 'PylvaBudgetExceeded',
    });
    expect(generateText).not.toHaveBeenCalled();
    expect(
      fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/reservations')),
    ).toHaveLength(1);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(false);
  });

  it('links the reserved operation and releases it when abort wins before dispatch', async () => {
    const controller = new AbortController();
    const fetchSpy = installFetch({
      afterReserve: () =>
        controller.abort(new DOMException('caller stopped before dispatch', 'AbortError')),
    });
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const generateText = vi.fn();
    _setControlledAiFunctionsForTests({ generateText });
    let callback: ReturnType<typeof registerControlledCallback> = null;

    await withControlledCallbackScope(async () => {
      callback = registerControlledCallback('llm');
      await expect(
        controlledGenerateText(request({ abortSignal: controller.signal })),
      ).rejects.toMatchObject({ reason: 'request_aborted_before_provider_dispatch' });
    });

    const reserveCall = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/reservations'));
    const reservedOperationId = String(JSON.parse(String(reserveCall?.[1]?.body))['operation_id']);
    expect(callback?.controlledNoDispatch?.operationId).toBe(reservedOperationId);
    expect(generateText).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/release'))).toHaveLength(1);
  });

  it('emits one legacy terminal event for repeated stream callbacks and sync dispatch errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ prices: [] }));
    init({ apiKey: KEY, control: { mode: 'legacy' } });
    let captured: Record<string, unknown> | null = null;
    _setControlledAiFunctionsForTests({
      streamText: (input) => {
        captured = input as Record<string, unknown>;
        return { textStream: 'legacy' };
      },
    });
    await controlledStreamText(request());
    const finish = captured?.['onFinish'] as ((event: unknown) => void) | undefined;
    const terminal = {
      totalUsage: usage(),
      providerMetadata: { openai: { serviceTier: 'default' } },
      response: { modelId: 'gpt-test-2026-01-01' },
    };
    finish?.(terminal);
    finish?.(terminal);
    await vi.waitFor(() => expect(bufferSize()).toBe(1));

    reset();
    init({ apiKey: KEY, control: { mode: 'legacy' } });
    const originalError = new Error('synchronous ai failure');
    _setControlledAiFunctionsForTests({
      generateText: () => {
        throw originalError;
      },
    });
    await expect(controlledGenerateText(request())).rejects.toBe(originalError);
    expect(bufferSize()).toBe(1);
  });
});
