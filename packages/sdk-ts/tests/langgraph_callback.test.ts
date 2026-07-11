import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { CallbackManager } from '@langchain/core/callbacks/manager';
import { HumanMessage } from '@langchain/core/messages';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CostSource,
  EventStatus,
  Framework,
  InstrumentationTier,
  Provider,
  TokenCountSource,
} from '@pylva/shared';
import { _resetConfigForTests } from '../src/core/config.js';
import { track } from '../src/core/context.js';
import { enqueue } from '../src/core/telemetry.js';
import {
  PylvaCallbackHandler,
  AsyncPylvaCallbackHandler,
} from '../src/langgraph.js';
import { PylvaCallbackHandler as LangChainPylvaCallbackHandler } from '../src/langchain.js';

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  flush: vi.fn(async () => undefined),
  initAccumulator: vi.fn(async () => undefined),
}));

vi.mock('../src/core/telemetry.js', () => ({
  enqueue: mocks.enqueue,
  flush: mocks.flush,
}));

vi.mock('../src/core/budget_accumulator.js', () => ({
  initAccumulator: mocks.initAccumulator,
}));

const VALID_KEY = 'pv_live_aabbccdd_' + 'a'.repeat(32);
const PROMPT_SECRET = 'PROMPT SECRET SHOULD NOT LEAVE PROCESS';
const COMPLETION_SECRET = 'COMPLETION SECRET SHOULD NOT LEAVE PROCESS';
const TOOL_SECRET = 'TOOL SECRET SHOULD NOT LEAVE PROCESS';

type EnqueuedEvent = Parameters<typeof enqueue>[0];

function runId(n: number): string {
  const prefix = n.toString(16).padStart(8, '0');
  const tail = n.toString(16).padStart(12, '0');
  return `${prefix}-1111-4111-8111-${tail}`;
}

function enqueuedAt(index = 0): EnqueuedEvent {
  return mocks.enqueue.mock.calls[index]![0] as EnqueuedEvent;
}

function successOutput(tokensIn = 1, tokensOut = 1): unknown {
  return {
    generations: [
      [
        {
          message: {
            content: COMPLETION_SECRET,
            usage_metadata: {
              input_tokens: tokensIn,
              output_tokens: tokensOut,
            },
            response_metadata: {
              model_name: 'gpt-4o-mini',
              provider: 'openai',
            },
          },
        },
      ],
    ],
  };
}

function recordLlmRun(
  handler: PylvaCallbackHandler,
  input: {
    runId?: string;
    parentRunId?: string;
    metadata?: Record<string, unknown>;
    output?: unknown;
  } = {},
): void {
  const id = input.runId ?? runId(50);
  handler.handleLLMStart(
    { name: 'ChatOpenAI' },
    [PROMPT_SECRET],
    id,
    input.parentRunId,
    {
      invocation_params: {
        model: 'gpt-4o-mini',
        provider: 'openai',
      },
    },
    [],
    input.metadata,
    'chat_model',
  );
  handler.handleLLMEnd(input.output ?? successOutput(), id, input.parentRunId);
}

