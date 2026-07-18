import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { getEventListeners } from 'node:events';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetConfigForTests, init } from '../src/core/config.js';
import { _resetControlClientForTests } from '../src/core/control_client.js';
import { _resetTelemetryForTests } from '../src/core/telemetry.js';
import { wrapAnthropic } from '../src/wrappers/anthropic_controlled.js';
import { wrapOpenAI } from '../src/wrappers/openai_controlled.js';
import { registerPatchedOriginal } from '../src/wrappers/_strict_unwrap.js';

const KEY = `pv_live_aabbccdd_${'a'.repeat(32)}`;
const RESERVATION_ID = '44444444-4444-4444-8444-444444444444';
const activeServers: Array<{ close(): void }> = [];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req_official' },
  });
}

async function hrefAndBody(
  input: string | URL | Request,
  request?: RequestInit,
): Promise<{ href: string; body: string; headers: Headers }> {
  if (input instanceof Request) {
    return { href: input.url, body: await input.clone().text(), headers: input.headers };
  }
  return {
    href: String(input),
    body: request?.body == null ? '' : String(request.body),
    headers: new Headers(request?.headers),
  };
}

function installFetch(
  provider: (href: string, body: string) => Response | undefined,
  onReserve?: () => void | Promise<void>,
) {
  let operationId = '';
  const providerBodies: unknown[] = [];
  const providerHeaders: Headers[] = [];
  const commits: unknown[] = [];
  const order: string[] = [];
  const recordProvider = (href: string, body: string, headers: Headers): Response | undefined => {
    const response = provider(href, body);
    if (response !== undefined) {
      order.push('provider');
      providerBodies.push(JSON.parse(body));
      providerHeaders.push(headers);
    }
    return response;
  };
  const server = setupServer(
    ...['https://api.openai.com/v1/chat/completions', 'https://api.anthropic.com/v1/messages'].map(
      (url) =>
        http.post(url, async ({ request }) => {
          const body = await request.text();
          const response = recordProvider(request.url, body, request.headers);
          if (response === undefined) {
            return HttpResponse.json({ error: 'unexpected provider request' }, { status: 500 });
          }
          return new HttpResponse(await response.arrayBuffer(), {
            status: response.status,
            headers: response.headers,
          });
        }),
    ),
  );
  server.listen({ onUnhandledRequest: 'error' });
  activeServers.push(server);
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, request) => {
    const { href, body, headers } = await hrefAndBody(input, request);
    if (href.endsWith('/api/v1/budget/capabilities')) {
      return json({
        schema_version: '1.0',
        control_enabled: true,
        min_reservation_ttl_seconds: 30,
        default_reservation_ttl_seconds: 300,
        max_reservation_ttl_seconds: 3600,
        server_time: '2026-07-14T09:00:00.000Z',
      });
    }
    if (href.endsWith('/api/v1/budget/reservations')) {
      order.push('reserve');
      const reserve = JSON.parse(body) as Record<string, unknown>;
      operationId = String(reserve['operation_id']);
      expect(body).not.toContain('private provider prompt');
      await onReserve?.();
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
      commits.push(JSON.parse(body));
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
    const response = recordProvider(href, body, headers);
    if (response !== undefined) {
      return response;
    }
    throw new Error(`unexpected fetch: ${href}`);
  });
  return { spy, providerBodies, providerHeaders, commits, order };
}

type OfficialProvider = 'openai' | 'anthropic';
type CancellationKind = 'controller' | 'signal' | 'close';
type OfficialControlledStream = AsyncIterable<unknown> & {
  readonly controller: AbortController;
};

function expectNoRawIterator(stream: OfficialControlledStream): void {
  const prototype = Object.getPrototypeOf(stream) as Record<PropertyKey, unknown>;
  expect(Reflect.ownKeys(stream)).toEqual(['controller']);
  expect('iterator' in stream).toBe(false);
  expect(Object.getOwnPropertyDescriptor(stream, 'iterator')).toBeUndefined();
  expect((stream as unknown as Record<string, unknown>)['iterator']).toBeUndefined();
  expect(typeof stream[Symbol.asyncIterator]).toBe('function');
  expect(() =>
    (prototype[Symbol.asyncIterator] as (this: unknown) => unknown).call(stream),
  ).toThrow();
}

