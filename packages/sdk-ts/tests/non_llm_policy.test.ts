import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventStatus, Framework } from '@pylva/shared';
import { init, _resetConfigForTests } from '../src/core/config.js';
import {
  _resetNonLlmPolicyForTests,
  configureNonLlmPolicy,
  decideNonLlmTool,
  ensureNonLlmPolicy,
  flushNonLlmDiscoveries,
  metricValueForSource,
  normalizeNonLlmMatcher,
  recordNonLlmDiscovery,
  type NonLlmToolContext,
  type NormalizedPolicySource,
} from '../src/core/non_llm_policy.js';

const VALID_KEY = `pv_live_aabbccdd_${'a'.repeat(32)}`;

function policyResponse(sources: unknown[], refreshAfterMs = 60_000): Response {
  return new Response(
    JSON.stringify({
      version: 'test',
      refresh_after_ms: refreshAfterMs,
      unknown_behavior: 'discover_only',
      sources,
    }),
    { status: 200 },
  ) as Response;
}

function ctx(overrides: Partial<NonLlmToolContext> = {}): NonLlmToolContext {
  return {
    toolName: 'tavily_search',
    matcher: 'tavily_search',
    customerId: 'cust_1',
    stepName: 'tools',
    status: EventStatus.SUCCESS,
    framework: Framework.LANGGRAPH,
    metadata: {},
    ...overrides,
  };
}

const trackedSource: NormalizedPolicySource = {
  slug: 'tavily',
  status: 'tracked',
  matchers: ['tavily_search'],
  metric: 'tavily_requests',
  unit: 'request',
  defaultMetricValue: 1,
};

describe('non-LLM policy cache', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-07-08T00:00:00.000Z') });
    _resetConfigForTests();
    _resetNonLlmPolicyForTests();
    init({ apiKey: VALID_KEY, endpoint: 'http://mock' });
    configureNonLlmPolicy({ mode: 'policy', refreshIntervalMs: 60_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    _resetNonLlmPolicyForTests();
    _resetConfigForTests();
  });

  it('fetches once, dedupes concurrent fetches, caches by TTL, and skips malformed sources', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      policyResponse([
        { slug: 'bad-no-matchers', status: 'tracked', metric: 'calls' },
        { slug: 'bad-status', status: 'pending', matchers: ['pending_tool'] },
        {
          slug: 'tavily',
          display_name: 'Tavily',
          status: 'tracked',
          matchers: ['Tavily Search'],
          metric: 'tavily_requests',
          unit: 'request',
          default_metric_value: 1,
        },
      ]),
    );

    await Promise.all([ensureNonLlmPolicy(), ensureNonLlmPolicy()]);
    await ensureNonLlmPolicy();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(decideNonLlmTool(['tavily search'])).toMatchObject({
      kind: 'tracked',
      matcher: 'tavily-search',
      source: { slug: 'tavily', metric: 'tavily_requests', defaultMetricValue: 1 },
    });
    expect(decideNonLlmTool(['pending_tool'])).toEqual({
      kind: 'unknown',
      matcher: 'pending_tool',
    });
  });

  it('keeps stale policy on backend failures', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        policyResponse([
          {
            slug: 'tavily',
            status: 'tracked',
            matchers: ['tavily_search'],
            metric: 'tavily_requests',
            unit: 'request',
            default_metric_value: 1,
          },
        ]),
      )
      .mockResolvedValueOnce(new Response('', { status: 500 }) as Response);

    await ensureNonLlmPolicy();
    expect(decideNonLlmTool(['tavily_search']).kind).toBe('tracked');

    vi.setSystemTime(new Date('2026-07-08T00:01:01.000Z'));
    await ensureNonLlmPolicy();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      '[pylva] non-LLM policy fetch failed; keeping stale policy',
    );
    expect(decideNonLlmTool(['tavily_search']).kind).toBe('tracked');
  });

  it('applies local overrides before remote policy and prefers ignored within a policy layer', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      policyResponse([
        {
          slug: 'remote-ignore',
          status: 'ignored',
          matchers: ['tavily_search'],
          metric: null,
          unit: null,
          default_metric_value: null,
        },
      ]),
    );
    configureNonLlmPolicy({
      mode: 'policy',
      policy: {
        sources: [
          {
            slug: 'local-track',
            status: 'tracked',
            matchers: ['tavily_search'],
            metric: 'local_calls',
            unit: 'request',
            default_metric_value: 2,
          },
        ],
      },
    });

    await ensureNonLlmPolicy();
    expect(decideNonLlmTool(['tavily_search'])).toMatchObject({
      kind: 'tracked',
      source: { slug: 'local-track', metric: 'local_calls' },
    });

    configureNonLlmPolicy({
      mode: 'policy',
      policy: {
        sources: [
          {
            slug: 'local-track',
            status: 'tracked',
            matchers: ['grep'],
            metric: 'grep_calls',
            unit: 'request',
            default_metric_value: 1,
          },
          {
            slug: 'local-ignore',
            status: 'ignored',
            matchers: ['grep'],
          },
        ],
      },
    });

    expect(decideNonLlmTool(['grep'])).toMatchObject({
      kind: 'ignored',
      source: { slug: 'local-ignore' },
    });
  });
});

