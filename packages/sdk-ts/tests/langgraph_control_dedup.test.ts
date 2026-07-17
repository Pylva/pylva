import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { CallbackManager } from '@langchain/core/callbacks/manager';
import { HumanMessage } from '@langchain/core/messages';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetConfigForTests, getConfigGeneration } from '../src/core/config.js';
import { _resetControlClientForTests } from '../src/core/control_client.js';
import {
  linkControlledCallbackNoDispatch,
  linkLocalControlledCallbackNoDispatch,
  runWithControlledOperation,
  type ControlledLlmOperationCorrelation,
  type ControlledToolOperationCorrelation,
} from '../src/core/control_correlation.js';
import { controlledUsage } from '../src/core/controlled_usage.js';
import { enqueue } from '../src/core/telemetry.js';
import { controlledTavilySearch } from '../src/adapters/tavily.js';
import { PylvaCallbackHandler, withLangGraphControlScope } from '../src/langgraph.js';
import { _wrapAnthropicForTests as wrapAnthropic } from '../src/wrappers/anthropic_controlled.js';
import { _wrapOpenAIForTests as wrapOpenAI } from '../src/wrappers/openai_controlled.js';
import { _resetVercelAiPatchForTests, controlledGenerateText } from '../src/wrappers/vercel-ai.js';

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  flush: vi.fn(async () => undefined),
  initAccumulator: vi.fn(async () => undefined),
  generateText: vi.fn(),
}));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateText: (input: unknown) => mocks.generateText(input),
  };
});

vi.mock('../src/core/telemetry.js', () => ({
  enqueue: mocks.enqueue,
  flush: mocks.flush,
}));

vi.mock('../src/core/budget_accumulator.js', () => ({
  initAccumulator: mocks.initAccumulator,
}));

const KEY_A = `pv_live_aabbccdd_${'a'.repeat(32)}`;
const KEY_B = `pv_live_bbccddee_${'b'.repeat(32)}`;

function runId(n: number): string {
  return `${n.toString(16).padStart(8, '0')}-1111-4111-8111-${n.toString(16).padStart(12, '0')}`;
}

function llmCorrelation(
  n: number,
  overrides: Partial<ControlledLlmOperationCorrelation> = {},
): ControlledLlmOperationCorrelation {
  return {
    kind: 'llm',
    configGeneration: getConfigGeneration(),
    operationId: runId(1_000 + n),
    reservationId: runId(2_000 + n),
    traceId: runId(3_000 + n),
    spanId: runId(4_000 + n),
    parentSpanId: null,
    customerId: 'customer_acme',
    provider: 'openai',
    model: 'gpt-4o-mini',
    ownsReservation: true,
    legacyTelemetryRequired: false,
    ...overrides,
  };
}

function toolCorrelation(n: number): ControlledToolOperationCorrelation {
  return {
    kind: 'tool',
    configGeneration: getConfigGeneration(),
    operationId: runId(5_000 + n),
    reservationId: runId(6_000 + n),
    traceId: runId(7_000 + n),
    spanId: runId(8_000 + n),
    parentSpanId: null,
    customerId: 'customer_acme',
    costSourceSlug: 'tavily-search',
    toolName: 'tavily_search',
    metric: 'searches',
    ownsReservation: true,
    legacyTelemetryRequired: false,
  };
}

function startLlm(handler: PylvaCallbackHandler, id: string): void {
  handler.handleChatModelStart(
    { name: 'ChatOpenAI' },
    [[new HumanMessage('PRIVATE PROMPT')]],
    id,
    undefined,
    { invocation_params: { provider: 'openai', model: 'gpt-4o-mini' } },
    [],
    { pylva_customer_id: 'customer_acme', langgraph_node: 'call_model' },
    'chat_model',
  );
}

function endLlm(handler: PylvaCallbackHandler, id: string): void {
  handler.handleLLMEnd(
    {
      llmOutput: {
        tokenUsage: { promptTokens: 4, completionTokens: 2 },
        provider: 'openai',
        model: 'gpt-4o-mini',
      },
    },
    id,
  );
}

function startTool(handler: PylvaCallbackHandler, id: string, name: string): void {
  handler.handleToolStart(
    { name },
    'PRIVATE INPUT',
    id,
    undefined,
    [],
    { pylva_customer_id: 'customer_acme', langgraph_node: 'tool' },
    name,
  );
}

