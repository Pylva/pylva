// Smoke test for the Vercel AI wrapper. Per D23 this wrapper is thinner
// than openai/anthropic — it runs `maybeEnforcePreCall` for budget
// hard-blocks but skips routing/failover (those happen in the underlying
// provider wrapper). These tests pin down telemetry paths and framework
// attribution.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Framework } from '@pylva/shared';

const cachedRules: unknown[] = [];
const configState = vi.hoisted(() => ({ generation: 1 }));

vi.mock('../src/wrappers/_load.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/wrappers/_load.js')>();
  return { ...actual, loadPeer: vi.fn() };
});

vi.mock('../src/core/rules_cache.js', () => ({
  ensureRulesCache: vi.fn(async () => {}),
  getCachedRules: () => cachedRules,
  isPassthrough: () => false,
}));

vi.mock('../src/core/budget_accumulator.js', () => ({
  check: vi.fn(() => ({ over_limit: false, accumulated_usd: 0, projected_usd: 0 })),
}));

vi.mock('../src/core/config.js', () => ({
  isInitialized: () => true,
  getConfigGeneration: () => configState.generation,
}));

vi.mock('../src/core/telemetry.js', () => ({
  enqueue: vi.fn(),
}));

const { loadPeer } = await import('../src/wrappers/_load.js');
const { applyVercelAiPatch, _resetVercelAiPatchForTests } =
  await import('../src/wrappers/vercel-ai.js');
const { enqueue } = await import('../src/core/telemetry.js');
const { _runInContext } = await import('../src/core/context.js');

interface FakeAiModule {
  generateText: (...args: unknown[]) => Promise<unknown>;
  streamText?: (...args: unknown[]) => unknown;
  generateObject?: (...args: unknown[]) => Promise<unknown>;
}

function buildFakeAiModule(generateText: FakeAiModule['generateText']): FakeAiModule {
  return { generateText };
}

interface EnqueuedEvent {
  provider: string | null;
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  status: string;
  framework?: string;
  metadata?: { token_count_source?: string };
}

type LifecycleCallback = (event: unknown) => unknown;

function lastEvent(): EnqueuedEvent {
  return vi.mocked(enqueue).mock.calls.at(-1)?.[0] as EnqueuedEvent;
}

function getStreamCallArg(streamText: ReturnType<typeof vi.fn>): {
  onFinish?: LifecycleCallback;
  onError?: LifecycleCallback;
  onAbort?: LifecycleCallback;
} {
  return streamText.mock.calls[0]?.[0] as {
    onFinish?: LifecycleCallback;
    onError?: LifecycleCallback;
    onAbort?: LifecycleCallback;
  };
}

beforeEach(() => {
  configState.generation = 1;
  cachedRules.length = 0;
  _resetVercelAiPatchForTests();
  vi.mocked(enqueue).mockClear();
  vi.mocked(loadPeer).mockReset();
});