describe('non-LLM usage and discovery', () => {
  beforeEach(() => {
    _resetConfigForTests();
    _resetNonLlmPolicyForTests();
    init({ apiKey: VALID_KEY, endpoint: 'http://mock' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    _resetNonLlmPolicyForTests();
    _resetConfigForTests();
  });

  it('uses extractor values before defaults and skips invalid extractor output with one warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(metricValueForSource(trackedSource, ctx(), undefined)).toBe(1);
    expect(
      metricValueForSource(trackedSource, ctx(), {
        tavily: () => 7,
      }),
    ).toBe(7);
    expect(
      metricValueForSource(trackedSource, ctx(), {
        tavily: () => Number.NaN,
      }),
    ).toBeNull();
    expect(
      metricValueForSource(trackedSource, ctx(), {
        tavily: () => Number.POSITIVE_INFINITY,
      }),
    ).toBeNull();
    expect(
      metricValueForSource(trackedSource, ctx(), {
        tavily: () => -1,
      }),
    ).toBeNull();
    expect(
      metricValueForSource(trackedSource, ctx(), {
        tavily: () => {
          throw new Error('extractor failed');
        },
      }),
    ).toBeNull();

    expect(warnSpy.mock.calls.filter((call) => String(call[0]).includes('tavily'))).toHaveLength(1);
  });

  it('normalizes unsafe high-cardinality matcher names', () => {
    const long = `${'A'.repeat(120)} secret@example.com`;
    const repeatedHyphens = `a${'-'.repeat(20_000)}b`;

    expect(normalizeNonLlmMatcher('  Local Lookup !!  ')).toBe('local-lookup');
    expect(normalizeNonLlmMatcher(long)).toHaveLength(100);
    expect(normalizeNonLlmMatcher('--safe-matcher--')).toBe('safe-matcher');
    expect(normalizeNonLlmMatcher(repeatedHyphens)).toBe(`a${'-'.repeat(99)}`);
    expect(normalizeNonLlmMatcher('@@@')).toBeNull();
  });

  it('posts discovery candidates without raw tool input or output', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ accepted: 1, rejected: 0 })) as Response);

    recordNonLlmDiscovery({
      toolName: 'Local Lookup',
      matcher: 'local_lookup',
      stepName: 'tool_node',
      framework: Framework.LANGGRAPH,
      status: EventStatus.SUCCESS,
    });
    await flushNonLlmDiscoveries();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe('http://mock/api/v1/sdk/non-llm-discoveries');
    const initArg = fetchSpy.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(initArg.body)) as { discoveries: unknown[] };
    expect(body.discoveries).toMatchObject([
      {
        tool_name: 'Local Lookup',
        matcher: 'local_lookup',
        step_name: 'tool_node',
      },
    ]);
    expect(JSON.stringify(body)).not.toContain('SECRET');
  });

  it('dedupes repeated discovery candidates within the TTL', async () => {
    vi.useFakeTimers({ now: new Date('2026-07-08T00:00:00.000Z') });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ accepted: 1, rejected: 0 })) as Response);

    recordNonLlmDiscovery({
      toolName: 'Local Lookup',
      matcher: 'local_lookup',
      stepName: 'tool_node',
      framework: Framework.LANGGRAPH,
      status: EventStatus.SUCCESS,
    });
    recordNonLlmDiscovery({
      toolName: 'Local Lookup',
      matcher: 'local_lookup',
      stepName: 'tool_node',
      framework: Framework.LANGGRAPH,
      status: EventStatus.SUCCESS,
    });
    await flushNonLlmDiscoveries();

    const initArg = fetchSpy.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(initArg.body)) as { discoveries: unknown[] };
    expect(body.discoveries).toHaveLength(1);
    vi.useRealTimers();
  });
});
