import { beforeEach, describe, expect, it } from 'vitest';
import { getConfig, getConfigGeneration, _resetConfigForTests } from '../src/core/config.js';
import { installSdkConfig, snapshotStandaloneNonLlmConfig } from '../src/core/identity.js';
import {
  configureNonLlmPolicy,
  decideNonLlmTool,
  metricValueForSource,
  _resetNonLlmPolicyForTests,
} from '../src/core/non_llm_policy.js';
import { getRegisteredClient, registerProviderClient } from '../src/core/client_registry.js';
import { PylvaCallbackHandler } from '../src/langgraph.js';
import { Pylva } from '../src/Pylva.js';

const KEY_A = `pv_live_aabbccdd_${'a'.repeat(32)}`;
const KEY_B = `pv_live_bbccddee_${'b'.repeat(32)}`;

function trackedSource(matcher: string) {
  return {
    slug: 'search',
    status: 'tracked' as const,
    matchers: [matcher],
    metric: 'requests',
    unit: 'request',
    default_metric_value: 1,
  };
}

describe('atomic detached SDK configuration', () => {
  beforeEach(() => {
    _resetConfigForTests();
    _resetNonLlmPolicyForTests();
  });

  it('rejects malformed non-LLM config before identity reset or policy mutation', () => {
    installSdkConfig({
      apiKey: KEY_A,
      endpoint: 'https://one.test',
      localMode: true,
      nonLlm: { mode: 'policy', policy: { sources: [trackedSource('old-search')] } },
    });
    const generation = getConfigGeneration();
    expect(decideNonLlmTool(['old-search']).kind).toBe('tracked');

    expect(() =>
      installSdkConfig({
        apiKey: KEY_B,
        endpoint: 'https://two.test',
        localMode: true,
        nonLlm: { policy: { sources: {} as never } },
      }),
    ).toThrow('nonLlm.policy.sources must be an array');

    expect(getConfigGeneration()).toBe(generation);
    expect(getConfig()?.endpoint).toBe('https://one.test');
    expect(decideNonLlmTool(['old-search']).kind).toBe('tracked');
  });

  it.each(['trackToolCalls', 'flushOnChainEnd'] as const)(
    'reads a throwing LangGraph %s option before publishing a replacement identity',
    (option) => {
      installSdkConfig({ apiKey: KEY_A, endpoint: 'https://one.test', localMode: true });
      const generation = getConfigGeneration();
      const options: Record<string, unknown> = {
        apiKey: KEY_B,
        endpoint: 'https://two.test',
        localMode: true,
      };
      Object.defineProperty(options, option, {
        enumerable: true,
        get() {
          throw new Error(`throwing ${option} getter`);
        },
      });

      expect(() => new PylvaCallbackHandler(options as never)).toThrow(`throwing ${option} getter`);
      expect(getConfigGeneration()).toBe(generation);
      expect(getConfig()?.endpoint).toBe('https://one.test');
    },
  );

  it('materializes provider entries before publishing a replacement identity', () => {
    const existingClient = { tenant: 'one' };
    installSdkConfig({ apiKey: KEY_A, endpoint: 'https://one.test', localMode: true });
    registerProviderClient('openai', existingClient);
    const generation = getConfigGeneration();
    const providers = new Proxy<Record<string, unknown>>(
      {},
      {
        ownKeys() {
          throw new Error('throwing providers ownKeys trap');
        },
      },
    );

    expect(
      () =>
        new Pylva({
          apiKey: KEY_B,
          endpoint: 'https://two.test',
          localMode: true,
          providers,
        }),
    ).toThrow('throwing providers ownKeys trap');
    expect(getConfigGeneration()).toBe(generation);
    expect(getConfig()?.endpoint).toBe('https://one.test');
    expect(getRegisteredClient('openai')).toBe(existingClient);
  });

  it('rejects an oversized matcher before publishing a replacement identity', () => {
    installSdkConfig({ apiKey: KEY_A, endpoint: 'https://one.test', localMode: true });
    const generation = getConfigGeneration();

    expect(() =>
      installSdkConfig({
        apiKey: KEY_B,
        endpoint: 'https://two.test',
        localMode: true,
        nonLlm: {
          mode: 'policy',
          policy: { sources: [trackedSource('x'.repeat(1_000_000))] },
        },
      }),
    ).toThrow('at most 100 code points');
    expect(getConfigGeneration()).toBe(generation);
    expect(getConfig()?.endpoint).toBe('https://one.test');
  });

  it('uses only a deeply frozen snapshot after installation', () => {
    const matchers = ['original-search'];
    const source = { ...trackedSource('unused'), matchers };
    const extractors = { search: () => 7 };
    const nonLlm = {
      mode: 'policy' as const,
      policy: { unknown_behavior: 'ignore' as const, sources: [source] },
      refreshIntervalMs: 12_000,
      usageExtractors: extractors,
    };

    installSdkConfig({ apiKey: KEY_A, localMode: true, nonLlm });
    const installed = getConfig()?.nonLlm;
    expect(Object.isFrozen(installed)).toBe(true);
    expect(Object.isFrozen(installed?.policy)).toBe(true);
    expect(Object.isFrozen(installed?.policy?.sources)).toBe(true);
    expect(Object.isFrozen(installed?.policy?.sources?.[0])).toBe(true);
    expect(Object.isFrozen(installed?.policy?.sources?.[0]?.matchers)).toBe(true);
    expect(Object.isFrozen(installed?.usageExtractors)).toBe(true);

    matchers[0] = 'mutated-search';
    source.status = 'ignored';
    extractors.search = () => 99;

    const decision = decideNonLlmTool(['original-search']);
    expect(decision.kind).toBe('tracked');
    expect(decideNonLlmTool(['mutated-search']).kind).toBe('unknown');
    if (decision.kind !== 'tracked') throw new Error('expected tracked decision');
    expect(
      metricValueForSource(
        decision.source,
        {
          toolName: 'Search',
          matcher: decision.matcher,
          customerId: 'customer',
          stepName: null,
          status: 'success',
          framework: 'none',
          metadata: {},
        },
        installed?.usageExtractors,
      ),
    ).toBe(7);
  });

  it('snapshots callback-only LangGraph policy and preserves prior state on invalid options', () => {
    const source = trackedSource('callback-search');
    new PylvaCallbackHandler({ nonLlm: { mode: 'policy', policy: { sources: [source] } } });
    source.matchers[0] = 'mutated-search';
    expect(decideNonLlmTool(['callback-search']).kind).toBe('tracked');
    expect(decideNonLlmTool(['mutated-search']).kind).toBe('unknown');

    expect(
      () =>
        new PylvaCallbackHandler({
          nonLlm: { mode: 'invalid' as never },
        }),
    ).toThrow('nonLlm.mode');
    expect(decideNonLlmTool(['callback-search']).kind).toBe('tracked');
  });

  it('standalone snapshot validation is side-effect free', () => {
    configureNonLlmPolicy(
      snapshotStandaloneNonLlmConfig({
        policy: { sources: [trackedSource('existing-search')] },
      }),
    );
    expect(() =>
      snapshotStandaloneNonLlmConfig({ usageExtractors: { search: 1 as never } }),
    ).toThrow('must be a function');
    expect(decideNonLlmTool(['existing-search']).kind).toBe('tracked');
  });

  it('measures non-LLM text limits in Unicode code points', () => {
    expect(() =>
      snapshotStandaloneNonLlmConfig({
        policy: {
          sources: [
            {
              ...trackedSource('search'),
              metric: '\u{1f600}'.repeat(100),
            },
          ],
        },
      }),
    ).not.toThrow();
  });

  it.each([
    [{ unexpected: true }, 'unknown field'],
    [{ mode: 'sometimes' }, 'nonLlm.mode'],
    [{ refreshIntervalMs: Number.NaN }, 'positive finite number'],
    [{ refreshIntervalMs: 0 }, 'positive finite number'],
    [{ policy: { unexpected: true } }, 'nonLlm.policy contains unknown field'],
    [{ policy: { unknown_behavior: 'sometimes' } }, 'unknown_behavior'],
    [{ policy: { sources: [{ slug: '', status: 'tracked', matchers: ['search'] }] } }, '.slug'],
    [
      {
        policy: {
          sources: [{ slug: 's'.repeat(101), status: 'tracked', matchers: ['search'] }],
        },
      },
      '.slug',
    ],
    [
      { policy: { sources: [{ slug: 'search', status: 'sometimes', matchers: ['search'] }] } },
      '.status',
    ],
    [{ policy: { sources: [{ slug: 'search', status: 'tracked', matchers: [1] }] } }, '.matchers'],
    [
      {
        policy: {
          sources: [{ slug: 'search', status: 'tracked', matchers: ['m'.repeat(101)] }],
        },
      },
      '.matchers',
    ],
    [
      {
        policy: {
          sources: [
            { slug: 'search', status: 'tracked', matchers: ['search'], metric: 'm'.repeat(101) },
          ],
        },
      },
      '.metric',
    ],
    [
      {
        policy: {
          sources: [
            { slug: 'search', status: 'tracked', matchers: ['search'], unit: 'u'.repeat(101) },
          ],
        },
      },
      '.unit',
    ],
    [{ usageExtractors: { ['x'.repeat(101)]: () => 1 } }, 'usageExtractors key'],
    [
      {
        policy: {
          sources: [
            {
              slug: 'search',
              status: 'tracked',
              matchers: ['search'],
              default_metric_value: Number.POSITIVE_INFINITY,
            },
          ],
        },
      },
      '.default_metric_value',
    ],
  ])('rejects semantically invalid non-LLM snapshot %#', (nonLlm, message) => {
    expect(() => snapshotStandaloneNonLlmConfig(nonLlm as never)).toThrow(message as string);
  });
});