function installIdleOfficialStreamFetch(provider: OfficialProvider) {
  let operationId = '';
  const extensions: Array<Record<string, unknown>> = [];
  const commits: Array<Record<string, unknown>> = [];
  const releases: Array<Record<string, unknown>> = [];
  const encoder = new TextEncoder();
  const openAiEvent = {
    id: 'chatcmpl_idle',
    object: 'chat.completion.chunk',
    created: 1_784_009_600,
    model: 'gpt-4o-mini',
    service_tier: 'default',
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', content: 'first' },
        finish_reason: null,
        logprobs: null,
      },
    ],
  };
  const anthropicEvent = {
    type: 'message_start',
    message: {
      id: 'msg_idle',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 8,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: null,
        service_tier: 'standard',
      },
    },
  };
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, request) => {
    const { href, body } = await hrefAndBody(input, request);
    if (href.endsWith('/api/v1/budget/capabilities')) {
      return json({
        schema_version: '1.0',
        control_enabled: true,
        min_reservation_ttl_seconds: 30,
        default_reservation_ttl_seconds: 300,
        max_reservation_ttl_seconds: 3600,
        server_time: '2026-07-14T09:00:00.000Z',
      });
    }
    if (href.endsWith('/api/v1/budget/reservations')) {
      const reserve = JSON.parse(body) as Record<string, unknown>;
      operationId = String(reserve['operation_id']);
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
    if (href.endsWith('/extend')) {
      const extension = JSON.parse(body) as Record<string, unknown>;
      extensions.push(extension);
      return json({
        schema_version: '1.0',
        state: 'reserved',
        reservation_id: RESERVATION_ID,
        operation_id: operationId,
        extension_id: extension['extension_id'],
        expires_at: '2026-07-14T09:10:00.000Z',
        idempotent_replay: false,
      });
    }
    if (href.endsWith('/commit')) {
      commits.push(JSON.parse(body) as Record<string, unknown>);
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
      releases.push(JSON.parse(body) as Record<string, unknown>);
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
    const providerUrl =
      provider === 'openai'
        ? 'https://api.openai.com/v1/chat/completions'
        : 'https://api.anthropic.com/v1/messages';
    if (href === providerUrl) {
      const signal = input instanceof Request ? input.signal : request?.signal;
      const event =
        provider === 'openai'
          ? `data: ${JSON.stringify(openAiEvent)}\n\n`
          : `event: message_start\ndata: ${JSON.stringify(anthropicEvent)}\n\n`;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(event));
            signal?.addEventListener(
              'abort',
              () => controller.error(signal.reason ?? new DOMException('aborted', 'AbortError')),
              { once: true },
            );
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }
    throw new Error(`unexpected fetch: ${href}`);
  });
  return { spy, extensions, commits, releases };
}

function reset(): void {
  _resetControlClientForTests();
  _resetTelemetryForTests();
  _resetConfigForTests();
}

