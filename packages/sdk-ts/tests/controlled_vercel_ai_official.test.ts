import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetConfigForTests, init } from '../src/core/config.js';
import { _resetControlClientForTests } from '../src/core/control_client.js';
import { _resetTelemetryForTests } from '../src/core/telemetry.js';
import { matchesExactRequest } from './helpers/url.js';
import {
  _resetVercelAiPatchForTests,
  type ControlledOpenAIChatModel,
  createControlledOpenAIChatModel,
  controlledGenerateText,
  controlledStreamText,
} from '../src/wrappers/vercel-ai.js';

const KEY = `pv_live_aabbccdd_${'a'.repeat(32)}`;
const MODEL = 'gpt-4o-mini';
const RESERVATION_ID = '44444444-4444-4444-8444-444444444444';

function matchesControlRequest(
  input: string | URL | Request,
  request: RequestInit | undefined,
  pathname: string,
  method: string,
): boolean {
  return matchesExactRequest(input, request, {
    origin: 'https://control.test',
    pathname,
    method,
  });
}

function isControlRequest(input: string | URL | Request, request?: RequestInit): boolean {
  return [
    { pathname: '/api/v1/budget/capabilities', method: 'GET' },
    { pathname: '/api/v1/budget/reservations', method: 'POST' },
    { pathname: `/api/v1/budget/reservations/${RESERVATION_ID}/commit`, method: 'POST' },
    { pathname: `/api/v1/budget/reservations/${RESERVATION_ID}/release`, method: 'POST' },
    { pathname: `/api/v1/budget/reservations/${RESERVATION_ID}/extend`, method: 'POST' },
  ].some(({ pathname, method }) => matchesControlRequest(input, request, pathname, method));
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req_official' },
  });
}

async function hrefAndBody(
  input: string | URL | Request,
  request?: RequestInit,
): Promise<{ href: string; body: string }> {
  if (input instanceof Request) {
    return { href: input.url, body: await input.clone().text() };
  }
  return { href: String(input), body: request?.body == null ? '' : String(request.body) };
}

function headersOf(input: string | URL | Request, request?: RequestInit): Record<string, string> {
  return Object.fromEntries(
    (input instanceof Request ? input.headers : new Headers(request?.headers)).entries(),
  );
}