async function captureError(invoke: () => unknown): Promise<unknown> {
  try {
    await invoke();
  } catch (error) {
    return error;
  }
  throw new Error('expected invocation to refuse');
}

class ControlledFakeListChatModel extends FakeListChatModel {
  constructor(private readonly correlation: ControlledLlmOperationCorrelation) {
    super({ responses: ['ok'] });
  }

  override _generate(
    ...args: Parameters<FakeListChatModel['_generate']>
  ): ReturnType<FakeListChatModel['_generate']> {
    // BaseChatModel emits callback start before entering _generate, matching
    // real provider-wrapper ordering.
    return runWithControlledOperation(this.correlation, () => super._generate(...args));
  }
}

describe('LangGraph exact controlled-operation de-duplication', () => {
  beforeEach(() => {
    _resetControlClientForTests();
    _resetConfigForTests();
    mocks.enqueue.mockReset();
    mocks.flush.mockReset();
    mocks.flush.mockResolvedValue(undefined);
    mocks.initAccumulator.mockReset();
    mocks.initAccumulator.mockResolvedValue(undefined);
    mocks.generateText.mockReset();
  });

  afterEach(() => {
    _resetVercelAiPatchForTests();
    _resetControlClientForTests();
    _resetConfigForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('defaults to auto and suppresses a RESERVED wrapper-owned LLM callback', () => {
    const handler = new PylvaCallbackHandler();
    const id = runId(1);

    runWithControlledOperation(llmCorrelation(1), () => startLlm(handler, id));
    // Terminal callbacks normally arrive after the provider-dispatch scope.
    endLlm(handler, id);
    handler.handleLLMError(new Error('late duplicate'), id);

    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it.each(['bypassed', 'unavailable'] as const)(
    'lets the strict wrapper own the one legacy event for %s attempts',
    (decision) => {
      const handler = new PylvaCallbackHandler();
      const id = runId(decision === 'bypassed' ? 2 : 3);
      const correlation = llmCorrelation(decision === 'bypassed' ? 2 : 3, {
        reservationId: null,
        ownsReservation: false,
        legacyTelemetryRequired: true,
      });

      runWithControlledOperation(correlation, () => startLlm(handler, id));
      // Simulate the strict wrapper's single fallback event. The callback
      // must not add a second billable record.
      enqueue({ owner: 'strict-wrapper', decision } as never);
      endLlm(handler, id);

      expect(mocks.enqueue).toHaveBeenCalledTimes(1);
      expect(mocks.enqueue.mock.calls[0]?.[0]).toEqual({
        owner: 'strict-wrapper',
        decision,
      });
    },
  );

  it('keeps explicit callback-only mode and validates mode values', () => {
    const handler = new PylvaCallbackHandler({ llmTracking: 'callback' });
    const id = runId(4);

    runWithControlledOperation(llmCorrelation(4), () => startLlm(handler, id));
    endLlm(handler, id);

    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(() => new PylvaCallbackHandler({ llmTracking: 'invalid' as 'auto' })).toThrow(
      "llmTracking must be 'auto', 'callback', or 'off'",
    );
  });

  it('off mode ignores direct LLM callbacks', () => {
    const handler = new PylvaCallbackHandler({ llmTracking: 'off' });
    const id = runId(5);
    expect(handler.ignoreLLM).toBe(true);

    startLlm(handler, id);
    endLlm(handler, id);
    handler.handleLLMError(new Error('ignored'), id);

    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('suppresses only an exact same-kind controlled tool callback', () => {
    const handler = new PylvaCallbackHandler({ trackToolCalls: true });
    const owned = runId(6);
    const unrelated = runId(7);

    runWithControlledOperation(toolCorrelation(6), () => {
      handler.handleToolStart(
        { name: 'tavily_search' },
        'PRIVATE QUERY',
        owned,
        undefined,
        [],
        { pylva_customer_id: 'customer_acme', langgraph_node: 'search' },
        'tavily_search',
      );
    });
    handler.handleToolEnd('PRIVATE RESULT', owned);

    runWithControlledOperation(llmCorrelation(7), () => {
      handler.handleToolStart(
        { name: 'tavily_search' },
        'PRIVATE QUERY',
        unrelated,
        undefined,
        [],
        { pylva_customer_id: 'customer_acme', langgraph_node: 'search' },
        'tavily_search',
      );
    });
    handler.handleToolEnd('PRIVATE RESULT', unrelated);

    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue.mock.calls[0]?.[0]).toMatchObject({ tool_name: 'tavily_search' });
  });

  it('isolates nested and concurrent identical-model attempts by exact context', async () => {
    const handler = new PylvaCallbackHandler();
    const ids = [runId(8), runId(9), runId(10), runId(11)];

    runWithControlledOperation(llmCorrelation(8), () => {
      startLlm(handler, ids[0]!);
      runWithControlledOperation(llmCorrelation(9), () => startLlm(handler, ids[1]!));
    });

    await Promise.all(
      [2, 3].map(async (index) => {
        await runWithControlledOperation(llmCorrelation(8 + index), async () => {
          startLlm(handler, ids[index]!);
          await Promise.resolve();
        });
      }),
    );

    for (const id of ids) endLlm(handler, id);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('does not let an inherited outer LLM hide a nested unwrapped callback', () => {
    const handler = new PylvaCallbackHandler();
    const id = runId(23);

    runWithControlledOperation(llmCorrelation(23), () => {
      withLangGraphControlScope(() => startLlm(handler, id));
    });
    endLlm(handler, id);

    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it('links a nested callback to its inner controlled LLM, not the inherited outer one', () => {
    const handler = new PylvaCallbackHandler();
    const id = runId(24);

    runWithControlledOperation(llmCorrelation(23), () => {
      withLangGraphControlScope(() => {
        startLlm(handler, id);
        runWithControlledOperation(llmCorrelation(24), () => 'inner-result');
      });
    });
    endLlm(handler, id);

    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('drops a wrapper-owned completion after SDK identity reinitialization', () => {
    const handler = new PylvaCallbackHandler({ apiKey: KEY_A, endpoint: 'https://same.test' });
    const id = runId(12);
    runWithControlledOperation(llmCorrelation(12), () => startLlm(handler, id));

    new PylvaCallbackHandler({ apiKey: KEY_B, endpoint: 'https://same.test' });
    endLlm(handler, id);

    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('links callback-first/provider-second ordering inside a real StateGraph journey', async () => {
    const handler = new PylvaCallbackHandler();
    const model = new ControlledFakeListChatModel(llmCorrelation(13));
    const State = Annotation.Root({ value: Annotation<string>() });
    const graph = new StateGraph(State)
      .addNode('call_model', async (state) => {
        const response = await withLangGraphControlScope(() =>
          model.invoke([new HumanMessage(state.value)], {
            callbacks: [handler],
            metadata: {
              pylva_customer_id: 'customer_acme',
              langgraph_node: 'call_model',
            },
          }),
        );
        return { value: String(response.content) };
      })
      .addEdge(START, 'call_model')
      .addEdge('call_model', END)
      .compile();

    const result = await graph.invoke(
      { value: 'hello' },
      {
        metadata: { pylva_customer_id: 'customer_acme' },
      },
    );

    expect(result.value).toBe('ok');
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('suppresses the exact LLM callback when control refuses before provider dispatch', () => {
    const handler = new PylvaCallbackHandler();
    const id = runId(25);

    withLangGraphControlScope(() => {
      startLlm(handler, id);
      linkControlledCallbackNoDispatch({
        kind: 'llm',
        configGeneration: getConfigGeneration(),
        operationId: runId(9_025),
      });
    });
    handler.handleLLMError(new Error('budget refused'), id);

    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('suppresses the exact tool callback when control refuses before tool dispatch', () => {
    const handler = new PylvaCallbackHandler({ trackToolCalls: true });
    const id = runId(26);

    withLangGraphControlScope(() => {
      handler.handleToolStart(
        { name: 'tavily_search' },
        'PRIVATE QUERY',
        id,
        undefined,
        [],
        { pylva_customer_id: 'customer_acme', langgraph_node: 'search' },
        'tavily_search',
      );
      linkControlledCallbackNoDispatch({
        kind: 'tool',
        configGeneration: getConfigGeneration(),
        operationId: runId(9_026),
      });
    });
    handler.handleToolError(new Error('budget refused'), id);

    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it.each(['openai', 'anthropic'] as const)(
    'links a real strict %s local refusal without provider dispatch or a legacy event',
    async (provider) => {
      const handler = new PylvaCallbackHandler();
      const id = runId(provider === 'openai' ? 27 : 28);
      const providerCall = vi.fn(async (_body: unknown) => ({}));
      const invoke =
        provider === 'openai'
          ? () =>
              wrapOpenAI({
                baseURL: 'https://api.openai.com/v1',
                maxRetries: 0,
                chat: { completions: { create: providerCall } },
              }).chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: 'private' }],
                max_completion_tokens: 8,
                unsupported_paid_feature: true,
              })
          : () =>
              wrapAnthropic({
                baseURL: 'https://api.anthropic.com',
                maxRetries: 0,
                messages: { create: providerCall },
              }).messages.create({
                model: 'claude-3-5-haiku-latest',
                messages: [{ role: 'user', content: 'private' }],
                max_tokens: 8,
                unsupported_paid_feature: true,
              });
      let error: unknown;

      await withLangGraphControlScope(async () => {
        startLlm(handler, id);
        error = await captureError(invoke);
      });
      handler.handleLLMError(error, id);

      expect(error).toMatchObject({ name: 'PylvaStrictProviderError' });
      expect(providerCall).not.toHaveBeenCalled();
      expect(mocks.enqueue).not.toHaveBeenCalled();
    },
  );

  it('links a real strict Vercel AI local refusal without provider dispatch or a legacy event', async () => {
    const handler = new PylvaCallbackHandler();
    const id = runId(29);
    mocks.generateText.mockResolvedValue({ text: 'must not run' });
    let error: unknown;

    await withLangGraphControlScope(async () => {
      startLlm(handler, id);
      error = await captureError(() => controlledGenerateText({}));
    });
    handler.handleLLMError(error, id);

    expect(error).toMatchObject({ name: 'PylvaStrictProviderError' });
    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('links a real Tavily alias refusal without tool dispatch or a legacy event', async () => {
    const handler = new PylvaCallbackHandler({ trackToolCalls: true });
    const id = runId(30);
    const search = vi.fn(async () => ({ usage: { credits: 1 } }));
    let error: unknown;

    await withLangGraphControlScope(async () => {
      startTool(handler, id, 'tavily_search');
      error = await captureError(() =>
        controlledTavilySearch(
          { search },
          {
            query: 'private query',
            customerId: 'customer_acme',
            searchOptions: { search_depth: 'advanced' },
          },
        ),
      );
    });
    handler.handleToolError(error, id);

    expect(error).toMatchObject({ name: 'PylvaControlValidationError' });
    expect(search).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('links a real generic validation refusal without tool dispatch or a legacy event', async () => {
    const handler = new PylvaCallbackHandler({ trackToolCalls: true });
    const id = runId(31);
    const invoke = vi.fn(async () => ({ count: 1 }));
    let error: unknown;

    await withLangGraphControlScope(async () => {
      startTool(handler, id, 'generic_tool');
      error = await captureError(() =>
        controlledUsage({
          costSourceSlug: 'generic',
          toolName: 'generic_tool',
          metric: 'calls',
          maximumValue: -1,
          customerId: 'customer_acme',
          invoke,
          extractActual: (value) => value.count,
        }),
      );
    });
    handler.handleToolError(error, id);

    expect(error).toMatchObject({ name: 'PylvaControlValidationError' });
    expect(invoke).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('links an after-reserve beforeInvoke refusal with the real operation ID', async () => {
    const reservationId = runId(40_001);
    let reservedOperationId: string | null = null;
    const controlJson = (body: unknown): Response =>
      new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json', 'x-request-id': 'req_langgraph' },
      });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, request?: RequestInit) => {
        const href = String(url);
        if (href.endsWith('/api/v1/budget/capabilities')) {
          return controlJson({
            schema_version: '1.0',
            control_enabled: true,
            min_reservation_ttl_seconds: 30,
            default_reservation_ttl_seconds: 300,
            max_reservation_ttl_seconds: 3_600,
            server_time: '2026-07-14T09:00:00.000Z',
          });
        }
        if (href.endsWith('/api/v1/budget/reservations')) {
          const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
          reservedOperationId = String(body['operation_id']);
          return controlJson({
            schema_version: '1.0',
            decision: 'reserved',
            allowed: true,
            decision_id: runId(40_002),
            operation_id: reservedOperationId,
            reservation_id: reservationId,
            state: 'reserved',
            reserved_usd: '1',
            remaining_usd: '9',
            expires_at: '2026-07-14T09:05:00.000Z',
            warnings: [],
          });
        }
        if (href.endsWith(`/${reservationId}/release`)) {
          return controlJson({
            schema_version: '1.0',
            state: 'released',
            reservation_id: reservationId,
            operation_id: reservedOperationId,
            released_usd: '1',
            released_at: '2026-07-14T09:01:00.000Z',
            idempotent_replay: false,
          });
        }
        throw new Error(`unexpected control URL ${href}`);
      }),
    );
    const handler = new PylvaCallbackHandler({
      apiKey: KEY_A,
      endpoint: 'https://control.test',
      localMode: true,
      control: { mode: 'enforce', onUnavailable: 'deny' },
      trackToolCalls: true,
    });
    const id = runId(33);
    const invoke = vi.fn(async () => ({ count: 1 }));
    let linkedOperationId: string | null | undefined;
    let error: unknown;

    await withLangGraphControlScope(async () => {
      startTool(handler, id, 'generic_tool');
      error = await captureError(() =>
        controlledUsage({
          costSourceSlug: 'generic',
          toolName: 'generic_tool',
          metric: 'calls',
          maximumValue: 1,
          customerId: 'customer_acme',
          beforeInvoke: () => 'refuse' as never,
          invoke,
          extractActual: (value) => value.count,
        }),
      );
      const run = (
        handler as unknown as {
          runs: Map<
            string,
            {
              controlled_callback: {
                controlledNoDispatch: { operationId: string } | null;
              } | null;
            }
          >;
        }
      ).runs.get(id);
      linkedOperationId = run?.controlled_callback?.controlledNoDispatch?.operationId;
    });
    handler.handleToolError(error, id);

    expect(reservedOperationId).not.toBeNull();
    expect(linkedOperationId).toBe(reservedOperationId);
    expect(invoke).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('keeps real post-dispatch ownership without a zero-pending no-dispatch warning', () => {
    const handler = new PylvaCallbackHandler();
    const id = runId(32);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    withLangGraphControlScope(() => {
      startLlm(handler, id);
      runWithControlledOperation(llmCorrelation(32), () => {
        linkLocalControlledCallbackNoDispatch('llm');
      });
    });
    handler.handleLLMError(new Error('post-dispatch invalid client'), id);

    expect(warning).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('does not let post-dispatch response evidence steal a later pending callback', async () => {
    const handler = new PylvaCallbackHandler({
      apiKey: KEY_A,
      endpoint: 'https://unit.invalid',
      localMode: true,
      control: { mode: 'legacy', onUnavailable: 'allow' },
    });
    const ownedId = runId(34);
    const laterId = runId(35);
    let resolveProvider: ((value: unknown) => void) | undefined;
    const providerResponse = new Promise<unknown>((resolve) => {
      resolveProvider = resolve;
    });
    const providerCall = vi.fn((_body: unknown) => providerResponse);
    const client = wrapOpenAI({
      baseURL: 'https://api.openai.com/v1',
      maxRetries: 0,
      chat: { completions: { create: providerCall } },
    });

    await withLangGraphControlScope(async () => {
      startLlm(handler, ownedId);
      const pending = client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'private' }],
        max_completion_tokens: 8,
      });
      for (let turn = 0; turn < 10 && providerCall.mock.calls.length === 0; turn += 1) {
        await Promise.resolve();
      }
      expect(providerCall).toHaveBeenCalledTimes(1);
      startLlm(handler, laterId);
      resolveProvider?.({
        model: 'gpt-4o-mini',
        service_tier: 'default',
        usage: null,
      });
      await pending;
    });
    handler.handleLLMError(new Error('owned post-dispatch error'), ownedId);
    handler.handleLLMError(new Error('unlinked later error'), laterId);

    expect(providerCall).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it('records one callback-only model event inside a real StateGraph journey', async () => {
    const handler = new PylvaCallbackHandler({ llmTracking: 'callback' });
    const model = new FakeListChatModel({ responses: ['ok'] });
    const State = Annotation.Root({ value: Annotation<string>() });
    const graph = new StateGraph(State)
      .addNode('call_model', async (state) => {
        const response = await model.invoke([new HumanMessage(state.value)], {
          callbacks: [handler],
          metadata: {
            pylva_customer_id: 'customer_acme',
            langgraph_node: 'call_model',
          },
        });
        return { value: String(response.content) };
      })
      .addEdge(START, 'call_model')
      .addEdge('call_model', END)
      .compile();

    const result = await graph.invoke({ value: 'hello' });

    expect(result.value).toBe('ok');
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue.mock.calls[0]?.[0]).toMatchObject({
      framework: 'langgraph',
      customer_id: 'customer_acme',
      step_name: 'call_model',
    });
  });

  it('links a callback-first controlled tool through the public scope', () => {
    const handler = new PylvaCallbackHandler({ trackToolCalls: true });
    const id = runId(19);

    withLangGraphControlScope(() => {
      handler.handleToolStart(
        { name: 'tavily_search' },
        'PRIVATE QUERY',
        id,
        undefined,
        [],
        { pylva_customer_id: 'customer_acme', langgraph_node: 'search' },
        'tavily_search',
      );
      runWithControlledOperation(toolCorrelation(19), () => 'ok');
    });
    handler.handleToolEnd('PRIVATE RESULT', id);

    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('isolates concurrent identical callback metadata in separate public scopes', async () => {
    const handler = new PylvaCallbackHandler();
    const models = [14, 15].map((index) => new ControlledFakeListChatModel(llmCorrelation(index)));
    const State = Annotation.Root({ value: Annotation<string>() });
    const graph = new StateGraph(State)
      .addNode('parallel_calls', async () => {
        const values = await Promise.all(
          models.map((model) =>
            withLangGraphControlScope(async () => {
              const response = await model.invoke([new HumanMessage('same')], {
                callbacks: [handler],
                metadata: {
                  pylva_customer_id: 'customer_acme',
                  langgraph_node: 'same_node',
                },
              });
              return String(response.content);
            }),
          ),
        );
        return { value: values.join(',') };
      })
      .addEdge(START, 'parallel_calls')
      .addEdge('parallel_calls', END)
      .compile();

    const result = await graph.invoke({ value: 'hello' });

    expect(result.value).toBe('ok,ok');
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('never guesses when one scope contains multiple pending callbacks', async () => {
    const handler = new PylvaCallbackHandler();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const manager = new CallbackManager();
    manager.addHandler(handler);
    const ids = [runId(16), runId(17)];

    await withLangGraphControlScope(async () => {
      const runs = await manager.handleChatModelStart(
        { name: 'ChatOpenAI' },
        [[new HumanMessage('A')], [new HumanMessage('B')]],
        ids[0],
      );
      runWithControlledOperation(llmCorrelation(16), () => 'ok');
      await Promise.all(
        runs.map((run) =>
          run.handleLLMEnd({
            llmOutput: { tokenUsage: { promptTokens: 1, completionTokens: 1 } },
          }),
        ),
      );
    });

    expect(warning).toHaveBeenCalledWith(expect.stringContaining('found 2 pending llm callbacks'));
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
  });

  it('warns instead of linking a provider attempt with no pending callback', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    withLangGraphControlScope(() => {
      runWithControlledOperation(llmCorrelation(18), () => 'ok');
    });

    expect(warning).toHaveBeenCalledWith(expect.stringContaining('found 0 pending llm callbacks'));
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('never lets a throwing warning hook block provider dispatch', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('host logger failed');
    });
    const dispatch = vi.fn(() => 'provider-result');

    const value = withLangGraphControlScope(() =>
      runWithControlledOperation(llmCorrelation(22), dispatch),
    );

    expect(value).toBe('provider-result');
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('fences provider correlation inherited by an orphan task after invoke settles', async () => {
    const handler = new PylvaCallbackHandler();
    const id = runId(20);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let orphan!: Promise<void>;

    await runWithControlledOperation(llmCorrelation(20), async () => {
      orphan = (async () => {
        await gate;
        startLlm(handler, id);
      })();
    });
    release();
    await orphan;
    endLlm(handler, id);

    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it('fences a public rendezvous inherited by an orphan task after scope settles', async () => {
    const handler = new PylvaCallbackHandler();
    const id = runId(21);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let orphan!: Promise<void>;

    await withLangGraphControlScope(async () => {
      orphan = (async () => {
        await gate;
        startLlm(handler, id);
        runWithControlledOperation(llmCorrelation(21), () => 'ok');
      })();
    });
    release();
    await orphan;
    endLlm(handler, id);

    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });
});