describe('controlled official provider SDK integration', () => {
  beforeEach(reset);
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const server of activeServers.splice(0)) server.close();
    reset();
  });

  it('preserves a real OpenAI APIPromise and commits exact Chat Completions usage', async () => {
    const model = 'gpt-4o-mini';
    const { providerBodies, commits, order } = installFetch((href) => {
      if (href !== 'https://api.openai.com/v1/chat/completions') return undefined;
      return json({
        id: 'chatcmpl_official',
        object: 'chat.completion',
        created: 1_784_009_600,
        model,
        service_tier: 'default',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'official answer', refusal: null },
            finish_reason: 'stop',
            logprobs: null,
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 4,
          total_tokens: 12,
          prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        },
      });
    });
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const client = await wrapOpenAI(new OpenAI({ apiKey: 'provider-test-key', maxRetries: 0 }));

    const pending = client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'private provider prompt' }],
      max_completion_tokens: 20,
    });
    expect(typeof pending.asResponse).toBe('function');
    expect(typeof pending.withResponse).toBe('function');
    const { data, response } = await pending.withResponse();

    expect(data.model).toBe(model);
    expect(response.headers.get('x-request-id')).toBe('req_official');
    expect(providerBodies).toHaveLength(1);
    expect(providerBodies[0]).toMatchObject({
      model,
      n: 1,
      service_tier: 'default',
    });
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ actual_input_tokens: 8, actual_output_tokens: 4 });
    const reserveOrder = order.indexOf('reserve');
    const providerOrder = order.indexOf('provider');
    expect(providerOrder).toBeGreaterThan(reserveOrder);
  });

  it('preserves real Anthropic messages.stream(), its helper header, and exact settlement', async () => {
    const model = 'claude-sonnet-4-5';
    const sse = [
      {
        type: 'message_start',
        message: {
          id: 'msg_official',
          type: 'message',
          role: 'assistant',
          model,
          container: null,
          content: [],
          stop_details: null,
          stop_reason: null,
          stop_sequence: null,
          usage: {
            cache_creation: null,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            inference_geo: null,
            input_tokens: 8,
            output_tokens: 1,
            server_tool_use: null,
            service_tier: 'standard',
          },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: {
          container: null,
          stop_details: null,
          stop_reason: 'end_turn',
          stop_sequence: null,
        },
        usage: {
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          input_tokens: 8,
          output_tokens: 4,
          server_tool_use: null,
        },
      },
      { type: 'message_stop' },
    ]
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join('');
    const { providerBodies, providerHeaders, commits } = installFetch((href) => {
      if (href !== 'https://api.anthropic.com/v1/messages') return undefined;
      return new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'request-id': 'req_anthropic' },
      });
    });
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const client = await wrapAnthropic(
      new Anthropic({ apiKey: 'provider-test-key', maxRetries: 0 }),
    );

    const stream = client.messages.stream({
      model,
      messages: [{ role: 'user', content: 'private provider prompt' }],
      max_tokens: 20,
    });
    expect(stream).not.toBeInstanceOf(Promise);
    const message = await stream.finalMessage();

    expect(message.model).toBe(model);
    expect(message.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(providerBodies).toHaveLength(1);
    expect(providerBodies[0]).toMatchObject({
      model,
      stream: true,
      service_tier: 'standard_only',
    });
    expect(providerHeaders[0]?.get('x-stainless-helper-method')).toBe('stream');
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ actual_input_tokens: 8, actual_output_tokens: 4 });
  });

  it.each([
    ['openai', 'controller'],
    ['openai', 'signal'],
    ['openai', 'close'],
    ['anthropic', 'controller'],
    ['anthropic', 'signal'],
    ['anthropic', 'close'],
  ] as const)(
    'stops an idle official %s stream heartbeat on %s without settling',
    async (provider: OfficialProvider, cancellation: CancellationKind) => {
      vi.useFakeTimers();
      const control = installIdleOfficialStreamFetch(provider);
      init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
      const callerController = new AbortController();
      const heartbeat = {
        reservationTtlSeconds: 30,
        heartbeatIntervalMs: 1_000,
        heartbeatExtendBySeconds: 30,
      };
      let facade: { close(): unknown };
      let stream: OfficialControlledStream;
      if (provider === 'openai') {
        const client = await wrapOpenAI(
          new OpenAI({ apiKey: 'provider-test-key', maxRetries: 0 }),
          heartbeat,
        );
        facade = client;
        stream = (await client.chat.completions.create(
          {
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: 'private provider prompt' }],
            max_completion_tokens: 20,
            stream: true,
          },
          cancellation === 'signal' ? { signal: callerController.signal } : undefined,
        )) as typeof stream;
      } else {
        const client = await wrapAnthropic(
          new Anthropic({ apiKey: 'provider-test-key', maxRetries: 0 }),
          heartbeat,
        );
        facade = client;
        stream = (await client.messages.create(
          {
            model: 'claude-sonnet-4-5',
            messages: [{ role: 'user', content: 'private provider prompt' }],
            max_tokens: 20,
            stream: true,
          },
          cancellation === 'signal' ? { signal: callerController.signal } : undefined,
        )) as typeof stream;
      }

      expectNoRawIterator(stream);
      const nativeController = stream.controller;
      expect(Object.getPrototypeOf(nativeController)).toBe(AbortController.prototype);
      const observedSignal =
        cancellation === 'signal' ? callerController.signal : nativeController.signal;
      const listenersBeforePull = getEventListeners(observedSignal, 'abort').length;
      const iterator = stream[Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toMatchObject({ done: false });
      const listenersWhileIdle = getEventListeners(observedSignal, 'abort').length;
      expect(listenersWhileIdle).toBeGreaterThan(listenersBeforePull);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(control.extensions).toHaveLength(1);

      if (cancellation === 'controller') nativeController.abort();
      else if (cancellation === 'signal') callerController.abort();
      else await Promise.resolve(facade.close());
      await Promise.resolve();

      const extensionsAfterCancellation = control.extensions.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(control.extensions).toHaveLength(extensionsAfterCancellation);
      expect(control.commits).toHaveLength(0);
      expect(control.releases).toHaveLength(0);
      expect(getEventListeners(observedSignal, 'abort').length).toBeLessThan(listenersWhileIdle);
      expect(stream.controller).toBe(nativeController);

      await iterator.return?.().catch(() => undefined);
      await Promise.resolve(facade.close());
      await Promise.resolve(facade.close());
      expect(control.commits).toHaveLength(0);
      expect(control.releases).toHaveLength(0);
    },
  );

  it.each(['openai', 'anthropic'] as const)(
    'hides the raw iterator of an official CommonJS %s stream',
    async (provider: OfficialProvider) => {
      const require = createRequire(import.meta.url);
      const control = installIdleOfficialStreamFetch(provider);
      init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
      let facade: { close(): unknown };
      let stream: OfficialControlledStream;
      if (provider === 'openai') {
        const module = require('openai') as { default?: typeof OpenAI; OpenAI?: typeof OpenAI };
        const Constructor = module.default ?? module.OpenAI;
        const client = await wrapOpenAI(
          new Constructor!({ apiKey: 'provider-test-key', maxRetries: 0 }),
        );
        facade = client;
        stream = (await client.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'private provider prompt' }],
          max_completion_tokens: 20,
          stream: true,
        })) as OfficialControlledStream;
      } else {
        const module = require('@anthropic-ai/sdk') as {
          default?: typeof Anthropic;
          Anthropic?: typeof Anthropic;
        };
        const Constructor = module.default ?? module.Anthropic;
        const client = await wrapAnthropic(
          new Constructor!({ apiKey: 'provider-test-key', maxRetries: 0 }),
        );
        facade = client;
        stream = (await client.messages.create({
          model: 'claude-sonnet-4-5',
          messages: [{ role: 'user', content: 'private provider prompt' }],
          max_tokens: 20,
          stream: true,
        })) as OfficialControlledStream;
      }

      expectNoRawIterator(stream);
      stream.controller.abort();
      await Promise.resolve(facade.close());
      expect(control.extensions).toHaveLength(0);
      expect(control.commits).toHaveLength(0);
      expect(control.releases).toHaveLength(0);
    },
  );

  it('preserves an official Anthropic response but leaves cache_creation detail unresolved', async () => {
    const model = 'claude-sonnet-4-5';
    const { providerBodies, commits } = installFetch((href) => {
      if (href !== 'https://api.anthropic.com/v1/messages') return undefined;
      return json({
        id: 'msg_paid_cache_detail',
        type: 'message',
        role: 'assistant',
        model,
        container: null,
        content: [{ type: 'text', text: 'provider answer' }],
        stop_details: null,
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          cache_creation: {
            ephemeral_1h_input_tokens: 0,
            ephemeral_5m_input_tokens: 1,
          },
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          inference_geo: null,
          input_tokens: 8,
          output_tokens: 4,
          server_tool_use: null,
          service_tier: 'standard',
        },
      });
    });
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const client = await wrapAnthropic(
      new Anthropic({ apiKey: 'provider-test-key', maxRetries: 0 }),
    );

    const response = await client.messages.create({
      model,
      messages: [{ role: 'user', content: 'private provider prompt' }],
      max_tokens: 20,
    });

    expect(response.content).toEqual([{ type: 'text', text: 'provider answer' }]);
    expect(providerBodies).toHaveLength(1);
    expect(commits).toHaveLength(0);
  });

  it('supports genuine CommonJS provider clients while dispatching through private ESM clients', async () => {
    const require = createRequire(import.meta.url);
    const openAiModule = require('openai') as {
      default?: typeof OpenAI;
      OpenAI?: typeof OpenAI;
    };
    const anthropicModule = require('@anthropic-ai/sdk') as {
      default?: typeof Anthropic;
      Anthropic?: typeof Anthropic;
    };
    const CommonJsOpenAI = openAiModule.default ?? openAiModule.OpenAI;
    const CommonJsAnthropic = anthropicModule.default ?? anthropicModule.Anthropic;
    expect(CommonJsOpenAI).toBeTypeOf('function');
    expect(CommonJsAnthropic).toBeTypeOf('function');

    const { providerBodies } = installFetch((href) => {
      if (href === 'https://api.openai.com/v1/chat/completions') {
        return json({
          id: 'chatcmpl_cjs',
          object: 'chat.completion',
          created: 1_784_009_600,
          model: 'gpt-4o-mini',
          service_tier: 'default',
          choices: [],
          usage: {
            prompt_tokens: 2,
            completion_tokens: 1,
            total_tokens: 3,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        });
      }
      if (href === 'https://api.anthropic.com/v1/messages') {
        return json({
          id: 'msg_cjs',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: 2,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            server_tool_use: null,
            service_tier: 'standard',
          },
        });
      }
      return undefined;
    });
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const openai = await wrapOpenAI(
      new CommonJsOpenAI!({ apiKey: 'provider-test-key', maxRetries: 0 }),
    );
    const anthropic = await wrapAnthropic(
      new CommonJsAnthropic!({ apiKey: 'provider-test-key', maxRetries: 0 }),
    );
    const cache = require.cache as Record<string, unknown>;
    const openAiPath = require.resolve('openai');
    const anthropicPath = require.resolve('@anthropic-ai/sdk');
    const originalOpenAIEntry = cache[openAiPath];
    const originalAnthropicEntry = cache[anthropicPath];
    let poisonedConstructors = 0;
    class PoisonedAfterCapture {
      constructor() {
        poisonedConstructors += 1;
      }
    }
    cache[openAiPath] = {
      exports: { default: PoisonedAfterCapture, OpenAI: PoisonedAfterCapture },
    };
    cache[anthropicPath] = {
      exports: { default: PoisonedAfterCapture, Anthropic: PoisonedAfterCapture },
    };
    try {
      await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'cjs prompt' }],
        max_completion_tokens: 2,
      });
      await anthropic.messages.create({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'cjs prompt' }],
        max_tokens: 2,
      });
    } finally {
      cache[openAiPath] = originalOpenAIEntry;
      cache[anthropicPath] = originalAnthropicEntry;
    }

    expect(providerBodies).toHaveLength(2);
    expect(providerBodies[0]).toMatchObject({ model: 'gpt-4o-mini' });
    expect(providerBodies[1]).toMatchObject({ model: 'claude-sonnet-4-5' });
    expect(poisonedConstructors).toBe(0);
    await openai.close();
    await anthropic.close();
  });

  it('never consults poisoned CommonJS caches or exposes a provider key to them', async () => {
    const require = createRequire(import.meta.url);
    const cache = require.cache as Record<string, unknown>;
    const openAiPath = require.resolve('openai');
    const anthropicPath = require.resolve('@anthropic-ai/sdk');
    const previousOpenAI = cache[openAiPath];
    const previousAnthropic = cache[anthropicPath];
    const capturedKeys: unknown[] = [];
    let credentialReads = 0;
    class PoisonOpenAI {
      constructor(options: Record<string, unknown>) {
        capturedKeys.push(options['apiKey']);
      }
    }
    class PoisonAnthropic {
      constructor(options: Record<string, unknown>) {
        capturedKeys.push(options['apiKey']);
      }
    }
    cache[openAiPath] = { exports: { default: PoisonOpenAI, OpenAI: PoisonOpenAI } };
    cache[anthropicPath] = {
      exports: { default: PoisonAnthropic, Anthropic: PoisonAnthropic },
    };
    try {
      const openai = await wrapOpenAI(new OpenAI({ apiKey: 'provider-test-key', maxRetries: 0 }));
      const anthropic = await wrapAnthropic(
        new Anthropic({ apiKey: 'provider-test-key', maxRetries: 0 }),
      );
      expect(capturedKeys).toEqual([]);
      const poisonedCandidate = Object.create(PoisonOpenAI.prototype) as object;
      Object.defineProperty(poisonedCandidate, 'apiKey', {
        get() {
          credentialReads += 1;
          return 'must-not-be-read';
        },
      });
      await expect(wrapOpenAI(poisonedCandidate)).rejects.toMatchObject({
        reason: 'invalid_client',
      });
      expect(credentialReads).toBe(0);
      await openai.close();
      await anthropic.close();
    } finally {
      if (previousOpenAI === undefined) delete cache[openAiPath];
      else cache[openAiPath] = previousOpenAI;
      if (previousAnthropic === undefined) delete cache[anthropicPath];
      else cache[anthropicPath] = previousAnthropic;
    }
  });

  it('rejects same-name structural clients before credentials, control, or provider I/O', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    let credentialReads = 0;
    class FakeCompletions {
      create(body: unknown): unknown {
        void body;
        return this._client.post('/chat/completions');
      }

      private readonly _client = { post: vi.fn() };
    }
    class OpenAI {
      static readonly Chat = class Chat {
        static readonly Completions = FakeCompletions;
      };
      readonly baseURL = 'https://api.openai.com/v1';
      readonly maxRetries = 0;
      readonly chat = { completions: new FakeCompletions() };
      get apiKey(): string {
        credentialReads += 1;
        return 'must-not-be-read';
      }
      withOptions(): void {}
      post(): void {}
      request(): void {}
      makeRequest(): void {}
      buildRequest(): void {}
    }
    class FakeMessages {
      create(body: unknown): unknown {
        void body;
        return this._client.post('/v1/messages');
      }

      stream(): void {}
      private readonly _client = { post: vi.fn() };
    }
    class Anthropic {
      static readonly Messages = FakeMessages;
      readonly baseURL = 'https://api.anthropic.com';
      readonly maxRetries = 0;
      readonly messages = new FakeMessages();
      get apiKey(): string {
        credentialReads += 1;
        return 'must-not-be-read';
      }
      withOptions(): void {}
      post(): void {}
      request(): void {}
      makeRequest(): void {}
      buildRequest(): void {}
    }

    await expect(wrapOpenAI(new OpenAI())).rejects.toMatchObject({ reason: 'invalid_client' });
    await expect(wrapAnthropic(new Anthropic())).rejects.toMatchObject({
      reason: 'invalid_client',
    });
    expect(credentialReads).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects own method overrides and accessors without invoking them or doing I/O', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    let accessorReads = 0;
    const ownUserAgent = new OpenAI({ apiKey: 'provider-test-key', maxRetries: 0 });
    Object.defineProperty(ownUserAgent, 'getUserAgent', { value: vi.fn() });
    await expect(wrapOpenAI(ownUserAgent)).rejects.toMatchObject({ reason: 'invalid_client' });

    const ownCreate = new OpenAI({ apiKey: 'provider-test-key', maxRetries: 0 });
    Object.defineProperty(ownCreate.chat.completions, 'create', { value: vi.fn() });
    await expect(wrapOpenAI(ownCreate)).rejects.toMatchObject({ reason: 'invalid_client' });

    const accessor = new Anthropic({ apiKey: 'provider-test-key', maxRetries: 0 });
    Object.defineProperty(accessor, 'baseURL', {
      configurable: true,
      get() {
        accessorReads += 1;
        return 'https://api.anthropic.com';
      },
    });
    await expect(wrapAnthropic(accessor)).rejects.toMatchObject({ reason: 'invalid_client' });

    const customFetch = new OpenAI({ apiKey: 'provider-test-key', maxRetries: 0 });
    const hostileFetch = vi.fn(() => Promise.reject(new Error('must not run')));
    Object.defineProperty(customFetch, 'fetch', { value: hostileFetch });
    await expect(wrapOpenAI(customFetch)).rejects.toMatchObject({
      reason: 'custom_client_transport_headers_or_query_are_unsupported',
    });

    const clonedSource = new OpenAI({ apiKey: 'provider-test-key', maxRetries: 0 });
    const defaultFetch = (clonedSource as unknown as { fetch: Function }).fetch;
    const sourceIdenticalFetch = runInNewContext(
      `(${Function.prototype.toString.call(defaultFetch)})`,
    ) as Function;
    expect(Function.prototype.toString.call(sourceIdenticalFetch)).toBe(
      Function.prototype.toString.call(defaultFetch),
    );
    expect(sourceIdenticalFetch).not.toBe(defaultFetch);
    Object.defineProperty(clonedSource, 'fetch', { value: sourceIdenticalFetch });
    await expect(wrapOpenAI(clonedSource)).rejects.toMatchObject({
      reason: 'custom_client_transport_headers_or_query_are_unsupported',
    });
    expect(accessorReads).toBe(0);
    expect(hostileFetch).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never re-reads or dispatches through caller-owned clients after wrapping', async () => {
    let openAiCaller: OpenAI;
    let anthropicCaller: Anthropic;
    const callerTransport = vi.fn(() => Promise.reject(new Error('caller transport used')));
    const callerCreate = vi.fn(() => Promise.reject(new Error('caller create used')));
    let mutated = false;
    const { providerBodies } = installFetch(
      (href) => {
        if (href === 'https://api.openai.com/v1/chat/completions') {
          return json({
            id: 'chatcmpl_isolated',
            object: 'chat.completion',
            created: 1_784_009_600,
            model: 'gpt-4o-mini',
            service_tier: 'default',
            choices: [],
            usage: {
              prompt_tokens: 2,
              completion_tokens: 1,
              total_tokens: 3,
              prompt_tokens_details: { cached_tokens: 0 },
            },
          });
        }
        if (href === 'https://api.anthropic.com/v1/messages') {
          return json({
            id: 'msg_isolated',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-4-5',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: {
              input_tokens: 2,
              output_tokens: 1,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              server_tool_use: null,
              service_tier: 'standard',
            },
          });
        }
        return undefined;
      },
      () => {
        if (mutated) return;
        mutated = true;
        Object.assign(openAiCaller, {
          apiKey: 'mutated',
          baseURL: 'https://attacker.invalid/v1',
          fetch: callerTransport,
          maxRetries: 99,
        });
        Object.defineProperty(openAiCaller.chat.completions, 'create', { value: callerCreate });
        Object.assign(anthropicCaller, {
          apiKey: 'mutated',
          baseURL: 'https://attacker.invalid',
          fetch: callerTransport,
          maxRetries: 99,
        });
        Object.defineProperty(anthropicCaller.messages, 'create', { value: callerCreate });
      },
    );
    openAiCaller = new OpenAI({ apiKey: 'provider-test-key', maxRetries: 0 });
    anthropicCaller = new Anthropic({ apiKey: 'provider-test-key', maxRetries: 0 });
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const openai = await wrapOpenAI(openAiCaller);
    const anthropic = await wrapAnthropic(anthropicCaller);

    await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'private provider prompt' }],
      max_completion_tokens: 2,
    });
    await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'private provider prompt' }],
      max_tokens: 2,
    });

    expect(providerBodies).toHaveLength(2);
    expect(callerTransport).not.toHaveBeenCalled();
    expect(callerCreate).not.toHaveBeenCalled();
  });

  it('exposes only the explicitly priced facade and fails closed under reflection', async () => {
    const openai = await wrapOpenAI(new OpenAI({ apiKey: 'provider-test-key', maxRetries: 0 }));
    const anthropic = await wrapAnthropic(
      new Anthropic({ apiKey: 'provider-test-key', maxRetries: 0 }),
    );
    expect(Object.getPrototypeOf(openai)).toBeNull();
    expect(Object.getPrototypeOf(openai.chat)).toBeNull();
    expect(Object.getPrototypeOf(openai.chat.completions)).toBeNull();
    expect(Object.getPrototypeOf(anthropic)).toBeNull();
    expect(Object.getPrototypeOf(anthropic.messages)).toBeNull();
    expect(Reflect.ownKeys(openai).filter((key) => typeof key === 'string')).toEqual([
      'chat',
      'maxRetries',
      'close',
    ]);
    expect(Reflect.ownKeys(openai)).toContain(Symbol.toStringTag);
    expect(
      Reflect.ownKeys(openai.chat.completions).filter((key) => typeof key === 'string'),
    ).toEqual(['create']);
    expect(Reflect.ownKeys(openai.chat.completions)).toContain(Symbol.toStringTag);
    expect(Reflect.ownKeys(anthropic.messages).filter((key) => typeof key === 'string')).toEqual([
      'create',
      'stream',
    ]);
    expect(Reflect.ownKeys(anthropic.messages)).toContain(Symbol.toStringTag);
    expect(() => (openai as unknown as Record<string, unknown>)['responses']).toThrow(
      'unsupported_pricing_feature',
    );
    expect(() => Object.getOwnPropertyDescriptor(openai, 'responses')).toThrow(
      'unsupported_pricing_feature',
    );
    expect(() => Reflect.set(openai, 'maxRetries', 1)).toThrow('unsupported_pricing_feature');
    expect(() => (anthropic.messages as unknown as Record<string, unknown>)['batches']).toThrow(
      'unsupported_pricing_feature',
    );
    await openai.close();
    await anthropic.close();
  });

  it('ignores a poisoned legacy unwrap registry and dispatches only via private post()', async () => {
    const prototype = OpenAI.Chat.Completions.prototype as unknown as Record<string, unknown>;
    const originalDescriptor = Object.getOwnPropertyDescriptor(prototype, 'create');
    expect(originalDescriptor && 'value' in originalDescriptor).toBe(true);
    let patchedCalls = 0;
    let poisonedCalls = 0;
    const poisoned = function poisoned(): Promise<never> {
      void "this._client.post('/chat/completions'";
      poisonedCalls += 1;
      return Promise.reject(new Error('poisoned unwrap invoked'));
    };
    const patched = function patched(): Promise<never> {
      patchedCalls += 1;
      return Promise.reject(new Error('legacy wrapper invoked'));
    };
    Object.defineProperty(patched, '__pylva_patched', { value: true });
    registerPatchedOriginal(patched, poisoned);
    Object.defineProperty(prototype, 'create', { ...originalDescriptor, value: patched });
    try {
      const { providerBodies } = installFetch((href) => {
        if (href !== 'https://api.openai.com/v1/chat/completions') return undefined;
        return json({
          id: 'chatcmpl_private_post',
          object: 'chat.completion',
          created: 1_784_009_600,
          model: 'gpt-4o-mini',
          service_tier: 'default',
          choices: [],
          usage: {
            prompt_tokens: 2,
            completion_tokens: 1,
            total_tokens: 3,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        });
      });
      init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
      const openai = await wrapOpenAI(new OpenAI({ apiKey: 'provider-test-key', maxRetries: 0 }));
      await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'private provider prompt' }],
        max_completion_tokens: 2,
      });
      expect(providerBodies).toHaveLength(1);
      expect(patchedCalls).toBe(0);
      expect(poisonedCalls).toBe(0);
    } finally {
      if (originalDescriptor !== undefined) {
        Object.defineProperty(prototype, 'create', originalDescriptor);
      }
    }
  });
});
