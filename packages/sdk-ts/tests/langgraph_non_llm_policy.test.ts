import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CostSource, EventStatus, Framework, InstrumentationTier } from '@pylva/shared';
import { _resetConfigForTests } from '../src/core/config.js';
import { enqueue } from '../src/core/telemetry.js';
import {
  _resetNonLlmPolicyForTests,
  ensureNonLlmPolicy,
  flushNonLlmDiscoveries,
} from '../src/core/non_llm_policy.js';
import { PylvaCallbackHandler } from '../src/langgraph.js';

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

const VALID_KEY = `pv_live_aabbccdd_${'a'.repeat(32)}`;
const TOOL_SECRET = 'TOOL SECRET SHOULD NOT LEAVE PROCESS';

type EnqueuedEvent = Parameters<typeof enqueue>[0];

function runId(n: number): string {
  const prefix = n.toString(16).padStart(8, '0');
  const tail = n.toString(16).padStart(12, '0');
  return `${prefix}-1111-4111-8111-${tail}`;
}

function policyResponse(sources: unknown[]): Response {
  return new Response(
    JSON.stringify({
      version: 'test',
      refresh_after_ms: 10_000,
      unknown_behavior: 'discover_only',
      sources,
    }),
    { status: 200 },
  ) as Response;
}

function toolRun(handler: PylvaCallbackHandler, name: string, id: string): void {
  handler.handleToolStart(
    { name },
    TOOL_SECRET,
    id,
    undefined,
    [],
    { pylva_customer_id: 'cust_tool', langgraph_node: 'tools' },
    name,
  );
  handler.handleToolEnd({ secret: TOOL_SECRET }, id);
}

function enqueuedAt(index = 0): EnqueuedEvent {
  return mocks.enqueue.mock.calls[index]![0] as EnqueuedEvent;
}

describe('PylvaCallbackHandler non-LLM policy mode', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-07-08T00:00:00.000Z') });
    _resetConfigForTests();
    _resetNonLlmPolicyForTests();
    mocks.enqueue.mockReset();
    mocks.flush.mockReset();
    mocks.initAccumulator.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    _resetNonLlmPolicyForTests();
    _resetConfigForTests();
  });

  it('tracks approved tools, ignores ignored tools, and discovers unknown tools only', async () => {
    const discoveryBodies: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/v1/sdk/non-llm-policy')) {
        return policyResponse([
          {
            slug: 'tavily',
            status: 'tracked',
            matchers: ['tavily_search'],
            metric: 'tavily_requests',
            unit: 'request',
            default_metric_value: 1,
          },
          {
            slug: 'grep',
            status: 'ignored',
            matchers: ['grep'],
            metric: null,
            unit: null,
            default_metric_value: null,
          },
        ]);
      }
      discoveryBodies.push(JSON.parse(String((init as RequestInit).body)));
      return new Response(JSON.stringify({ accepted: 1, rejected: 0 })) as Response;
    });

    const handler = new PylvaCallbackHandler({
      apiKey: VALID_KEY,
      endpoint: 'http://mock',
      nonLlm: { mode: 'policy' },
    });
    await ensureNonLlmPolicy();

    toolRun(handler, 'tavily_search', runId(1));
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(enqueuedAt()).toMatchObject({
      customer_id: 'cust_tool',
      step_name: 'tools',
      tool_name: 'tavily_search',
      metric: 'tavily_requests',
      metric_value: 1,
      instrumentation_tier: InstrumentationTier.REPORTED,
      cost_source: CostSource.CONFIGURED,
    });
    expect(JSON.stringify(enqueuedAt())).not.toContain(TOOL_SECRET);

    mocks.enqueue.mockClear();
    toolRun(handler, 'grep', runId(2));
    expect(mocks.enqueue).not.toHaveBeenCalled();

    toolRun(handler, 'local_lookup', runId(3));
    await flushNonLlmDiscoveries();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(discoveryBodies).toHaveLength(1);
    expect(discoveryBodies[0]).toMatchObject({
      discoveries: [{ tool_name: 'local_lookup', matcher: 'local_lookup', step_name: 'tools' }],
    });
    expect(JSON.stringify(discoveryBodies[0])).not.toContain(TOOL_SECRET);
  });

  it('refreshes policy without restart', async () => {
    let ignored = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      policyResponse([
        {
          slug: 'tavily',
          status: ignored ? 'ignored' : 'tracked',
          matchers: ['tavily_search'],
          metric: ignored ? null : 'tavily_requests',
          unit: ignored ? null : 'request',
          default_metric_value: ignored ? null : 1,
        },
      ]),
    );

    const handler = new PylvaCallbackHandler({
      apiKey: VALID_KEY,
      endpoint: 'http://mock',
      nonLlm: { mode: 'policy', refreshIntervalMs: 10_000 },
    });
    await ensureNonLlmPolicy();
    toolRun(handler, 'tavily_search', runId(4));
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);

    ignored = true;
    mocks.enqueue.mockClear();
    vi.setSystemTime(new Date('2026-07-08T00:00:11.000Z'));
    await ensureNonLlmPolicy();
    toolRun(handler, 'tavily_search', runId(5));

    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('dedupes duplicate tool end callbacks and handles tool end without start safely', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      policyResponse([
        {
          slug: 'tool',
          status: 'tracked',
          matchers: ['tool', 'tavily_search'],
          metric: 'tool_calls',
          unit: 'request',
          default_metric_value: 1,
        },
      ]),
    );
    const handler = new PylvaCallbackHandler({
      apiKey: VALID_KEY,
      endpoint: 'http://mock',
      nonLlm: { mode: 'policy' },
    });
    await ensureNonLlmPolicy();

    const id = runId(6);
    handler.handleToolStart(
      { name: 'tavily_search' },
      TOOL_SECRET,
      id,
      undefined,
      [],
      {},
      'tavily_search',
    );
    handler.handleToolEnd(TOOL_SECRET, id);
    handler.handleToolEnd(TOOL_SECRET, id);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);

    mocks.enqueue.mockClear();
    handler.handleToolEnd(TOOL_SECRET, runId(7));
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(enqueuedAt()).toMatchObject({
      tool_name: 'tool',
      metric: 'tool_calls',
      status: EventStatus.SUCCESS,
      framework: Framework.LANGGRAPH,
    });
  });

  it('keeps LLM telemetry working when policy fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('policy unavailable'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handler = new PylvaCallbackHandler({
      apiKey: VALID_KEY,
      endpoint: 'http://mock',
      nonLlm: { mode: 'policy' },
    });
    await ensureNonLlmPolicy();

    handler.handleLLMStart(
      { name: 'ChatOpenAI' },
      ['prompt secret'],
      runId(8),
      undefined,
      { invocation_params: { model: 'gpt-4o-mini', provider: 'openai' } },
      [],
      { pylva_customer_id: 'cust_llm' },
      'chat_model',
    );
    handler.handleLLMEnd(
      {
        generations: [
          [
            {
              message: {
                usage_metadata: { input_tokens: 3, output_tokens: 2 },
                response_metadata: { model_name: 'gpt-4o-mini', provider: 'openai' },
              },
            },
          ],
        ],
      },
      runId(8),
    );

    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(enqueuedAt()).toMatchObject({
      customer_id: 'cust_llm',
      tokens_in: 3,
      tokens_out: 2,
      instrumentation_tier: InstrumentationTier.SDK_WRAPPER,
    });
  });
});