describe('applyVercelAiPatch', () => {
  it('emits SUCCESS telemetry with model from the model proxy', async () => {
    const generateText = vi.fn(async () => ({
      modelId: 'gpt-4o-2024-08-06',
      usage: { promptTokens: 10, completionTokens: 20 },
    }));
    const mod = buildFakeAiModule(generateText);
    vi.mocked(loadPeer).mockReturnValue(mod);

    applyVercelAiPatch();
    await mod.generateText({ model: { provider: 'openai', modelId: 'gpt-4o' } });

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueue)).toHaveBeenCalledTimes(1);
    const event = lastEvent();
    expect(event.provider).toBe('openai');
    expect(event.model).toBe('gpt-4o-2024-08-06');
    expect(event.tokens_in).toBe(10);
    expect(event.tokens_out).toBe(20);
    expect(event.status).toBe('success');
  });

  it('generateText: emits SUCCESS telemetry with AI SDK v5/v6 usage fields', async () => {
    const generateText = vi.fn(async () => ({
      modelId: 'gpt-4o-2024-08-06',
      usage: { inputTokens: 13, outputTokens: 21, totalTokens: 34 },
    }));
    const mod = buildFakeAiModule(generateText);
    vi.mocked(loadPeer).mockReturnValue(mod);

    applyVercelAiPatch();
    await mod.generateText({ model: { provider: 'openai', modelId: 'gpt-4o' } });

    const event = lastEvent();
    expect(event.tokens_in).toBe(13);
    expect(event.tokens_out).toBe(21);
    expect(event.status).toBe('success');
    expect(event.metadata?.token_count_source).toBe('exact');
  });

  it('generateObject: emits SUCCESS telemetry with AI SDK v5/v6 usage fields', async () => {
    const generateObject = vi.fn(async () => ({
      modelId: 'gpt-4o-2024-08-06',
      usage: { inputTokens: 8, outputTokens: 5, totalTokens: 13 },
    }));
    const mod = buildFakeAiModule(vi.fn(async () => ({})));
    mod.generateObject = generateObject;
    vi.mocked(loadPeer).mockReturnValue(mod);

    applyVercelAiPatch();
    await mod.generateObject({ model: { provider: 'openai', modelId: 'gpt-4o' } });

    const event = lastEvent();
    expect(event.tokens_in).toBe(8);
    expect(event.tokens_out).toBe(5);
    expect(event.status).toBe('success');
    expect(event.metadata?.token_count_source).toBe('exact');
  });

  it('preserves Vercel-style compound provider and model strings', async () => {
    const generateText = vi.fn(async () => ({
      modelId: 'ft:gpt-4o-mini:org/name+v1@prod',
      usage: { promptTokens: 1, completionTokens: 1 },
    }));
    const mod = buildFakeAiModule(generateText);
    vi.mocked(loadPeer).mockReturnValue(mod);

    applyVercelAiPatch();
    await mod.generateText({
      model: {
        provider: 'openai.chat',
        modelId: 'ft:gpt-4o-mini:org/name+v1@prod',
      },
    });

    const event = lastEvent();
    expect(event.provider).toBe('openai.chat');
    expect(event.model).toBe('ft:gpt-4o-mini:org/name+v1@prod');
  });

  it('preserves DeepSeek provider and LangGraph framework from track context', async () => {
    const generateText = vi.fn(async () => ({
      modelId: 'deepseek-chat',
      usage: { promptTokens: 9, completionTokens: 14 },
    }));
    const mod = buildFakeAiModule(generateText);
    vi.mocked(loadPeer).mockReturnValue(mod);

    applyVercelAiPatch();
    await _runInContext(
      {
        customer_id: 'cust_1',
        trace_id: 't',
        span_id: 's',
        parent_span_id: null,
        step_name: 'answer_question',
        framework: Framework.LANGGRAPH,
        run_id: 'r',
        parent_run_id: null,
      },
      () =>
        mod.generateText({
          model: { provider: 'deepseek', modelId: 'deepseek-chat' },
        }) as Promise<unknown>,
    );

    const event = lastEvent();
    expect(event.provider).toBe('deepseek');
    expect(event.framework).toBe('langgraph');
    expect(event.model).toBe('deepseek-chat');
  });

  it('emits FAILURE telemetry on real provider errors', async () => {
    const generateText = vi.fn(async () => {
      throw new Error('upstream 500');
    });
    const mod = buildFakeAiModule(generateText);
    vi.mocked(loadPeer).mockReturnValue(mod);

    applyVercelAiPatch();
    await expect(
      mod.generateText({ model: { provider: 'anthropic', modelId: 'claude-sonnet' } }),
    ).rejects.toThrow('upstream 500');

    expect(vi.mocked(enqueue)).toHaveBeenCalledTimes(1);
    const event = lastEvent();
    expect(event.status).toBe('failure');
    expect(event.provider).toBe('anthropic');
  });

  it('streamText: returns synchronously and emits v3/v4 usage from onFinish', () => {
    const streamResult = { modelId: 'gpt-4o-2024-08-06' };
    const onFinish = vi.fn();
    const streamText = vi.fn(() => streamResult);
    const mod = buildFakeAiModule(vi.fn(async () => ({})));
    mod.streamText = streamText;
    vi.mocked(loadPeer).mockReturnValue(mod);

    applyVercelAiPatch();
    const patchedResult = mod.streamText({
      model: { provider: 'openai', modelId: 'gpt-4o' },
      onFinish,
    });

    expect(patchedResult).toBe(streamResult);
    expect(vi.mocked(enqueue)).not.toHaveBeenCalled();

    const finishEvent = {
      response: { modelId: 'gpt-4o-2024-08-06' },
      usage: { promptTokens: 11, completionTokens: 22 },
    };
    getStreamCallArg(streamText).onFinish?.(finishEvent);

    expect(onFinish).toHaveBeenCalledWith(finishEvent);
    expect(vi.mocked(enqueue)).toHaveBeenCalledTimes(1);
    const event = lastEvent();
    expect(event.tokens_in).toBe(11);
    expect(event.tokens_out).toBe(22);
    expect(event.status).toBe('success');
    expect(event.metadata?.token_count_source).toBe('exact');
  });

  it('streamText: emits v5/v6 usage from onFinish totalUsage', () => {
    const streamText = vi.fn(() => ({ modelId: 'gpt-4o-2024-08-06' }));
    const mod = buildFakeAiModule(vi.fn(async () => ({})));
    mod.streamText = streamText;
    vi.mocked(loadPeer).mockReturnValue(mod);

    applyVercelAiPatch();
    mod.streamText({ model: { provider: 'openai', modelId: 'gpt-4o' } });
    getStreamCallArg(streamText).onFinish?.({
      response: { modelId: 'gpt-4o-2024-08-06' },
      totalUsage: { inputTokens: 34, outputTokens: 55, totalTokens: 89 },
    });

    const event = lastEvent();
    expect(event.tokens_in).toBe(34);
    expect(event.tokens_out).toBe(55);
    expect(event.status).toBe('success');
    expect(event.metadata?.token_count_source).toBe('exact');
  });

  it('streamText: preserves the host callback but drops an old-identity terminal event', () => {
    const onFinish = vi.fn();
    const streamText = vi.fn(() => ({ modelId: 'gpt-4o-2024-08-06' }));
    const mod = buildFakeAiModule(vi.fn(async () => ({})));
    mod.streamText = streamText;
    vi.mocked(loadPeer).mockReturnValue(mod);

    applyVercelAiPatch();
    mod.streamText({
      model: { provider: 'openai', modelId: 'gpt-4o' },
      onFinish,
    });
    configState.generation += 1;
    const finish = {
      response: { modelId: 'gpt-4o-2024-08-06' },
      totalUsage: { inputTokens: 34, outputTokens: 55 },
    };
    getStreamCallArg(streamText).onFinish?.(finish);

    expect(onFinish).toHaveBeenCalledWith(finish);
    expect(vi.mocked(enqueue)).not.toHaveBeenCalled();
  });

  it('streamText: emits FAILURE once and preserves user onError', () => {
    const onError = vi.fn();
    const streamText = vi.fn(() => ({ modelId: 'gpt-4o-2024-08-06' }));
    const mod = buildFakeAiModule(vi.fn(async () => ({})));
    mod.streamText = streamText;
    vi.mocked(loadPeer).mockReturnValue(mod);

    applyVercelAiPatch();
    mod.streamText({ model: { provider: 'openai', modelId: 'gpt-4o' }, onError });
    const errorEvent = { error: new Error('stream failed') };
    getStreamCallArg(streamText).onError?.(errorEvent);
    getStreamCallArg(streamText).onError?.(errorEvent);

    expect(onError).toHaveBeenCalledTimes(2);
    expect(vi.mocked(enqueue)).toHaveBeenCalledTimes(1);
    const event = lastEvent();
    expect(event.status).toBe('failure');
    expect(event.tokens_in).toBe(0);
    expect(event.tokens_out).toBe(0);
  });

  it('streamText: does not log raw provider errors when the app has no onError handler', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const streamText = vi.fn(() => ({ modelId: 'gpt-4o-2024-08-06' }));
    const mod = buildFakeAiModule(vi.fn(async () => ({})));
    mod.streamText = streamText;
    vi.mocked(loadPeer).mockReturnValue(mod);

    try {
      applyVercelAiPatch();
      mod.streamText({ model: { provider: 'openai', modelId: 'gpt-4o' } });
      getStreamCallArg(streamText).onError?.({
        error: new Error('SECRET_PROMPT_SHOULD_NOT_BE_LOGGED'),
      });

      expect(consoleError).not.toHaveBeenCalled();
      expect(vi.mocked(enqueue)).toHaveBeenCalledTimes(1);
      expect(lastEvent().status).toBe('failure');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('streamText: emits ABORTED once and preserves user onAbort', () => {
    const onAbort = vi.fn();
    const streamText = vi.fn(() => ({ modelId: 'gpt-4o-2024-08-06' }));
    const mod = buildFakeAiModule(vi.fn(async () => ({})));
    mod.streamText = streamText;
    vi.mocked(loadPeer).mockReturnValue(mod);

    applyVercelAiPatch();
    mod.streamText({ model: { provider: 'openai', modelId: 'gpt-4o' }, onAbort });
    const abortEvent = { steps: [] };
    getStreamCallArg(streamText).onAbort?.(abortEvent);
    getStreamCallArg(streamText).onAbort?.(abortEvent);

    expect(onAbort).toHaveBeenCalledTimes(2);
    expect(vi.mocked(enqueue)).toHaveBeenCalledTimes(1);
    const event = lastEvent();
    expect(event.status).toBe('aborted');
    expect(event.tokens_in).toBe(0);
    expect(event.tokens_out).toBe(0);
  });

  it('uses the installed manifest when the public JSON module is cache-poisoned', () => {
    const onAbort = vi.fn();
    const streamText = vi.fn(() => ({ modelId: 'gpt-4o-2024-08-06' }));
    const mod = buildFakeAiModule(vi.fn(async () => ({})));
    mod.streamText = streamText;
    vi.mocked(loadPeer).mockImplementation(((specifier: string) =>
      specifier === 'ai' ? mod : { version: '3.0.0-poisoned' }) as typeof loadPeer);

    applyVercelAiPatch();
    mod.streamText({ model: { provider: 'openai', modelId: 'gpt-4o' }, onAbort });
    const abortEvent = { steps: [] };
    getStreamCallArg(streamText).onAbort?.(abortEvent);
    getStreamCallArg(streamText).onAbort?.(abortEvent);

    expect(vi.mocked(loadPeer)).not.toHaveBeenCalledWith('ai/package.json');
    expect(onAbort).toHaveBeenCalledTimes(2);
    expect(vi.mocked(enqueue)).toHaveBeenCalledTimes(1);
    expect(lastEvent().status).toBe('aborted');
  });

  it('is idempotent — applying twice does not double-wrap', async () => {
    const generateText = vi.fn(async () => ({
      modelId: 'gpt-4o',
      usage: { promptTokens: 1, completionTokens: 2 },
    }));
    const mod = buildFakeAiModule(generateText);
    vi.mocked(loadPeer).mockReturnValue(mod);

    applyVercelAiPatch();
    applyVercelAiPatch();
    await mod.generateText({ model: { provider: 'openai.chat', modelId: 'gpt-4o' } });

    expect(vi.mocked(enqueue)).toHaveBeenCalledTimes(1);
  });

  it('silently skips getter-only ESM exports instead of surfacing auto-patch noise', async () => {
    const generateText = vi.fn(async () => ({
      modelId: 'gpt-4o',
      usage: { promptTokens: 1, completionTokens: 2 },
    }));
    const mod: Record<string, unknown> = {};
    Object.defineProperty(mod, 'generateText', {
      enumerable: true,
      configurable: false,
      get: () => generateText,
    });
    vi.mocked(loadPeer).mockReturnValue(mod);

    expect(() => applyVercelAiPatch()).not.toThrow();
    await (mod['generateText'] as FakeAiModule['generateText'])({
      model: { provider: 'openai', modelId: 'gpt-4o' },
    });

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueue)).not.toHaveBeenCalled();
  });
});