function installOfficialFetch() {
  let operationId = '';
  const providerBodies: unknown[] = [];
  const providerHeaders: Array<Record<string, string>> = [];
  const controlBodies: string[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, request) => {
    const { href, body } = await hrefAndBody(input, request);
    if (isControlRequest(input, request)) controlBodies.push(body);
    if (matchesControlRequest(input, request, '/api/v1/budget/capabilities', 'GET')) {
      return json({
        schema_version: '1.0',
        control_enabled: true,
        min_reservation_ttl_seconds: 30,
        default_reservation_ttl_seconds: 300,
        max_reservation_ttl_seconds: 3600,
        server_time: '2026-07-14T09:00:00.000Z',
      });
    }
    if (matchesControlRequest(input, request, '/api/v1/budget/reservations', 'POST')) {
      const reserve = JSON.parse(body) as Record<string, unknown>;
      operationId = String(reserve['operation_id']);
      expect(reserve).toMatchObject({
        provider: 'openai',
        model: MODEL,
        kind: 'llm',
      });
      expect(body).not.toContain('private official prompt');
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
    if (
      matchesControlRequest(
        input,
        request,
        `/api/v1/budget/reservations/${RESERVATION_ID}/commit`,
        'POST',
      )
    ) {
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
    if (
      matchesExactRequest(input, request, {
        origin: 'https://api.openai.com',
        pathname: '/v1/chat/completions',
        method: 'POST',
      })
    ) {
      const providerBody = JSON.parse(body) as Record<string, unknown>;
      providerBodies.push(providerBody);
      providerHeaders.push(headersOf(input, request));
      return json({
        id: 'chatcmpl_official',
        object: 'chat.completion',
        created: 1_784_009_600,
        model: MODEL,
        service_tier: 'default',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'official answer' },
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
    }
    throw new Error(`unexpected fetch: ${href}`);
  });
  return { spy, providerBodies, providerHeaders, controlBodies };
}

type OfficialStreamResult = {
  readonly textStream: ReadableStream<string>;
  readonly fullStream: ReadableStream<unknown>;
  readonly text: PromiseLike<string>;
  readonly totalUsage: PromiseLike<{ inputTokens: number; outputTokens: number }>;
  toTextStreamResponse(): Response;
};

type OfficialStreamMode = 'complete' | 'open' | 'stalled';

function openAiChunk(content: string, finishReason: string | null = null, withUsage = false) {
  return {
    id: 'chatcmpl_stream_official',
    object: 'chat.completion.chunk',
    created: 1_784_009_600,
    model: MODEL,
    service_tier: 'default',
    choices: [
      {
        index: 0,
        delta: content.length > 0 ? { role: 'assistant', content } : {},
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    ...(withUsage
      ? {
          usage: {
            prompt_tokens: 8,
            completion_tokens: 4,
            total_tokens: 12,
            prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          },
        }
      : {}),
  };
}

function sse(...events: unknown[]): string {
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
}

function installOfficialStreamFetch(mode: OfficialStreamMode) {
  let operationId = '';
  let providerAbortCount = 0;
  let providerCancelCount = 0;
  const providerBodies: Array<Record<string, unknown>> = [];
  const providerHeaders: Array<Record<string, string>> = [];
  const controlBodies: string[] = [];
  const commits: Array<Record<string, unknown>> = [];
  const releases: Array<Record<string, unknown>> = [];
  const extensions: Array<Record<string, unknown>> = [];
  const encoder = new TextEncoder();
  const firstEvent = openAiChunk('official stream');
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, request) => {
    const { href, body } = await hrefAndBody(input, request);
    if (isControlRequest(input, request)) controlBodies.push(body);
    if (matchesControlRequest(input, request, '/api/v1/budget/capabilities', 'GET')) {
      return json({
        schema_version: '1.0',
        control_enabled: true,
        min_reservation_ttl_seconds: 30,
        default_reservation_ttl_seconds: 300,
        max_reservation_ttl_seconds: 3600,
        server_time: '2026-07-14T09:00:00.000Z',
      });
    }
    if (matchesControlRequest(input, request, '/api/v1/budget/reservations', 'POST')) {
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
    if (
      matchesControlRequest(
        input,
        request,
        `/api/v1/budget/reservations/${RESERVATION_ID}/commit`,
        'POST',
      )
    ) {
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
    if (
      matchesControlRequest(
        input,
        request,
        `/api/v1/budget/reservations/${RESERVATION_ID}/release`,
        'POST',
      )
    ) {
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
    if (
      matchesControlRequest(
        input,
        request,
        `/api/v1/budget/reservations/${RESERVATION_ID}/extend`,
        'POST',
      )
    ) {
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
    if (
      matchesExactRequest(input, request, {
        origin: 'https://api.openai.com',
        pathname: '/v1/chat/completions',
        method: 'POST',
      })
    ) {
      providerBodies.push(JSON.parse(body) as Record<string, unknown>);
      providerHeaders.push(headersOf(input, request));
      if (mode === 'complete') {
        return new Response(sse(firstEvent, openAiChunk('', 'stop', true)), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      const signal = input instanceof Request ? input.signal : request?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            if (mode === 'open') {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(firstEvent)}\n\n`));
            }
            signal?.addEventListener(
              'abort',
              () => {
                providerAbortCount += 1;
                if (mode !== 'stalled') {
                  controller.error(signal.reason ?? new DOMException('aborted', 'AbortError'));
                }
              },
              { once: true },
            );
          },
          cancel() {
            providerCancelCount += 1;
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }
    throw new Error(`unexpected fetch: ${href}`);
  });
  return {
    spy,
    providerBodies,
    providerHeaders,
    controlBodies,
    commits,
    releases,
    extensions,
    get providerAbortCount() {
      return providerAbortCount;
    },
    get providerCancelCount() {
      return providerCancelCount;
    },
  };
}

function officialStreamRequest(
  model: ControlledOpenAIChatModel,
  overrides: Record<string, unknown> = {},
) {
  return {
    model,
    prompt: 'private official prompt',
    maxOutputTokens: 20,
    maxRetries: 0,
    providerOptions: { openai: { serviceTier: 'default' } },
    ...overrides,
  };
}

async function officialModel(apiKey = 'provider-test-key'): Promise<ControlledOpenAIChatModel> {
  return await createControlledOpenAIChatModel({ apiKey, model: MODEL });
}

function reset(): void {
  _resetVercelAiPatchForTests();
  _resetControlClientForTests();
  _resetTelemetryForTests();
  _resetConfigForTests();
}

describe('controlled Vercel AI official provider integration', () => {
  beforeEach(reset);
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    reset();
  });

  it('controls an official OpenAI Chat model and commits its exact unified usage', async () => {
    const { spy, providerBodies } = installOfficialFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const model = await officialModel();

    const result = await controlledGenerateText({
      model,
      prompt: 'private official prompt',
      maxOutputTokens: 20,
      maxRetries: 0,
      providerOptions: { openai: { serviceTier: 'default' } },
    });

    expect((result as { text: string }).text).toBe('official answer');
    expect(providerBodies).toHaveLength(1);
    expect(providerBodies[0]).toMatchObject({
      model: MODEL,
      service_tier: 'default',
    });
    const reserveOrder = spy.mock.calls.findIndex(([input]) =>
      (input instanceof Request ? input.url : String(input)).endsWith('/reservations'),
    );
    const providerOrder = spy.mock.calls.findIndex(([input, request]) =>
      matchesExactRequest(input, request, {
        origin: 'https://api.openai.com',
        pathname: '/v1/chat/completions',
        method: 'POST',
      }),
    );
    expect(reserveOrder).toBeGreaterThanOrEqual(0);
    expect(providerOrder).toBeGreaterThan(reserveOrder);
    expect(
      spy.mock.calls.some(([input]) =>
        (input instanceof Request ? input.url : String(input)).endsWith('/commit'),
      ),
    ).toBe(true);
  });

  it('keeps the provider key and model private while preserving locked generate transport state', async () => {
    const harness = installOfficialFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const secret = 'provider-private-key-generate';
    const providerSettings = {
      apiKey: secret,
      model: MODEL,
    };
    const model = await createControlledOpenAIChatModel(providerSettings);
    providerSettings.apiKey = 'mutated-provider-key';
    providerSettings.model = 'mutated-model';

    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.getPrototypeOf(model)).toBeNull();
    expect(Reflect.ownKeys(model)).toEqual([]);
    expect(JSON.stringify(model)).toBe('{}');
    expect(JSON.stringify(model)).not.toContain(secret);

    await expect(
      controlledGenerateText({
        model,
        prompt: 'private official prompt',
        maxOutputTokens: 20,
        maxRetries: 0,
        providerOptions: { openai: { serviceTier: 'default' } },
      }),
    ).resolves.toMatchObject({ text: 'official answer' });
    expect(harness.providerBodies).toHaveLength(1);
    expect(harness.providerBodies[0]).toMatchObject({
      model: MODEL,
      service_tier: 'default',
    });
    expect(harness.providerHeaders[0]?.['authorization']).toBe(`Bearer ${secret}`);
    expect(harness.controlBodies).toHaveLength(3);
    expect(harness.controlBodies.join('\n')).not.toContain(secret);
  });

  it('preserves the native AI SDK 6 stream result and commits exact usage only at EOF', async () => {
    vi.useFakeTimers();
    const harness = installOfficialStreamFetch('complete');
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const model = await officialModel();

    const result = await controlledStreamText<OfficialStreamResult>(officialStreamRequest(model));

    expect(Object.getPrototypeOf(result)?.constructor?.name).toBe('DefaultStreamTextResult');
    expect(result.textStream).toBeInstanceOf(ReadableStream);
    expect(result.fullStream).toBeInstanceOf(ReadableStream);
    expect(typeof result.toTextStreamResponse).toBe('function');
    let text = '';
    for await (const delta of result.textStream) text += delta;
    expect(text).toBe('official stream');
    await expect(result.text).resolves.toBe('official stream');
    await expect(result.totalUsage).resolves.toMatchObject({ inputTokens: 8, outputTokens: 4 });
    await vi.waitFor(() => expect(harness.commits).toHaveLength(1));
    expect(harness.commits[0]).toMatchObject({
      actual_input_tokens: 8,
      actual_output_tokens: 4,
      stream_aborted: false,
    });
    expect(harness.providerBodies).toHaveLength(1);
    expect(harness.providerBodies[0]).toMatchObject({
      model: MODEL,
      stream: true,
      stream_options: { include_usage: true },
      service_tier: 'default',
    });
    expect(harness.releases).toHaveLength(0);

    const extensionsAtEof = harness.extensions.length;
    await vi.advanceTimersByTimeAsync(500_000);
    expect(harness.extensions).toHaveLength(extensionsAtEof);
  });

  it('keeps the provider key private while preserving locked stream transport state', async () => {
    const harness = installOfficialStreamFetch('complete');
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const secret = 'provider-private-key-stream';
    const providerSettings = {
      apiKey: secret,
      model: MODEL,
    };
    const model = await createControlledOpenAIChatModel(providerSettings);
    providerSettings.apiKey = 'mutated-provider-key';
    providerSettings.model = 'mutated-model';
    const result = await controlledStreamText<OfficialStreamResult>(officialStreamRequest(model));

    let text = '';
    for await (const delta of result.textStream) text += delta;
    expect(text).toBe('official stream');
    expect(harness.providerBodies).toHaveLength(1);
    expect(harness.providerBodies[0]).toMatchObject({
      model: MODEL,
      stream: true,
      service_tier: 'default',
    });
    expect(harness.providerHeaders[0]?.['authorization']).toBe(`Bearer ${secret}`);
    expect(harness.controlBodies).toHaveLength(3);
    expect(harness.controlBodies.join('\n')).not.toContain(secret);
  });

  it('stops the heartbeat and leaves the reservation unresolved on caller abort', async () => {
    vi.useFakeTimers();
    const harness = installOfficialStreamFetch('open');
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const model = await officialModel();
    const controller = new AbortController();
    const onAbort = vi.fn();
    const result = await controlledStreamText<OfficialStreamResult>(
      officialStreamRequest(model, { abortSignal: controller.signal, onAbort }),
    );
    const iterator = result.textStream[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: 'official stream' });
    await vi.advanceTimersByTimeAsync(100_000);
    expect(harness.extensions.length).toBeGreaterThan(0);
    controller.abort(new DOMException('caller stopped', 'AbortError'));
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    await vi.waitFor(() => expect(onAbort).toHaveBeenCalledTimes(1));
    expect(harness.providerAbortCount).toBe(1);
    expect(harness.commits).toHaveLength(0);
    expect(harness.releases).toHaveLength(0);

    const extensionsAtAbort = harness.extensions.length;
    await vi.advanceTimersByTimeAsync(500_000);
    expect(harness.extensions).toHaveLength(extensionsAtAbort);
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it('starts the heartbeat on a stalled first read and stops it directly on caller abort', async () => {
    vi.useFakeTimers();
    const harness = installOfficialStreamFetch('stalled');
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const model = await officialModel();
    const controller = new AbortController();
    const result = await controlledStreamText<OfficialStreamResult>(
      officialStreamRequest(model, { abortSignal: controller.signal }),
    );
    const reader = result.textStream.getReader();
    const pendingRead = reader.read();

    await vi.advanceTimersByTimeAsync(100_000);
    expect(harness.extensions.length).toBeGreaterThan(0);
    controller.abort(new DOMException('caller stopped stalled stream', 'AbortError'));
    expect(harness.providerAbortCount).toBe(1);
    expect(harness.commits).toHaveLength(0);
    expect(harness.releases).toHaveLength(0);

    const extensionsAtAbort = harness.extensions.length;
    await vi.advanceTimersByTimeAsync(500_000);
    expect(harness.extensions).toHaveLength(extensionsAtAbort);
    await reader.cancel('test cleanup');
    await expect(pendingRead).resolves.toMatchObject({ done: true });
  });

  it('aborts once and stops the heartbeat when a text iterator returns early', async () => {
    vi.useFakeTimers();
    const harness = installOfficialStreamFetch('open');
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const model = await officialModel();
    const result = await controlledStreamText<OfficialStreamResult>(officialStreamRequest(model));
    const iterator = result.textStream[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: 'official stream' });
    await vi.advanceTimersByTimeAsync(100_000);
    expect(harness.extensions.length).toBeGreaterThan(0);
    await expect(iterator.return?.()).resolves.toMatchObject({ done: true });
    await vi.waitFor(() => expect(harness.providerAbortCount).toBe(1));
    expect(harness.commits).toHaveLength(0);
    expect(harness.releases).toHaveLength(0);

    const extensionsAtReturn = harness.extensions.length;
    await vi.advanceTimersByTimeAsync(500_000);
    expect(harness.extensions).toHaveLength(extensionsAtReturn);
    expect(harness.providerAbortCount).toBe(1);
  });

  it('aborts once and stops the heartbeat when the text-stream consumer throws', async () => {
    vi.useFakeTimers();
    const harness = installOfficialStreamFetch('open');
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const model = await officialModel();
    const consumerError = new Error('consumer stopped processing');
    const result = await controlledStreamText<OfficialStreamResult>(officialStreamRequest(model));

    let caught: unknown;
    try {
      for await (const delta of result.textStream) {
        expect(delta).toBe('official stream');
        throw consumerError;
      }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(consumerError);
    await vi.waitFor(() => expect(harness.providerAbortCount).toBe(1));
    expect(harness.commits).toHaveLength(0);
    expect(harness.releases).toHaveLength(0);

    const extensionsAtError = harness.extensions.length;
    await vi.advanceTimersByTimeAsync(500_000);
    expect(harness.extensions).toHaveLength(extensionsAtError);
    expect(harness.providerAbortCount).toBe(1);
  });

  it('aborts once when a text-stream pipe destination rejects a chunk', async () => {
    vi.useFakeTimers();
    const harness = installOfficialStreamFetch('open');
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const model = await officialModel();
    const consumerError = new Error('pipe destination failed');
    const result = await controlledStreamText<OfficialStreamResult>(officialStreamRequest(model));

    await expect(
      result.textStream.pipeTo(
        new WritableStream({
          write() {
            throw consumerError;
          },
        }),
      ),
    ).rejects.toBe(consumerError);
    await vi.waitFor(() => expect(harness.providerAbortCount).toBe(1));
    expect(harness.commits).toHaveLength(0);
    expect(harness.releases).toHaveLength(0);

    const extensionsAtError = harness.extensions.length;
    await vi.advanceTimersByTimeAsync(500_000);
    expect(harness.extensions).toHaveLength(extensionsAtError);
    expect(harness.providerAbortCount).toBe(1);
  });

  it('aborts once and stops the heartbeat when a native full-stream reader is cancelled', async () => {
    vi.useFakeTimers();
    const harness = installOfficialStreamFetch('open');
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const model = await officialModel();
    const result = await controlledStreamText<OfficialStreamResult>(officialStreamRequest(model));
    const reader = result.fullStream.getReader();

    await expect(reader.read()).resolves.toMatchObject({ done: false });
    await vi.advanceTimersByTimeAsync(100_000);
    expect(harness.extensions.length).toBeGreaterThan(0);
    await reader.cancel('consumer cancelled');
    await vi.waitFor(() => expect(harness.providerAbortCount).toBe(1));
    expect(harness.commits).toHaveLength(0);
    expect(harness.releases).toHaveLength(0);

    const extensionsAtCancel = harness.extensions.length;
    await vi.advanceTimersByTimeAsync(500_000);
    expect(harness.extensions).toHaveLength(extensionsAtCancel);
    expect(harness.providerAbortCount).toBe(1);
  });

  it.each(['throw', 'reject'] as const)(
    'aborts once and preserves an onChunk callback error when it %s',
    async (mode) => {
      vi.useFakeTimers();
      const harness = installOfficialStreamFetch('open');
      init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
      const model = await officialModel();
      const callbackError = new Error(`onChunk ${mode}`);
      const onChunk =
        mode === 'throw'
          ? () => {
              throw callbackError;
            }
          : () => Promise.reject(callbackError);
      const result = await controlledStreamText<OfficialStreamResult>(
        officialStreamRequest(model, { onChunk }),
      );

      const reader = result.textStream.getReader();
      await expect(reader.read()).resolves.toMatchObject({ done: false, value: 'official stream' });
      await expect(reader.read()).rejects.toBe(callbackError);
      await vi.waitFor(() => expect(harness.providerAbortCount).toBe(1));
      expect(harness.commits).toHaveLength(0);
      expect(harness.releases).toHaveLength(0);

      const extensionsAtError = harness.extensions.length;
      await vi.advanceTimersByTimeAsync(500_000);
      expect(harness.extensions).toHaveLength(extensionsAtError);
      expect(harness.providerAbortCount).toBe(1);
    },
  );

  it('refuses official Anthropic, OpenAI Responses, custom endpoint, and custom fetch models before I/O', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const attempts = [
      {
        model: createAnthropic({ apiKey: 'provider-test-key' })('claude-sonnet-4-5'),
        reason: 'anthropic_standard_tier_cannot_be_proven',
      },
      {
        model: createOpenAI({ apiKey: 'provider-test-key' })(MODEL),
        reason: 'provider_is_not_in_the_strict_priced_subset',
      },
      {
        model: createOpenAI({
          apiKey: 'provider-test-key',
          baseURL: 'https://proxy.invalid/v1',
        }).chat(MODEL),
        reason: 'official_provider_endpoint_is_required',
      },
      {
        model: createOpenAI({
          apiKey: 'provider-test-key',
          fetch: async () => json({}),
        }).chat(MODEL),
        reason: 'official_provider_transport_evidence_is_required',
      },
      {
        model: createOpenAI({
          apiKey: 'provider-test-key',
          headers: { 'x-custom-transport': 'unsupported' },
        }).chat(MODEL),
        reason: 'official_provider_default_headers_are_required',
      },
    ];

    for (const { model } of attempts) {
      await expect(
        controlledGenerateText({
          model,
          prompt: 'private official prompt',
          maxOutputTokens: 20,
          providerOptions: { openai: { serviceTier: 'default' } },
        }),
      ).rejects.toMatchObject({
        name: 'PylvaStrictProviderError',
        code: 'strict_provider_unsupported',
        provider: 'vercel-ai',
        reason: 'controlled_openai_chat_model_is_required',
      });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
