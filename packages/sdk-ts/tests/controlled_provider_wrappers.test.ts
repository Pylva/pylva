import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetConfigForTests, init } from '../src/core/config.js';
import { _resetControlClientForTests } from '../src/core/control_client.js';
import {
  registerControlledCallback,
  withControlledCallbackScope,
} from '../src/core/control_correlation.js';
import { _resetTelemetryForTests, bufferSize } from '../src/core/telemetry.js';
import { _wrapOpenAIForTests as wrapOpenAI } from '../src/wrappers/openai_controlled.js';
import { _wrapAnthropicForTests as wrapAnthropic } from '../src/wrappers/anthropic_controlled.js';

const KEY = `pv_live_aabbccdd_${'a'.repeat(32)}`;
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req_1' },
  });
}

function apiPromise<T>(value: T): Promise<T> & {
  asResponse(): Promise<Response>;
  withResponse(): Promise<{ data: T; response: Response; request_id: string }>;
} {
  const promise = Promise.resolve(value) as ReturnType<typeof apiPromise<T>>;
  promise.asResponse = async () => json(value);
  promise.withResponse = async () => ({ data: value, response: json(value), request_id: 'req_1' });
  return promise;
}

function reserved(operationId: string) {
  return {
    schema_version: '1.0',
    decision: 'reserved',
    allowed: true,
    decision_id: DECISION_ID,
    operation_id: operationId,
    reservation_id: RESERVATION_ID,
    state: 'reserved',
    reserved_usd: '0.125',
    remaining_usd: '9.875',
    expires_at: '2026-07-14T09:05:00.000Z',
    warnings: [],
  };
}

function denied(operationId: string) {
  return {
    schema_version: '1.0',
    decision: 'denied',
    allowed: false,
    decision_id: DECISION_ID,
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
  };
}

function committed(operationId: string) {
  return {
    schema_version: '1.0',
    state: 'committed',
    reservation_id: RESERVATION_ID,
    operation_id: operationId,
    reserved_usd: '0.125',
    actual_usd: '0.01',
    released_usd: '0.115',
    overage_usd: '0',
    budget_exceeded_after_commit: false,
    committed_at: '2026-07-14T09:01:00.000Z',
    idempotent_replay: false,
    late: false,
  };
}

function released(operationId: string) {
  return {
    schema_version: '1.0',
    state: 'released',
    reservation_id: RESERVATION_ID,
    operation_id: operationId,
    released_usd: '0.125',
    released_at: '2026-07-14T09:01:00.000Z',
    idempotent_replay: false,
  };
}

function installControlFetch(
  options: {
    onReserve?: (body: Record<string, unknown>) => Response | Promise<Response>;
    onCommit?: (operationId: string) => Response | Promise<Response>;
  } = {},
) {
  let operationId = '';
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, request) => {
    const href = String(url);
    if (href.endsWith('/api/v1/budget/capabilities')) return json(capabilities);
    if (href.endsWith('/api/v1/budget/reservations')) {
      const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
      operationId = String(body['operation_id']);
      return options.onReserve?.(body) ?? json(reserved(operationId));
    }
    if (href.endsWith(`/${RESERVATION_ID}/commit`)) {
      return options.onCommit?.(operationId) ?? json(committed(operationId));
    }
    if (href.endsWith(`/${RESERVATION_ID}/release`)) return json(released(operationId));
    if (href.endsWith(`/${RESERVATION_ID}/extend`)) {
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
    throw new Error(`unexpected control URL ${href}`);
  });
}

function openAiBody(overrides: Record<string, unknown> = {}) {
  return {
    model: 'gpt-test-2026-01-01',
    messages: [{ role: 'user', content: 'private prompt' }],
    max_completion_tokens: 20,
    ...overrides,
  };
}

function openAiResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chat_1',
    model: 'gpt-test-2026-01-01',
    service_tier: 'default',
    usage: {
      prompt_tokens: 8,
      completion_tokens: 4,
      prompt_tokens_details: { cached_tokens: 0 },
    },
    choices: [],
    ...overrides,
  };
}

function anthropicBody(overrides: Record<string, unknown> = {}) {
  return {
    model: 'claude-test-2026-01-01',
    max_tokens: 20,
    messages: [{ role: 'user', content: 'private prompt' }],
    ...overrides,
  };
}

function anthropicResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg_1',
    model: 'claude-test-2026-01-01',
    service_tier: 'standard',
    usage: {
      input_tokens: 8,
      output_tokens: 4,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: null,
    },
    content: [],
    ...overrides,
  };
}

function reset(): void {
  _resetControlClientForTests();
  _resetTelemetryForTests();
  _resetConfigForTests();
}