describe('PylvaCallbackHandler', () => {
  beforeEach(() => {
    _resetConfigForTests();
    mocks.enqueue.mockReset();
    mocks.flush.mockReset();
    mocks.flush.mockResolvedValue(undefined);
    mocks.initAccumulator.mockReset();
    mocks.initAccumulator.mockResolvedValue(undefined);
  });

  afterEach(() => {
    _resetConfigForTests();
  });

  it('records LangGraph run attribution from AIMessage usage metadata without capturing content', () => {
    const rootRunId = runId(1);
    const llmRunId = runId(2);
    const handler = new PylvaCallbackHandler({ apiKey: VALID_KEY });

    handler.handleChainStart(
      { id: ['langgraph', 'pregel', 'CompiledStateGraph'] },
      { question: PROMPT_SECRET },
      rootRunId,
      undefined,
      [],
      {
        pylva_customer_id: 'cust_meta',
        langgraph_node: 'planner',
        unsafe_prompt_copy: PROMPT_SECRET,
      },
      undefined,
      'LangGraph',
    );

    handler.handleChatModelStart(
      { name: 'ChatOpenAI' },
      [[{ content: PROMPT_SECRET }]],
      llmRunId,
      rootRunId,
      {
        invocation_params: {
          model: 'gpt-4o-mini',
          model_provider: 'openai',
        },
      },
      [],
      {
        pylva_customer_id: 'cust_meta',
        langgraph_node: 'planner',
        unsafe_prompt_copy: PROMPT_SECRET,
      },
      'chat_model',
    );

    handler.handleLLMEnd(successOutput(21, 7), llmRunId, rootRunId);

    expect(mocks.initAccumulator).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);

    const event = enqueuedAt();
    expect(event).toMatchObject({
      run_id: llmRunId,
      parent_run_id: rootRunId,
      trace_id: rootRunId,
      span_id: llmRunId,
      parent_span_id: rootRunId,
      customer_id: 'cust_meta',
      step_name: 'planner',
      model: 'gpt-4o-mini',
      provider: Provider.OPENAI,
      tokens_in: 21,
      tokens_out: 7,
      status: EventStatus.SUCCESS,
      framework: Framework.LANGGRAPH,
      instrumentation_tier: InstrumentationTier.SDK_WRAPPER,
      cost_source: CostSource.AUTO,
      metadata: {
        langgraph_node: 'planner',
        token_count_source: TokenCountSource.EXACT,
      },
    });

    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(PROMPT_SECRET);
    expect(serialized).not.toContain(COMPLETION_SECRET);
    expect(serialized).not.toContain('unsafe_prompt_copy');
  });

  it('drops unsafe metadata step labels before capture', () => {
    const handler = new PylvaCallbackHandler();
    recordLlmRun(handler, {
      runId: runId(3),
      metadata: {
        pylva_customer_id: 'cust_secret',
        langgraph_node: PROMPT_SECRET,
        langgraph_step: ['unsafe', PROMPT_SECRET],
        pylva_step: 'draft reply',
        ls_provider: 'OPENAI',
        ls_model_name: { model: PROMPT_SECRET },
        unsafe_prompt_copy: PROMPT_SECRET,
      },
    });

    const event = enqueuedAt();
    expect(event.step_name).toBe('chat_model');
    expect(event.metadata).toEqual({
      ls_provider: 'OPENAI',
      token_count_source: TokenCountSource.EXACT,
    });
    expect(event.metadata).not.toHaveProperty('langgraph_node');
    expect(event.metadata).not.toHaveProperty('langgraph_step');
    expect(event.metadata).not.toHaveProperty('pylva_step');
    expect(JSON.stringify(event)).not.toContain(PROMPT_SECRET);
  });

  it('keeps identifier-like metadata step labels', () => {
    const handler = new PylvaCallbackHandler();
    recordLlmRun(handler, {
      runId: runId(4),
      metadata: {
        pylva_customer_id: 'cust_steps',
        langgraph_node: 'planner_node',
        langgraph_step: 'graph/call_model',
        pylva_step: 'draft-reply',
        ls_provider: 'OPENAI',
        ls_model_name: 'gpt-4o-mini',
      },
      output: successOutput(3, 2),
    });

    const event = enqueuedAt();
    expect(event.step_name).toBe('planner_node');
    expect(event.metadata).toEqual({
      langgraph_node: 'planner_node',
      langgraph_step: 'graph/call_model',
      pylva_step: 'draft-reply',
      ls_provider: 'OPENAI',
      ls_model_name: 'gpt-4o-mini',
      token_count_source: TokenCountSource.EXACT,
    });
  });

  it('extracts JS token usage shapes from message and llmOutput payloads', () => {
    const cases: Array<[string, unknown, number, number, string, Provider]> = [
      [
        'llmOutput preserves flexible provider/model identifiers',
        {
          llmOutput: {
            tokenUsage: {
              promptTokens: 7,
              completionTokens: 6,
            },
            model: 'ft:gpt-4o-mini:org/name+v1@prod',
            provider: 'openai.chat',
          },
        },
        7,
        6,
        'ft:gpt-4o-mini:org/name+v1@prod',
        'openai.chat',
      ],
      [
        'llmOutput.tokenUsage camelCase',
        {
          llmOutput: {
            tokenUsage: {
              promptTokens: 10,
              completionTokens: 5,
            },
            model: 'claude-3-5-sonnet-latest',
            provider: 'anthropic',
          },
        },
        10,
        5,
        'claude-3-5-sonnet-latest',
        Provider.ANTHROPIC,
      ],
      [
        'llmOutput.token_usage snake_case',
        {
          llmOutput: {
            token_usage: {
              prompt_tokens: 9,
              completion_tokens: 4,
            },
            model_name: 'gpt-4.1-mini',
            model_provider: 'openai',
          },
        },
        9,
        4,
        'gpt-4.1-mini',
        Provider.OPENAI,
      ],
      [
        'message.usageMetadata totalTokens fallback',
        {
          generations: [
            [
              {
                message: {
                  usageMetadata: {
                    inputTokens: 3,
                    totalTokens: 11,
                  },
                  responseMetadata: {
                    modelName: 'gemini-1.5-flash',
                    provider: 'google',
                  },
                },
              },
            ],
          ],
        },
        3,
        8,
        'gemini-1.5-flash',
        Provider.GOOGLE,
      ],
    ];

    cases.forEach(([, output, tokensIn, tokensOut, model, provider], index) => {
      mocks.enqueue.mockClear();
      const handler = new PylvaCallbackHandler();
      const step = `usage_case_${index}`;
      recordLlmRun(handler, {
        runId: runId(10 + index),
        metadata: { pylva_customer_id: 'cust_usage', pylva_step: step },
        output,
      });

      expect(enqueuedAt()).toMatchObject({
        customer_id: 'cust_usage',
        step_name: step,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        model,
        provider,
        metadata: expect.objectContaining({
          token_count_source: TokenCountSource.EXACT,
        }),
      });
    });
  });

  it('marks missing usage without reading prompt or completion content', () => {
    const handler = new PylvaCallbackHandler();
    recordLlmRun(handler, {
      runId: runId(20),
      metadata: { pylva_customer_id: 'cust_missing', langgraph_node: 'writer' },
      output: {
        generations: [[{ message: { content: COMPLETION_SECRET } }]],
      },
    });

    const event = enqueuedAt();
    expect(event).toMatchObject({
      customer_id: 'cust_missing',
      step_name: 'writer',
      tokens_in: 0,
      tokens_out: 0,
      metadata: {
        langgraph_node: 'writer',
        usage_missing: true,
      },
    });
    expect(JSON.stringify(event)).not.toContain(COMPLETION_SECRET);
  });

  it('resolves customer id by constructor, metadata, track context, then anonymous', async () => {
    const constructorHandler = new PylvaCallbackHandler({ customerId: 'cust_constructor' });
    await track('cust_context', { framework: Framework.LANGGRAPH }, async () => {
      recordLlmRun(constructorHandler, {
        runId: runId(30),
        metadata: { pylva_customer_id: 'cust_metadata' },
      });
    });

    const metadataHandler = new PylvaCallbackHandler();
    await track('cust_context', { framework: Framework.LANGGRAPH }, async () => {
      recordLlmRun(metadataHandler, {
        runId: runId(31),
        metadata: { pylva_customer_id: 'cust_metadata' },
      });
    });

    const contextHandler = new PylvaCallbackHandler();
    await track('cust_context', { framework: Framework.LANGGRAPH }, async () => {
      recordLlmRun(contextHandler, { runId: runId(32) });
    });

    const anonymousHandler = new PylvaCallbackHandler();
    recordLlmRun(anonymousHandler, { runId: runId(33) });

    expect(mocks.enqueue.mock.calls.map((call) => call[0].customer_id)).toEqual([
      'cust_constructor',
      'cust_metadata',
      'cust_context',
      'anonymous',
    ]);
  });

  it('reports failures without sending error messages', () => {
    const handler = new PylvaCallbackHandler();
    const id = runId(40);
    handler.handleLLMStart(
      { name: 'ChatOpenAI' },
      [PROMPT_SECRET],
      id,
      undefined,
      undefined,
      [],
      { pylva_customer_id: 'cust_failure', langgraph_node: 'classifier' },
      'chat_model',
    );

    handler.handleLLMError(new TypeError('SECRET provider response body'), id);

    const event = enqueuedAt();
    expect(event).toMatchObject({
      customer_id: 'cust_failure',
      step_name: 'classifier',
      status: EventStatus.FAILURE,
      tokens_in: 0,
      tokens_out: 0,
      metadata: {
        langgraph_node: 'classifier',
        error_type: 'TypeError',
      },
    });
    expect(JSON.stringify(event)).not.toContain('SECRET provider response body');
  });

  it('keeps tool-call telemetry opt-in and never captures tool inputs or outputs', () => {
    const defaultHandler = new PylvaCallbackHandler();
    defaultHandler.handleToolStart(
      { name: 'search_tool' },
      TOOL_SECRET,
      runId(41),
      undefined,
      [],
      { pylva_customer_id: 'cust_tool', langgraph_node: 'tools' },
      'search_tool',
    );
    defaultHandler.handleToolEnd(TOOL_SECRET, runId(41));
    expect(mocks.enqueue).not.toHaveBeenCalled();

    const optInHandler = new PylvaCallbackHandler({ trackToolCalls: true });
    optInHandler.handleToolStart(
      { name: 'search_tool' },
      TOOL_SECRET,
      runId(42),
      undefined,
      [],
      { pylva_customer_id: 'cust_tool', langgraph_node: 'tools' },
      'search_tool',
    );
    optInHandler.handleToolEnd(TOOL_SECRET, runId(42));

    const event = enqueuedAt();
    expect(event).toMatchObject({
      customer_id: 'cust_tool',
      step_name: 'tools',
      tool_name: 'search_tool',
      tokens_in: 0,
      tokens_out: 0,
      metric: 'calls',
      metric_value: 1,
      instrumentation_tier: InstrumentationTier.REPORTED,
      cost_source: CostSource.CONFIGURED,
    });
    expect(JSON.stringify(event)).not.toContain(TOOL_SECRET);
  });

  it('cleans failed tracked tool runs without capturing tool input or error messages', () => {
    const handler = new PylvaCallbackHandler({ trackToolCalls: true });
    const id = runId(43);
    const internals = handler as unknown as { runs: Map<string, unknown> };

    handler.handleToolStart(
      { name: 'search_tool' },
      TOOL_SECRET,
      id,
      undefined,
      [],
      { pylva_customer_id: 'cust_tool', langgraph_node: 'tools' },
      'search_tool',
    );
    expect(internals.runs.size).toBe(1);

    handler.handleToolError(new Error('SECRET tool failure details'), id);

    expect(internals.runs.size).toBe(0);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    const event = enqueuedAt();
    expect(event).toMatchObject({
      customer_id: 'cust_tool',
      step_name: 'tools',
      tool_name: 'search_tool',
      status: EventStatus.FAILURE,
      tokens_in: 0,
      tokens_out: 0,
      metric: 'calls',
      metric_value: 1,
      instrumentation_tier: InstrumentationTier.REPORTED,
      cost_source: CostSource.CONFIGURED,
      metadata: {
        langgraph_node: 'tools',
        error_type: 'Error',
      },
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(TOOL_SECRET);
    expect(serialized).not.toContain('SECRET tool failure details');
  });

  it('fails open when telemetry enqueue throws', () => {
    const handler = new PylvaCallbackHandler();
    mocks.enqueue.mockImplementationOnce(() => {
      throw new Error('enqueue unavailable');
    });

    expect(() =>
      recordLlmRun(handler, {
        runId: runId(46),
        metadata: { pylva_customer_id: 'cust_fail_open' },
      }),
    ).not.toThrow();
  });

  it('flushes on chain end when requested', async () => {
    const handler = new PylvaCallbackHandler({ flushOnChainEnd: true });

    await handler.handleChainEnd({}, runId(47));

    expect(mocks.flush).toHaveBeenCalledTimes(1);
  });

  it('exports the same callback from langchain and async aliases', () => {
    expect(LangChainPylvaCallbackHandler).toBe(PylvaCallbackHandler);
    expect(new AsyncPylvaCallbackHandler()).toBeInstanceOf(PylvaCallbackHandler);
  });

  it('keeps customer and node metadata when called through the LangChain callback manager', async () => {
    const handler = new PylvaCallbackHandler();
    const manager = new CallbackManager();
    manager.addHandler(handler as Parameters<CallbackManager['addHandler']>[0]);
    manager.addMetadata({
      pylva_customer_id: 'cust_manager',
      langgraph_node: 'manager_node',
    });

    const [runManager] = await manager.handleChatModelStart(
      { name: 'ChatOpenAI' },
      [[new HumanMessage(PROMPT_SECRET)]],
      runId(48),
      undefined,
      {
        invocation_params: {
          model: 'gpt-4o-mini',
          model_provider: 'openai',
        },
      },
      undefined,
      undefined,
      'chat_model',
    );
    await runManager.handleLLMEnd(successOutput(13, 4));

    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    const event = enqueuedAt();
    expect(event).toMatchObject({
      customer_id: 'cust_manager',
      step_name: 'manager_node',
      tokens_in: 13,
      tokens_out: 4,
      model: 'gpt-4o-mini',
      provider: Provider.OPENAI,
    });
    expect(event.customer_id).not.toBe('anonymous');
    expect(JSON.stringify(event)).not.toContain(PROMPT_SECRET);
  });

  it('cleans failed chain runs from real LangGraph.js StateGraph invocations', async () => {
    const handler = new PylvaCallbackHandler();
    const internals = handler as unknown as { runs: Map<string, unknown> };
    const State = Annotation.Root({
      value: Annotation(),
    });
    const graph = new StateGraph(State)
      .addNode('boom', async () => {
        throw new Error('SECRET graph failure details');
      })
      .addEdge(START, 'boom')
      .addEdge('boom', END)
      .compile();

    await expect(
      graph.invoke(
        { value: 'hi' },
        {
          callbacks: [handler],
          metadata: { pylva_customer_id: 'cust_graph_failure' },
        },
      ),
    ).rejects.toThrow('SECRET graph failure details');

    expect(internals.runs.size).toBe(0);
    expect(JSON.stringify(mocks.enqueue.mock.calls)).not.toContain(
      'SECRET graph failure details',
    );
  });

  it('receives metadata from a real LangGraph.js StateGraph invocation', async () => {
    const handler = new PylvaCallbackHandler();
    const startSpy = vi.spyOn(handler, 'handleChainStart');
    const model = new FakeListChatModel({ responses: ['ok'] });
    const State = Annotation.Root({
      value: Annotation(),
    });
    const graph = new StateGraph(State)
      .addNode('call_model', async (state, config) => {
        await model.invoke([new HumanMessage(String(state.value))], config);
        return { value: `${state.value}!` };
      })
      .addEdge(START, 'call_model')
      .addEdge('call_model', END)
      .compile();

    const result = await graph.invoke(
      { value: 'hi' },
      {
        callbacks: [handler],
        metadata: { pylva_customer_id: 'cust_graph' },
      },
    );

    expect(result.value).toBe('hi!');
    expect(startSpy).toHaveBeenCalled();
    expect(
      startSpy.mock.calls.some((call) => {
        const metadata = call[5] as Record<string, unknown> | undefined;
        return (
          metadata?.pylva_customer_id === 'cust_graph' &&
          metadata?.langgraph_node === 'call_model'
        );
      }),
    ).toBe(true);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(enqueuedAt()).toMatchObject({
      customer_id: 'cust_graph',
      step_name: 'call_model',
      metadata: {
        langgraph_node: 'call_model',
        usage_missing: true,
      },
    });
  });
});