describe('explicit controlled provider wrappers', () => {
  beforeEach(reset);
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    reset();
  });

  it('reserves immediately before OpenAI dispatch, commits exact base usage, and sends no content', async () => {
    const fetchSpy = installControlFetch();
    init({
      apiKey: KEY,
      endpoint: 'https://control.test',
      control: { mode: 'enforce', onUnavailable: 'deny' },
    });
    const response = openAiResponse();
    const create = vi.fn(() => apiPromise(response));
    const client = wrapOpenAI({
      baseURL: 'https://api.openai.com/v1',
      maxRetries: 0,
      chat: { completions: { create } },
    });

    await expect(client.chat.completions.create(openAiBody())).resolves.toBe(response);
    expect(create).toHaveBeenCalledTimes(1);
    expect(bufferSize()).toBe(0);
    const reserveCall = fetchSpy.mock.calls.find(([url]) =>
      String(url).endsWith('/api/v1/budget/reservations'),
    );
    const reserveBody = JSON.parse(String(reserveCall?.[1]?.body)) as Record<string, unknown>;
    expect(reserveBody).toMatchObject({
      kind: 'llm',
      provider: 'openai',
      model: 'gpt-test-2026-01-01',
      max_output_tokens: 20,
    });
    expect(JSON.stringify(reserveBody)).not.toContain('private prompt');
    const commitCall = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/commit'));
    expect(JSON.parse(String(commitCall?.[1]?.body))).toMatchObject({
      actual_input_tokens: 8,
      actual_output_tokens: 4,
    });
    expect(create.mock.invocationCallOrder[0]).toBeGreaterThan(
      fetchSpy.mock.invocationCallOrder[1] ?? 0,
    );
  });

  it('returns provider success unchanged and leaves RESERVED unresolved on unsafe evidence', async () => {
    const cases = [
      openAiResponse({ usage: undefined }),
      openAiResponse({
        usage: {
          prompt_tokens: 8,
          completion_tokens: 4,
          prompt_tokens_details: { cached_tokens: 2 },
        },
      }),
      openAiResponse({
        usage: {
          prompt_tokens: 8,
          completion_tokens: 4,
          total_tokens: 12,
          prompt_tokens_details: { cached_tokens: 0, audio_tokens: 1 },
        },
      }),
      openAiResponse({
        usage: {
          prompt_tokens: 8,
          completion_tokens: 4,
          total_tokens: 12,
          completion_tokens_details: { reasoning_tokens: 2, audio_tokens: 1 },
        },
      }),
      openAiResponse({
        usage: {
          prompt_tokens: 8,
          completion_tokens: 4,
          total_tokens: 12,
          unknown_paid_usage: { premium_units: 1 },
        },
      }),
      openAiResponse({
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 13 },
      }),
      openAiResponse({
        usage: { prompt_tokens: 8, input_tokens: 9, completion_tokens: 4 },
      }),
      openAiResponse({
        usage: { prompt_tokens: 8, completion_tokens: 4, output_tokens: 5 },
      }),
      openAiResponse({
        usage: {
          prompt_tokens: 8,
          completion_tokens: 4,
          completion_tokens_details: { reasoning_tokens: 5 },
        },
      }),
      openAiResponse({
        usage: {
          prompt_tokens: 8,
          completion_tokens: 4,
          ...Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`zero_${index}`, 0])),
        },
      }),
      openAiResponse({
        usage: {
          prompt_tokens: 8,
          completion_tokens: 4,
          completion_tokens_details: Object.fromEntries(
            Array.from({ length: 257 }, (_, index) => [`zero_${index}`, 0]),
          ),
        },
      }),
      openAiResponse({ model: 'different-priced-model' }),
      openAiResponse({ service_tier: 'priority' }),
    ];
    for (const response of cases) {
      reset();
      const fetchSpy = installControlFetch();
      init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
      const create = vi.fn(() => apiPromise(response));
      const client = wrapOpenAI({
        baseURL: 'https://api.openai.com/v1',
        maxRetries: 0,
        chat: { completions: { create } },
      });
      await expect(client.chat.completions.create(openAiBody())).resolves.toBe(response);
      expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(false);
      expect(bufferSize()).toBe(0);
      vi.restoreAllMocks();
    }
  });

  it('accepts documented base-inclusive OpenAI token details but not hostile usage getters', async () => {
    const safeFetch = installControlFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const safeResponse = openAiResponse({
      usage: {
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
    });
    const safeClient = wrapOpenAI({
      baseURL: 'https://api.openai.com/v1',
      maxRetries: 0,
      chat: { completions: { create: () => apiPromise(safeResponse) } },
    });
    await expect(safeClient.chat.completions.create(openAiBody())).resolves.toBe(safeResponse);
    expect(safeFetch.mock.calls.filter(([url]) => String(url).endsWith('/commit'))).toHaveLength(1);

    vi.restoreAllMocks();
    reset();
    const hostileFetch = installControlFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const hostileUsage = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostileUsage, 'prompt_tokens', {
      enumerable: true,
      get() {
        throw new Error('hostile paid usage getter');
      },
    });
    const hostileResponse = openAiResponse({ usage: hostileUsage });
    const hostileClient = wrapOpenAI({
      baseURL: 'https://api.openai.com/v1',
      maxRetries: 0,
      chat: { completions: { create: () => apiPromise(hostileResponse) } },
    });
    await expect(hostileClient.chat.completions.create(openAiBody())).resolves.toBe(
      hostileResponse,
    );
    expect(hostileFetch.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(false);
  });

  it('keeps provider success and reservation ownership when commit acknowledgement is lost', async () => {
    installControlFetch({ onCommit: async () => Promise.reject(new Error('lost ack')) });
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const response = openAiResponse();
    const client = wrapOpenAI({
      baseURL: 'https://api.openai.com/v1',
      maxRetries: 0,
      chat: { completions: { create: () => apiPromise(response) } },
    });
    await expect(client.chat.completions.create(openAiBody())).resolves.toBe(response);
    expect(bufferSize()).toBe(0);
  });

  it('releases a proven no-provider-call abort that happens after reserve', async () => {
    const controller = new AbortController();
    const fetchSpy = installControlFetch({
      onReserve: (body) => {
        controller.abort();
        return json(reserved(String(body['operation_id'])));
      },
    });
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const create = vi.fn(() => apiPromise(openAiResponse()));
    const client = wrapOpenAI({
      baseURL: 'https://api.openai.com/v1',
      maxRetries: 0,
      chat: { completions: { create } },
    });
    await expect(
      client.chat.completions.create(openAiBody(), { signal: controller.signal }),
    ).rejects.toMatchObject({ reason: 'request_aborted_before_provider_dispatch' });
    expect(create).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/release'))).toBe(true);
  });

  it('rejects own AbortSignal shadows and non-exact prototypes before reserve', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    for (const provider of ['openai', 'anthropic'] as const) {
      const controller = new AbortController();
      Object.defineProperty(controller.signal, 'aborted', { value: false, configurable: true });
      const create = vi.fn(() => apiPromise(openAiResponse()));
      const invoke = () =>
        provider === 'openai'
          ? wrapOpenAI({
              baseURL: 'https://api.openai.com/v1',
              maxRetries: 0,
              chat: { completions: { create } },
            }).chat.completions.create(openAiBody(), { signal: controller.signal })
          : wrapAnthropic({
              baseURL: 'https://api.anthropic.com',
              maxRetries: 0,
              messages: { create },
            }).messages.create(anthropicBody(), { signal: controller.signal });
      expect(invoke).toThrowError(
        expect.objectContaining({ reason: 'request_options_are_invalid' }),
      );
      expect(create).not.toHaveBeenCalled();

      const altered = new AbortController().signal;
      Object.setPrototypeOf(altered, Object.create(AbortSignal.prototype));
      const alteredInvoke = () =>
        provider === 'openai'
          ? wrapOpenAI({
              baseURL: 'https://api.openai.com/v1',
              maxRetries: 0,
              chat: { completions: { create } },
            }).chat.completions.create(openAiBody(), { signal: altered })
          : wrapAnthropic({
              baseURL: 'https://api.anthropic.com',
              maxRetries: 0,
              messages: { create },
            }).messages.create(anthropicBody(), { signal: altered });
      expect(alteredInvoke).toThrowError(
        expect.objectContaining({ reason: 'request_options_are_invalid' }),
      );
      expect(create).not.toHaveBeenCalled();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('releases when an AbortSignal gains an own shadow during reserve', async () => {
    for (const provider of ['openai', 'anthropic'] as const) {
      vi.restoreAllMocks();
      reset();
      const controller = new AbortController();
      const fetchSpy = installControlFetch({
        onReserve: (body) => {
          Object.defineProperty(controller.signal, 'aborted', {
            value: false,
            configurable: true,
          });
          return json(reserved(String(body['operation_id'])));
        },
      });
      init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
      const create = vi.fn(() => apiPromise(openAiResponse()));
      const request =
        provider === 'openai'
          ? wrapOpenAI({
              baseURL: 'https://api.openai.com/v1',
              maxRetries: 0,
              chat: { completions: { create } },
            }).chat.completions.create(openAiBody(), { signal: controller.signal })
          : wrapAnthropic({
              baseURL: 'https://api.anthropic.com',
              maxRetries: 0,
              messages: { create },
            }).messages.create(anthropicBody(), { signal: controller.signal });
      await expect(request).rejects.toMatchObject({ reason: 'request_options_are_invalid' });
      expect(create).not.toHaveBeenCalled();
      expect(fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/release'))).toHaveLength(
        1,
      );
      expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(false);
    }
  });

  it('makes zero provider calls on authoritative denial', async () => {
    installControlFetch({
      onReserve: (body) => json(denied(String(body['operation_id']))),
    });
    init({
      apiKey: KEY,
      endpoint: 'https://control.test',
      control: { mode: 'enforce', onUnavailable: 'deny' },
    });
    const create = vi.fn(() => apiPromise(openAiResponse()));
    const client = wrapOpenAI({
      baseURL: 'https://api.openai.com/v1',
      maxRetries: 0,
      chat: { completions: { create } },
    });
    await expect(client.chat.completions.create(openAiBody())).rejects.toMatchObject({
      name: 'PylvaBudgetExceeded',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('links post-reserve aborts to the reserved operation in the LangGraph callback scope', async () => {
    for (const provider of ['openai', 'anthropic'] as const) {
      reset();
      const controller = new AbortController();
      const fetchSpy = installControlFetch({
        onReserve: (body) => {
          controller.abort();
          return json(reserved(String(body['operation_id'])));
        },
      });
      init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
      const create = vi.fn(() => apiPromise(openAiResponse()));
      let callback: ReturnType<typeof registerControlledCallback> = null;
      await withControlledCallbackScope(async () => {
        callback = registerControlledCallback('llm');
        const request =
          provider === 'openai'
            ? wrapOpenAI({
                baseURL: 'https://api.openai.com/v1',
                maxRetries: 0,
                chat: { completions: { create } },
              }).chat.completions.create(openAiBody(), { signal: controller.signal })
            : wrapAnthropic({
                baseURL: 'https://api.anthropic.com',
                maxRetries: 0,
                messages: { create },
              }).messages.create(anthropicBody(), { signal: controller.signal });
        await expect(request).rejects.toMatchObject({
          reason: 'request_aborted_before_provider_dispatch',
        });
      });
      const reserveCall = fetchSpy.mock.calls.find(([url]) =>
        String(url).endsWith('/api/v1/budget/reservations'),
      );
      const operationId = String(JSON.parse(String(reserveCall?.[1]?.body))['operation_id']);
      expect(callback?.controlledNoDispatch?.operationId).toBe(operationId);
      expect(create).not.toHaveBeenCalled();
      expect(fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/release'))).toHaveLength(
        1,
      );
      expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(false);
      expect(bufferSize()).toBe(0);
      vi.restoreAllMocks();
    }
  });

  it('never performs hidden provider retries or model fallback after a rejected attempt', async () => {
    const fetchSpy = installControlFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const create = vi.fn(() => apiPromise(Promise.reject(new Error('provider rejected'))) as never);
    // Use a real rejected APIPromise shape instead of relying on client retry behavior.
    const rejected = Promise.reject(new Error('provider rejected')) as Promise<never> & {
      asResponse(): Promise<Response>;
      withResponse(): Promise<never>;
    };
    rejected.asResponse = async () => Promise.reject(new Error('provider rejected'));
    rejected.withResponse = async () => Promise.reject(new Error('provider rejected'));
    create.mockReturnValue(rejected as never);
    const client = wrapOpenAI({
      baseURL: 'https://api.openai.com/v1',
      maxRetries: 0,
      chat: { completions: { create } },
    });
    await expect(client.chat.completions.create(openAiBody())).rejects.toThrow('provider rejected');
    expect(create).toHaveBeenCalledTimes(1);
    expect(
      fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/reservations')),
    ).toHaveLength(1);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(false);
  });

  it('gives caller-directed fallback attempts distinct actual provider and model reservations', async () => {
    const reservationIds = [
      '44444444-4444-4444-8444-444444444441',
      '44444444-4444-4444-8444-444444444442',
    ];
    const reserveBodies: Record<string, unknown>[] = [];
    const operationByReservation = new Map<string, string>();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, request) => {
      const href = String(url);
      if (href.endsWith('/api/v1/budget/capabilities')) return json(capabilities);
      if (href.endsWith('/api/v1/budget/reservations')) {
        const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
        const index = reserveBodies.length;
        const reservationId = reservationIds[index]!;
        const operationId = String(body['operation_id']);
        reserveBodies.push(body);
        operationByReservation.set(reservationId, operationId);
        return json({
          ...reserved(operationId),
          decision_id: `55555555-5555-4555-8555-55555555555${index + 1}`,
          reservation_id: reservationId,
        });
      }
      const reservationId = reservationIds.find((candidate) =>
        href.endsWith(`/${candidate}/commit`),
      );
      if (reservationId) {
        return json({
          ...committed(operationByReservation.get(reservationId)!),
          reservation_id: reservationId,
        });
      }
      throw new Error(`unexpected control URL ${href}`);
    });
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });

    const firstError = new Error('openai attempt failed');
    const rejected = Promise.reject(firstError) as Promise<never> & {
      asResponse(): Promise<Response>;
      withResponse(): Promise<never>;
    };
    rejected.asResponse = async () => Promise.reject(firstError);
    rejected.withResponse = async () => Promise.reject(firstError);
    const openAiCreate = vi.fn(() => rejected);
    const anthropicCreate = vi.fn(() => apiPromise(anthropicResponse()));
    const openai = wrapOpenAI({
      baseURL: 'https://api.openai.com/v1',
      maxRetries: 0,
      chat: { completions: { create: openAiCreate } },
    });
    const anthropic = wrapAnthropic({
      baseURL: 'https://api.anthropic.com',
      maxRetries: 0,
      messages: { create: anthropicCreate },
    });

    await expect(openai.chat.completions.create(openAiBody())).rejects.toBe(firstError);
    expect(anthropicCreate).not.toHaveBeenCalled();
    await expect(anthropic.messages.create(anthropicBody())).resolves.toEqual(anthropicResponse());

    expect(openAiCreate).toHaveBeenCalledTimes(1);
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
    expect(reserveBodies).toHaveLength(2);
    expect(reserveBodies[0]).toMatchObject({
      provider: 'openai',
      model: 'gpt-test-2026-01-01',
    });
    expect(reserveBodies[1]).toMatchObject({
      provider: 'anthropic',
      model: 'claude-test-2026-01-01',
    });
    expect(reserveBodies[0]?.['operation_id']).not.toBe(reserveBodies[1]?.['operation_id']);
    expect(anthropicCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-test-2026-01-01' }),
      expect.objectContaining({ maxRetries: 0 }),
    );
  });

  it('refuses unpriced features, cache eligibility, retries, and custom transport before I/O', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const create = vi.fn(() => apiPromise(openAiResponse()));
    const makeClient = (overrides: Record<string, unknown> = {}) => ({
      baseURL: 'https://api.openai.com/v1',
      maxRetries: 0,
      chat: { completions: { create } },
      ...overrides,
    });
    expect(() => wrapOpenAI(makeClient({ maxRetries: 2 }))).toThrow(
      'provider_retries_must_be_disabled',
    );
    expect(() =>
      wrapOpenAI(makeClient({ _options: { defaultHeaders: { 'x-beta': 'private' } } })),
    ).toThrow('custom_client_transport_headers_or_query_are_unsupported');
    expect(() => wrapOpenAI(makeClient({ _options: { fetch: vi.fn() } }))).toThrow(
      'custom_client_transport_headers_or_query_are_unsupported',
    );
    const client = wrapOpenAI(makeClient());
    for (const body of [
      openAiBody({ audio: {} }),
      openAiBody({ tools: [{ type: 'web_search' }] }),
      openAiBody({ prompt_cache_key: 'cache-me' }),
      openAiBody({ messages: [{ role: 'user', content: 'x'.repeat(2_000) }] }),
    ]) {
      expect(() => client.chat.completions.create(body)).toThrow();
    }
    expect(create).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('preserves OpenAI APIPromise asResponse/withResponse helpers', async () => {
    const fetchSpy = installControlFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const response = openAiResponse();
    const client = wrapOpenAI({
      baseURL: 'https://api.openai.com/v1',
      maxRetries: 0,
      chat: { completions: { create: () => apiPromise(response) } },
    });
    const promise = client.chat.completions.create(openAiBody());
    expect(typeof promise.asResponse).toBe('function');
    expect(typeof promise.withResponse).toBe('function');
    const withResponse = await promise.withResponse();
    expect(withResponse.data).toBe(response);
    expect(withResponse.request_id).toBe('req_1');
    await vi.waitFor(() => {
      expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(true);
    });
  });

  it('keeps stream EOF unchanged when terminal exact usage is missing', async () => {
    const fetchSpy = installControlFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const source = {
      async *[Symbol.asyncIterator]() {
        yield { id: 'chunk', model: 'gpt-test-2026-01-01', choices: [] };
      },
    };
    const client = wrapOpenAI({
      baseURL: 'https://api.openai.com/v1',
      maxRetries: 0,
      chat: { completions: { create: () => apiPromise(source) } },
    });
    const stream = await client.chat.completions.create(openAiBody({ stream: true }));
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(chunks).toHaveLength(1);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(false);
  });

  it('commits an exact OpenAI stream only at terminal EOF and leaves an early break unresolved', async () => {
    const terminal = openAiResponse();
    for (const consumeToEnd of [true, false]) {
      reset();
      const fetchSpy = installControlFetch();
      init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
      const source = {
        async *[Symbol.asyncIterator]() {
          yield { id: 'chunk_1', model: terminal.model, service_tier: 'default', choices: [] };
          yield terminal;
        },
      };
      const client = wrapOpenAI({
        baseURL: 'https://api.openai.com/v1',
        maxRetries: 0,
        chat: { completions: { create: () => apiPromise(source) } },
      });
      const stream = await client.chat.completions.create(openAiBody({ stream: true }));
      let count = 0;
      for await (const _chunk of stream) {
        void _chunk;
        count += 1;
        if (!consumeToEnd) break;
      }
      expect(count).toBe(consumeToEnd ? 2 : 1);
      expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(
        consumeToEnd,
      );
      vi.restoreAllMocks();
    }
  });

  it('preserves OpenAI stream chunks but never commits audio, unknown, or hostile usage evidence', async () => {
    const terminals = [
      openAiResponse({
        usage: {
          prompt_tokens: 8,
          completion_tokens: 4,
          total_tokens: 12,
          completion_tokens_details: { audio_tokens: 1 },
        },
      }),
      openAiResponse({
        usage: {
          prompt_tokens: 8,
          completion_tokens: 4,
          total_tokens: 12,
          metered_extension: [{ units: 1 }],
        },
      }),
      openAiResponse({
        usage: {
          prompt_tokens: 8,
          completion_tokens: 4,
          completion_tokens_details: Object.fromEntries(
            Array.from({ length: 257 }, (_, index) => [`zero_${index}`, 0]),
          ),
        },
      }),
      openAiResponse({
        usage: {
          prompt_tokens: 8,
          completion_tokens: 4,
          total_tokens: 11,
        },
      }),
    ];
    for (const terminal of terminals) {
      reset();
      const fetchSpy = installControlFetch();
      init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
      const source = {
        async *[Symbol.asyncIterator]() {
          yield terminal;
        },
      };
      const client = wrapOpenAI({
        baseURL: 'https://api.openai.com/v1',
        maxRetries: 0,
        chat: { completions: { create: () => apiPromise(source) } },
      });
      const stream = await client.chat.completions.create(openAiBody({ stream: true }));
      const seen = [];
      for await (const chunk of stream) seen.push(chunk);
      expect(seen).toEqual([terminal]);
      expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(false);
      vi.restoreAllMocks();
    }

    reset();
    const fetchSpy = installControlFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, 'service_tier', {
      enumerable: true,
      get() {
        throw new Error('hostile stream evidence');
      },
    });
    const terminal = openAiResponse();
    const source = {
      async *[Symbol.asyncIterator]() {
        yield hostile;
        yield terminal;
      },
    };
    const client = wrapOpenAI({
      baseURL: 'https://api.openai.com/v1',
      maxRetries: 0,
      chat: { completions: { create: () => apiPromise(source) } },
    });
    const stream = await client.chat.completions.create(openAiBody({ stream: true }));
    const seen = [];
    for await (const chunk of stream) seen.push(chunk);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(hostile);
    expect(seen[1]).toBe(terminal);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(false);
  });

  it('snapshots exact OpenAI stream usage before exposing the native terminal chunk', async () => {
    const fetchSpy = installControlFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const terminal = openAiResponse({
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    });
    const source = {
      async *[Symbol.asyncIterator]() {
        yield terminal;
      },
    };
    const client = wrapOpenAI({
      baseURL: 'https://api.openai.com/v1',
      maxRetries: 0,
      chat: { completions: { create: () => apiPromise(source) } },
    });
    const stream = await client.chat.completions.create(openAiBody({ stream: true }));
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toBe(terminal);
    terminal.usage.prompt_tokens = 0;
    terminal.usage.completion_tokens = 0;
    terminal.usage.total_tokens = 0;
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    const commitCall = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/commit'));
    expect(JSON.parse(String(commitCall?.[1]?.body))).toMatchObject({
      actual_input_tokens: 8,
      actual_output_tokens: 4,
    });
  });

  it('leaves a consumer-thrown stream unresolved and stops its active heartbeat', async () => {
    vi.useFakeTimers();
    const fetchSpy = installControlFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    let sourceClosed = 0;
    const source = {
      async *[Symbol.asyncIterator]() {
        try {
          yield {
            id: 'chunk_1',
            model: 'gpt-test-2026-01-01',
            service_tier: 'default',
            choices: [],
          };
          await new Promise(() => {});
        } finally {
          sourceClosed += 1;
        }
      },
    };
    const client = wrapOpenAI(
      {
        baseURL: 'https://api.openai.com/v1',
        maxRetries: 0,
        chat: { completions: { create: () => apiPromise(source) } },
      },
      {
        reservationTtlSeconds: 30,
        heartbeatIntervalMs: 1_000,
        heartbeatExtendBySeconds: 30,
      },
    );
    const stream = await client.chat.completions.create(openAiBody({ stream: true }));
    const consumerError = new Error('consumer processing failed');

    await expect(
      (async () => {
        for await (const _chunk of stream) {
          void _chunk;
          await vi.advanceTimersByTimeAsync(1_000);
          throw consumerError;
        }
      })(),
    ).rejects.toBe(consumerError);

    expect(sourceClosed).toBe(1);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/extend'))).toBe(true);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(false);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/release'))).toBe(false);
    const callsAfterConsumerError = fetchSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchSpy).toHaveBeenCalledTimes(callsAfterConsumerError);
  });

  it('starts stream heartbeats on the first pull, not on wrapper or iterator creation, and stops on return', async () => {
    vi.useFakeTimers();
    const fetchSpy = installControlFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const source = {
      async *[Symbol.asyncIterator]() {
        yield { id: 'chunk_1', model: 'gpt-test-2026-01-01', choices: [] };
        await new Promise(() => {});
      },
    };
    const client = wrapOpenAI(
      {
        baseURL: 'https://api.openai.com/v1',
        maxRetries: 0,
        chat: { completions: { create: () => apiPromise(source) } },
      },
      {
        reservationTtlSeconds: 30,
        heartbeatIntervalMs: 1_000,
        heartbeatExtendBySeconds: 30,
      },
    );
    const stream = await client.chat.completions.create(openAiBody({ stream: true }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/extend'))).toBe(false);

    const iterator = stream[Symbol.asyncIterator]();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/extend'))).toBe(false);
    await iterator.next();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/extend'))).toBe(true);
    await iterator.return?.();
    const callsAfterReturn = fetchSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchSpy).toHaveBeenCalledTimes(callsAfterReturn);
  });

  it('supports Anthropic Messages with exact standard-tier evidence', async () => {
    const fetchSpy = installControlFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const response = anthropicResponse();
    const create = vi.fn(() => apiPromise(response));
    const client = wrapAnthropic({
      baseURL: 'https://api.anthropic.com',
      maxRetries: 0,
      messages: { create },
    });
    await expect(client.messages.create(anthropicBody())).resolves.toBe(response);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ service_tier: 'standard_only' }),
      expect.objectContaining({ maxRetries: 0 }),
    );
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(true);
    expect(bufferSize()).toBe(0);
  });

  it('makes zero Anthropic provider calls on authoritative denial', async () => {
    installControlFetch({
      onReserve: (body) => json(denied(String(body['operation_id']))),
    });
    init({
      apiKey: KEY,
      endpoint: 'https://control.test',
      control: { mode: 'enforce', onUnavailable: 'deny' },
    });
    const create = vi.fn(() => apiPromise(anthropicResponse()));
    const client = wrapAnthropic({
      baseURL: 'https://api.anthropic.com',
      maxRetries: 0,
      messages: { create },
    });

    await expect(client.messages.create(anthropicBody())).rejects.toMatchObject({
      name: 'PylvaBudgetExceeded',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('returns an Anthropic success unchanged but does not settle conflicting usage-tier evidence', async () => {
    const fetchSpy = installControlFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const response = anthropicResponse({
      service_tier: undefined,
      usage: {
        input_tokens: 8,
        output_tokens: 4,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: null,
        service_tier: 'priority',
      },
    });
    const client = wrapAnthropic({
      baseURL: 'https://api.anthropic.com',
      maxRetries: 0,
      messages: { create: () => apiPromise(response) },
    });
    await expect(client.messages.create(anthropicBody())).resolves.toBe(response);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(false);
  });

  it('preserves Anthropic response and stream events when cache_creation detail is nonzero', async () => {
    const fetchSpy = installControlFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const response = anthropicResponse({
      usage: {
        input_tokens: 8,
        output_tokens: 4,
        cache_creation_input_tokens: 0,
        cache_creation: {
          ephemeral_1h_input_tokens: 0,
          ephemeral_5m_input_tokens: 1,
        },
        cache_read_input_tokens: 0,
        server_tool_use: null,
      },
    });
    const client = wrapAnthropic({
      baseURL: 'https://api.anthropic.com',
      maxRetries: 0,
      messages: { create: () => apiPromise(response) },
    });
    await expect(client.messages.create(anthropicBody())).resolves.toBe(response);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(false);

    vi.restoreAllMocks();
    reset();
    const streamFetch = installControlFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const start = {
      type: 'message_start',
      message: {
        model: 'claude-test-2026-01-01',
        service_tier: 'standard',
        usage: {
          input_tokens: 8,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_creation: {
            ephemeral_1h_input_tokens: 0,
            ephemeral_5m_input_tokens: 1,
          },
          cache_read_input_tokens: 0,
          server_tool_use: null,
        },
      },
    };
    const delta = { type: 'message_delta', usage: { output_tokens: 4 } };
    const source = {
      async *[Symbol.asyncIterator]() {
        yield start;
        yield delta;
      },
    };
    const streamClient = wrapAnthropic({
      baseURL: 'https://api.anthropic.com',
      maxRetries: 0,
      messages: { create: () => apiPromise(source) },
    });
    const stream = await streamClient.messages.create(anthropicBody({ stream: true }));
    const seen = [];
    for await (const event of stream) seen.push(event);
    expect(seen).toEqual([start, delta]);
    expect(streamFetch.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(false);
  });

  it('rejects unknown nonzero Anthropic usage but accepts documented base and nonbilling fields', async () => {
    const unsafeFetch = installControlFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const unsafeResponse = anthropicResponse({
      usage: {
        input_tokens: 8,
        output_tokens: 4,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: null,
        unknown_paid_usage: { premium_units: 1 },
      },
    });
    const unsafeClient = wrapAnthropic({
      baseURL: 'https://api.anthropic.com',
      maxRetries: 0,
      messages: { create: () => apiPromise(unsafeResponse) },
    });
    await expect(unsafeClient.messages.create(anthropicBody())).resolves.toBe(unsafeResponse);
    expect(unsafeFetch.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(false);

    vi.restoreAllMocks();
    reset();
    const streamFetch = installControlFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const start = {
      type: 'message_start',
      message: {
        model: 'claude-test-2026-01-01',
        usage: {
          input_tokens: 8,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: null,
          service_tier: 'standard',
          unknown_paid_usage: { premium_units: 1 },
        },
      },
    };
    const delta = { type: 'message_delta', usage: { output_tokens: 4 } };
    const source = {
      async *[Symbol.asyncIterator]() {
        yield start;
        yield delta;
      },
    };
    const streamClient = wrapAnthropic({
      baseURL: 'https://api.anthropic.com',
      maxRetries: 0,
      messages: { create: () => apiPromise(source) },
    });
    const stream = await streamClient.messages.create(anthropicBody({ stream: true }));
    const seen = [];
    for await (const event of stream) seen.push(event);
    expect(seen).toEqual([start, delta]);
    expect(streamFetch.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(false);

    vi.restoreAllMocks();
    reset();
    const safeFetch = installControlFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const safeResponse = anthropicResponse({
      usage: {
        input_tokens: 8,
        output_tokens: 4,
        cache_creation_input_tokens: 0,
        cache_creation: {
          ephemeral_1h_input_tokens: 0,
          ephemeral_5m_input_tokens: 0,
        },
        cache_read_input_tokens: 0,
        inference_geo: 'us',
        output_tokens_details: { thinking_tokens: 2 },
        server_tool_use: null,
        service_tier: 'standard',
        future_zero_usage: { units: 0 },
      },
    });
    const safeClient = wrapAnthropic({
      baseURL: 'https://api.anthropic.com',
      maxRetries: 0,
      messages: { create: () => apiPromise(safeResponse) },
    });
    await expect(safeClient.messages.create(anthropicBody())).resolves.toBe(safeResponse);
    expect(safeFetch.mock.calls.filter(([url]) => String(url).endsWith('/commit'))).toHaveLength(1);
  });

  it('preserves oversized or contradictory Anthropic evidence without settling', async () => {
    const usages = [
      {
        input_tokens: 8,
        output_tokens: 4,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: null,
        ...Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`zero_${index}`, 0])),
      },
      {
        input_tokens: 8,
        output_tokens: 4,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: null,
        output_tokens_details: Object.fromEntries(
          Array.from({ length: 257 }, (_, index) => [`zero_${index}`, 0]),
        ),
      },
      {
        input_tokens: 8,
        output_tokens: 4,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: null,
        output_tokens_details: { thinking_tokens: 5 },
      },
    ];
    for (const usage of usages) {
      reset();
      const fetchSpy = installControlFetch();
      init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
      const response = anthropicResponse({ usage });
      const client = wrapAnthropic({
        baseURL: 'https://api.anthropic.com',
        maxRetries: 0,
        messages: { create: () => apiPromise(response) },
      });
      await expect(client.messages.create(anthropicBody())).resolves.toBe(response);
      expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(false);
      vi.restoreAllMocks();
    }

    reset();
    const fetchSpy = installControlFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const startUsage = {
      input_tokens: 8,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: null,
      ...Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`zero_${index}`, 0])),
    };
    const start = {
      type: 'message_start',
      message: { model: 'claude-test-2026-01-01', service_tier: 'standard', usage: startUsage },
    };
    const delta = {
      type: 'message_delta',
      usage: { output_tokens: 4, output_tokens_details: { thinking_tokens: 5 } },
    };
    const source = {
      async *[Symbol.asyncIterator]() {
        yield start;
        yield delta;
      },
    };
    const client = wrapAnthropic({
      baseURL: 'https://api.anthropic.com',
      maxRetries: 0,
      messages: { create: () => apiPromise(source) },
    });
    const stream = await client.messages.create(anthropicBody({ stream: true }));
    const seen = [];
    for await (const event of stream) seen.push(event);
    expect(seen).toEqual([start, delta]);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(false);
  });

  it('preserves Anthropic stream events but never settles contradictory cumulative counts', async () => {
    const start = {
      type: 'message_start',
      message: {
        model: 'claude-test-2026-01-01',
        service_tier: 'standard',
        usage: {
          input_tokens: 8,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: null,
        },
      },
    };
    const sequences = [
      [
        start,
        { type: 'message_delta', usage: { output_tokens: 4 } },
        { type: 'message_delta', usage: { output_tokens: 3 } },
      ],
      [start, { type: 'message_delta', usage: { input_tokens: 9, output_tokens: 4 } }],
    ];
    for (const events of sequences) {
      reset();
      const fetchSpy = installControlFetch();
      init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
      const source = {
        async *[Symbol.asyncIterator]() {
          for (const event of events) yield event;
        },
      };
      const client = wrapAnthropic({
        baseURL: 'https://api.anthropic.com',
        maxRetries: 0,
        messages: { create: () => apiPromise(source) },
      });
      const stream = await client.messages.create(anthropicBody({ stream: true }));
      const seen = [];
      for await (const event of stream) seen.push(event);
      expect(seen).toEqual(events);
      events.forEach((event, index) => expect(seen[index]).toBe(event));
      expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(false);
      vi.restoreAllMocks();
    }
  });

  it('keeps unsafe Anthropic stream evidence poisoned after caller mutation', async () => {
    const fetchSpy = installControlFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const paid = { premium_units: 1 };
    const start = {
      type: 'message_start',
      message: {
        model: 'claude-test-2026-01-01',
        service_tier: 'standard',
        usage: {
          input_tokens: 8,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: null,
          unknown_paid_usage: paid,
        },
      },
    };
    const delta = { type: 'message_delta', usage: { output_tokens: 4 } };
    const source = {
      async *[Symbol.asyncIterator]() {
        yield start;
        yield delta;
      },
    };
    const client = wrapAnthropic({
      baseURL: 'https://api.anthropic.com',
      maxRetries: 0,
      messages: { create: () => apiPromise(source) },
    });
    const stream = await client.messages.create(anthropicBody({ stream: true }));
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toBe(start);
    paid.premium_units = 0;
    const second = await iterator.next();
    expect(second.value).toBe(delta);
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(false);
  });

  it('prices and dispatches one detached request snapshot despite delayed-reserve mutation', async () => {
    for (const provider of ['openai', 'anthropic'] as const) {
      vi.restoreAllMocks();
      reset();
      let markReserveStarted!: () => void;
      const reserveStarted = new Promise<void>((resolve) => {
        markReserveStarted = resolve;
      });
      let finishReserve!: () => void;
      const reserveGate = new Promise<void>((resolve) => {
        finishReserve = resolve;
      });
      let reserveBody: Record<string, unknown> | null = null;
      installControlFetch({
        onReserve: async (body) => {
          reserveBody = body;
          markReserveStarted();
          await reserveGate;
          return json(reserved(String(body['operation_id'])));
        },
      });
      init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
      const controller = new AbortController();
      const options: Record<string, unknown> = {
        signal: controller.signal,
        timeout: 25,
        ...(provider === 'anthropic' ? { headers: { 'X-Stainless-Helper-Method': 'stream' } } : {}),
      };
      const request =
        provider === 'openai'
          ? openAiBody({
              tools: [
                {
                  type: 'function',
                  function: {
                    name: 'lookup',
                    parameters: {
                      type: 'object',
                      properties: { city: { type: 'string' } },
                    },
                  },
                },
              ],
            })
          : anthropicBody({
              tools: [
                {
                  name: 'lookup',
                  input_schema: {
                    type: 'object',
                    properties: { city: { type: 'string' } },
                  },
                },
              ],
            });
      const response = provider === 'openai' ? openAiResponse() : anthropicResponse();
      const create = vi.fn((_body: unknown, _options: unknown) => apiPromise(response));
      const controlled =
        provider === 'openai'
          ? wrapOpenAI({
              baseURL: 'https://api.openai.com/v1',
              maxRetries: 0,
              chat: { completions: { create } },
            }).chat.completions
          : wrapAnthropic({
              baseURL: 'https://api.anthropic.com',
              maxRetries: 0,
              messages: { create },
            }).messages;

      const pending = Promise.resolve(controlled.create(request, options));
      await reserveStarted;
      (request['messages'] as Array<Record<string, unknown>>)[0]!['content'] = 'MUTATED';
      const tool = (request['tools'] as Array<Record<string, unknown>>)[0]!;
      const schema =
        provider === 'openai'
          ? ((tool['function'] as Record<string, unknown>)['parameters'] as Record<string, unknown>)
          : (tool['input_schema'] as Record<string, unknown>);
      (schema['properties'] as Record<string, unknown>)['country'] = { type: 'string' };
      options['timeout'] = 999;
      const headers = options['headers'] as Record<string, unknown> | undefined;
      if (headers) headers['X-Stainless-Helper-Method'] = 'MUTATED';
      finishReserve();
      await expect(pending).resolves.toBe(response);

      const dispatched = create.mock.calls[0]![0] as Record<string, unknown>;
      const dispatchedOptions = create.mock.calls[0]![1] as Record<string, unknown>;
      expect((dispatched['messages'] as Array<Record<string, unknown>>)[0]!['content']).toBe(
        'private prompt',
      );
      expect((schema['properties'] as Record<string, unknown>)['country']).toEqual({
        type: 'string',
      });
      const dispatchedTool = (dispatched['tools'] as Array<Record<string, unknown>>)[0]!;
      const dispatchedSchema =
        provider === 'openai'
          ? ((dispatchedTool['function'] as Record<string, unknown>)['parameters'] as Record<
              string,
              unknown
            >)
          : (dispatchedTool['input_schema'] as Record<string, unknown>);
      expect(
        (dispatchedSchema['properties'] as Record<string, unknown>)['country'],
      ).toBeUndefined();
      expect(dispatchedOptions['timeout']).toBe(25);
      expect(dispatchedOptions['signal']).toBe(controller.signal);
      if (provider === 'anthropic') {
        expect(dispatchedOptions['headers']).toEqual({ 'X-Stainless-Helper-Method': 'stream' });
      }
      expect(Object.getPrototypeOf(dispatched)).toBeNull();
      expect((reserveBody as Record<string, unknown>)['estimated_input_tokens']).toBe(
        new TextEncoder().encode(JSON.stringify(dispatched)).byteLength + 256,
      );
    }
  });

  it('rejects accessors, proxies, sparse arrays, and polluted toJSON without invoking callbacks', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const create = vi.fn(() => apiPromise(openAiResponse()));
    const client = wrapOpenAI({
      baseURL: 'https://api.openai.com/v1',
      maxRetries: 0,
      chat: { completions: { create } },
    });
    let callbacks = 0;
    const getterBody = openAiBody();
    Object.defineProperty((getterBody['messages'] as Array<object>)[0]!, 'content', {
      enumerable: true,
      get() {
        callbacks += 1;
        return 'getter secret';
      },
    });
    expect(() => client.chat.completions.create(getterBody)).toThrow();

    const proxyBody = openAiBody({
      messages: [
        new Proxy(
          { role: 'user', content: 'proxy secret' },
          {
            get(target, key, receiver) {
              callbacks += 1;
              return Reflect.get(target, key, receiver);
            },
          },
        ),
      ],
    });
    expect(() => client.chat.completions.create(proxyBody)).toThrow();

    const sparseMessages = new Array(1);
    expect(() =>
      client.chat.completions.create(openAiBody({ messages: sparseMessages })),
    ).toThrow();

    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      value() {
        callbacks += 1;
        return { model: 'polluted' };
      },
    });
    try {
      expect(() => client.chat.completions.create(openAiBody())).toThrow();
    } finally {
      delete (Object.prototype as { toJSON?: unknown }).toJSON;
    }
    expect(callbacks).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects top-level __proto__, preserves nested JSON keys safely, and ignores prototype pricing keys', async () => {
    const fetchSpy = installControlFetch();
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const create = vi.fn(() => apiPromise(openAiResponse()));
    const client = wrapOpenAI({
      baseURL: 'https://api.openai.com/v1',
      maxRetries: 0,
      chat: { completions: { create } },
    });
    const topLevel = JSON.parse(
      '{"model":"gpt-test-2026-01-01","messages":[{"role":"user","content":"private prompt"}],"max_completion_tokens":20,"__proto__":{"polluted":true}}',
    ) as Record<string, unknown>;
    expect(() => client.chat.completions.create(topLevel)).toThrow(
      'request_contains_unsupported_field',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();

    let inheritedReads = 0;
    Object.defineProperty(Object.prototype, 'service_tier', {
      configurable: true,
      get() {
        inheritedReads += 1;
        return 'priority';
      },
    });
    try {
      const schema = JSON.parse(
        '{"type":"object","properties":{"city":{"type":"string"}},"__proto__":{"polluted":true}}',
      ) as Record<string, unknown>;
      await client.chat.completions.create(
        openAiBody({
          tools: [
            {
              type: 'function',
              function: { name: 'weather', parameters: schema },
            },
          ],
        }),
      );
      const dispatched = create.mock.calls[0]![0] as Record<string, unknown>;
      const tool = (dispatched['tools'] as Array<Record<string, unknown>>)[0]!;
      const fn = tool['function'] as Record<string, unknown>;
      const dispatchedSchema = fn['parameters'] as Record<string, unknown>;
      expect(Object.getPrototypeOf(dispatchedSchema)).toBeNull();
      expect(Object.prototype.hasOwnProperty.call(dispatchedSchema, '__proto__')).toBe(true);
      expect(dispatchedSchema['__proto__']).toEqual({ polluted: true });
      expect(dispatched['service_tier']).toBe('default');
      expect(inheritedReads).toBe(0);
      const reserveCall = fetchSpy.mock.calls.find(([url]) =>
        String(url).endsWith('/api/v1/budget/reservations'),
      );
      const reserveBody = JSON.parse(String(reserveCall?.[1]?.body)) as Record<string, unknown>;
      expect(reserveBody['estimated_input_tokens']).toBe(
        new TextEncoder().encode(JSON.stringify(dispatched)).byteLength + 256,
      );
    } finally {
      delete (Object.prototype as Record<string, unknown>)['service_tier'];
    }
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it.each(['openai', 'anthropic'] as const)(
    'releases and performs zero %s dispatch when Array.prototype.toJSON changes after reserve',
    async (provider) => {
      let callbacks = 0;
      const fetchSpy = installControlFetch({
        onReserve: (body) => {
          const response = json(reserved(String(body['operation_id'])));
          Object.defineProperty(Array.prototype, 'toJSON', {
            configurable: true,
            value() {
              callbacks += 1;
              return this;
            },
          });
          return response;
        },
      });
      init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
      const create = vi.fn(() =>
        apiPromise(provider === 'openai' ? openAiResponse() : anthropicResponse()),
      );
      try {
        if (provider === 'openai') {
          const client = wrapOpenAI({
            baseURL: 'https://api.openai.com/v1',
            maxRetries: 0,
            chat: { completions: { create } },
          });
          await expect(client.chat.completions.create(openAiBody())).rejects.toMatchObject({
            reason: 'request_json_prototype_is_polluted',
          });
        } else {
          const client = wrapAnthropic({
            baseURL: 'https://api.anthropic.com',
            maxRetries: 0,
            messages: { create },
          });
          await expect(client.messages.create(anthropicBody())).rejects.toMatchObject({
            reason: 'request_json_prototype_is_polluted',
          });
        }
      } finally {
        delete (Array.prototype as unknown as Record<string, unknown>)['toJSON'];
      }
      expect(callbacks).toBe(0);
      expect(create).not.toHaveBeenCalled();
      expect(fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/release'))).toHaveLength(
        1,
      );
      expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(false);
    },
  );

  it.each(['openai', 'anthropic'] as const)(
    'closes the %s facade idempotently and refuses create before any reservation',
    async (provider) => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
      const providerCreate = vi.fn(() =>
        apiPromise(provider === 'openai' ? openAiResponse() : anthropicResponse()),
      );
      const callerClose = vi.fn();
      if (provider === 'openai') {
        const client = wrapOpenAI({
          baseURL: 'https://api.openai.com/v1',
          maxRetries: 0,
          close: callerClose,
          chat: { completions: { create: providerCreate } },
        });
        client.close();
        client.close();
        expect(() => client.chat.completions.create(openAiBody())).toThrow('client_is_closed');
      } else {
        const client = wrapAnthropic({
          baseURL: 'https://api.anthropic.com',
          maxRetries: 0,
          close: callerClose,
          messages: { create: providerCreate },
        });
        client.close();
        client.close();
        expect(() => client.messages.create(anthropicBody())).toThrow('client_is_closed');
      }
      expect(callerClose).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(providerCreate).not.toHaveBeenCalled();
    },
  );

  it.each(['openai', 'anthropic'] as const)(
    'releases a %s reservation and performs zero provider calls when close wins the reserve window',
    async (provider) => {
      let closeFacade: () => unknown = () => undefined;
      const fetchSpy = installControlFetch({
        onReserve: (body) => {
          const response = json(reserved(String(body['operation_id'])));
          closeFacade();
          return response;
        },
      });
      init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
      const providerCreate = vi.fn(() =>
        apiPromise(provider === 'openai' ? openAiResponse() : anthropicResponse()),
      );
      if (provider === 'openai') {
        const client = wrapOpenAI({
          baseURL: 'https://api.openai.com/v1',
          maxRetries: 0,
          chat: { completions: { create: providerCreate } },
        });
        closeFacade = client.close;
        await expect(client.chat.completions.create(openAiBody())).rejects.toMatchObject({
          reason: 'client_is_closed',
        });
      } else {
        const client = wrapAnthropic({
          baseURL: 'https://api.anthropic.com',
          maxRetries: 0,
          messages: { create: providerCreate },
        });
        closeFacade = client.close;
        await expect(client.messages.create(anthropicBody())).rejects.toMatchObject({
          reason: 'client_is_closed',
        });
      }
      expect(providerCreate).not.toHaveBeenCalled();
      expect(fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/release'))).toHaveLength(
        1,
      );
      expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(false);
    },
  );

  it('refuses an Anthropic native stream helper closed between creation and consumption', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'enforce' } });
    const providerCreate = vi.fn(() => apiPromise(anthropicResponse()));
    const stream = vi.fn(function (this: { create: Function }, body: Record<string, unknown>) {
      return {
        finalMessage: () => this.create({ ...body, stream: true }),
      };
    });
    const client = wrapAnthropic({
      baseURL: 'https://api.anthropic.com',
      maxRetries: 0,
      messages: { create: providerCreate, stream },
    });
    const manager = client.messages.stream(anthropicBody());
    client.close();
    expect(() => manager.finalMessage()).toThrow('client_is_closed');
    expect(stream).toHaveBeenCalledTimes(1);
    expect(providerCreate).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses legacy telemetry only for honest non-owned rollout decisions', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ prices: [] }));
    init({ apiKey: KEY, control: { mode: 'legacy' } });
    const response = openAiResponse();
    const client = wrapOpenAI({
      baseURL: 'https://api.openai.com/v1',
      maxRetries: 0,
      chat: { completions: { create: () => apiPromise(response) } },
    });
    await client.chat.completions.create(openAiBody());
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('/api/v1/budget/'))).toBe(
      false,
    );
    expect(bufferSize()).toBe(1);
  });

  it('emits exactly one legacy event across APIPromise views and synchronous provider throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ prices: [] }));
    init({ apiKey: KEY, control: { mode: 'legacy' } });
    const response = openAiResponse();
    const success = wrapOpenAI({
      baseURL: 'https://api.openai.com/v1',
      maxRetries: 0,
      chat: { completions: { create: () => apiPromise(response) } },
    });
    const pending = success.chat.completions.create(openAiBody());
    await pending.withResponse();
    await pending;
    expect(bufferSize()).toBe(1);

    reset();
    init({ apiKey: KEY, control: { mode: 'legacy' } });
    const originalError = new Error('synchronous provider failure');
    const failing = wrapOpenAI({
      baseURL: 'https://api.openai.com/v1',
      maxRetries: 0,
      chat: {
        completions: {
          create: () => {
            throw originalError;
          },
        },
      },
    });
    await expect(failing.chat.completions.create(openAiBody())).rejects.toBe(originalError);
    expect(bufferSize()).toBe(1);
  });

  it('keeps shadow would-deny and enforce-allow unavailability honest with one fallback event', async () => {
    const shadowFetch = installControlFetch({
      onReserve: (body) =>
        json({
          schema_version: '1.0',
          decision: 'bypassed',
          allowed: true,
          decision_id: DECISION_ID,
          operation_id: body['operation_id'],
          reason: 'shadow_would_deny',
          would_have_denied: true,
          warnings: [],
        }),
    });
    init({ apiKey: KEY, endpoint: 'https://control.test', control: { mode: 'shadow' } });
    const response = openAiResponse();
    const shadow = wrapOpenAI({
      baseURL: 'https://api.openai.com/v1',
      maxRetries: 0,
      chat: { completions: { create: () => apiPromise(response) } },
    });
    await shadow.chat.completions.create(openAiBody());
    expect(bufferSize()).toBe(1);
    expect(shadowFetch.mock.calls.some(([url]) => String(url).endsWith('/commit'))).toBe(false);

    vi.restoreAllMocks();
    reset();
    const unavailableFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 404 }));
    init({
      apiKey: KEY,
      endpoint: 'https://control.test',
      control: { mode: 'enforce', onUnavailable: 'allow' },
    });
    const available = wrapOpenAI({
      baseURL: 'https://api.openai.com/v1',
      maxRetries: 0,
      chat: { completions: { create: () => apiPromise(response) } },
    });
    await available.chat.completions.create(openAiBody());
    expect(bufferSize()).toBe(1);
    expect(unavailableFetch).toHaveBeenCalledTimes(1);
  });
});
