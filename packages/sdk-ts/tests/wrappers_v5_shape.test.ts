// Regression: openai v5 / recent @anthropic-ai/sdk assign their resource
// accessors (`chat`, `messages`) as constructor instance fields — nothing on
// the prototype. The original wrapMethod-only patch silently instrumented
// NOTHING on those versions (applied=true was still set), so every v5
// customer shipped zero telemetry. The fix patches the resource class
// prototype via the provider's resources module (sdk-py parity).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const esmResources = vi.hoisted(() => {
  const state = {
    openaiCompletions: undefined as unknown,
    anthropicMessages: undefined as unknown,
  };
  return {
    state,
    openai: {
      get Completions() {
        return state.openaiCompletions;
      },
    } as { Completions?: unknown },
    anthropic: {
      get Messages() {
        return state.anthropicMessages;
      },
    } as { Messages?: unknown },
  };
});

vi.mock('../src/wrappers/_load.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/wrappers/_load.js')>();
  return {
    ...actual,
    loadPeer: vi.fn(),
    patchResourceProto: vi.fn(actual.patchResourceProto),
  };
});

vi.mock('openai/resources/chat/completions', () => esmResources.openai);
vi.mock('@anthropic-ai/sdk/resources/messages', () => esmResources.anthropic);

vi.mock('../src/core/rules_cache.js', () => ({
  ensureRulesCache: vi.fn(async () => {}),
  getCachedRules: () => [],
  isPassthrough: () => false,
}));

vi.mock('../src/core/budget_accumulator.js', () => ({
  check: vi.fn(() => ({ over_limit: false, accumulated_usd: 0, projected_usd: 0 })),
}));

vi.mock('../src/core/config.js', () => ({
  isInitialized: () => true,
}));

vi.mock('../src/core/telemetry.js', () => ({
  enqueue: vi.fn(),
}));

const { loadPeer, patchResourceProto } = await import('../src/wrappers/_load.js');
const { applyOpenAiPatch, _resetOpenAiPatchForTests } = await import('../src/wrappers/openai.js');
const { applyAnthropicPatch, _resetAnthropicPatchForTests } =
  await import('../src/wrappers/anthropic.js');
const { enqueue } = await import('../src/core/telemetry.js');

beforeEach(() => {
  _resetOpenAiPatchForTests();
  _resetAnthropicPatchForTests();
  esmResources.state.openaiCompletions = undefined;
  esmResources.state.anthropicMessages = undefined;
  vi.mocked(enqueue).mockClear();
  vi.mocked(loadPeer).mockReset();
  vi.mocked(patchResourceProto).mockClear();
});

afterEach(async () => {
  await vi.dynamicImportSettled();
});

describe('openai v5 instance-field shape', () => {
  function buildV5Peer(create: (...args: unknown[]) => Promise<unknown>) {
    class Completions {
      async create(...args: unknown[]): Promise<unknown> {
        return create.apply(this, args);
      }
    }
    class OpenAI {
      chat: { completions: InstanceType<typeof Completions> };
      constructor() {
        // v5 shape: resource assigned in the constructor, prototype bare.
        this.chat = { completions: new Completions() };
      }
    }
    return { OpenAI, Completions };
  }

  it('instruments clients whose chat resource is a constructor field', async () => {
    const create = vi.fn(async () => ({
      model: 'gpt-4o-mini',
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    }));
    const { OpenAI, Completions } = buildV5Peer(create);
    vi.mocked(loadPeer).mockImplementation((spec: string) => {
      if (spec === 'openai') return { default: OpenAI };
      if (spec === 'openai/resources/chat/completions') return { Completions };
      return undefined;
    });

    applyOpenAiPatch();
    const client = new OpenAI();
    const result = (await client.chat.completions.create({ model: 'gpt-4o-mini' })) as {
      _pylva?: unknown;
    };

    expect(create).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueue)).toHaveBeenCalledTimes(1);
    expect(result._pylva).toBeDefined();
    const event = vi.mocked(enqueue).mock.calls[0]![0] as {
      provider: string;
      tokens_in: number;
      tokens_out: number;
    };
    expect(event.provider).toBe('openai');
    expect(event.tokens_in).toBe(7);
    expect(event.tokens_out).toBe(3);
  });

  it('does not double-instrument when the class patch already covers an instance', async () => {
    const create = vi.fn(async () => ({ model: 'gpt-4o-mini', usage: {} }));
    const { OpenAI, Completions } = buildV5Peer(create);
    vi.mocked(loadPeer).mockImplementation((spec: string) => {
      if (spec === 'openai') return { default: OpenAI };
      if (spec === 'openai/resources/chat/completions') return { Completions };
      return undefined;
    });

    applyOpenAiPatch();
    _resetOpenAiPatchForTests();
    applyOpenAiPatch(); // second pass (init() re-applies defensively)

    const client = new OpenAI();
    await client.chat.completions.create({ model: 'gpt-4o-mini' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueue)).toHaveBeenCalledTimes(1);
  });

  it('does not mark the provider patched when no patch point exists', async () => {
    class Bare {}
    vi.mocked(loadPeer).mockImplementation((spec: string) =>
      spec === 'openai' ? { default: Bare } : undefined,
    );
    applyOpenAiPatch();
    // No throw, no enqueue — and a second apply attempt is still allowed
    // because `applied` was never set.
    expect(vi.mocked(enqueue)).not.toHaveBeenCalled();
  });

  it('launches the async ESM patch only once when sync patching finds no resource class', async () => {
    class Bare {}
    class Completions {
      async create(): Promise<unknown> {
        return {};
      }
    }
    esmResources.state.openaiCompletions = Completions;
    vi.mocked(loadPeer).mockImplementation((spec: string) =>
      spec === 'openai' ? { default: Bare } : undefined,
    );

    applyOpenAiPatch();
    applyOpenAiPatch();
    await vi.dynamicImportSettled();

    const esmPatchCalls = vi
      .mocked(patchResourceProto)
      .mock.calls.filter(
        ([mod, exportName]) =>
          exportName === 'Completions' &&
          (mod as { Completions?: unknown } | undefined)?.Completions === Completions,
      );
    expect(esmPatchCalls).toHaveLength(1);
  });
});

describe('anthropic instance-field shape', () => {
  function buildV5Peer(create: (...args: unknown[]) => Promise<unknown>) {
    class Messages {
      async create(...args: unknown[]): Promise<unknown> {
        return create.apply(this, args);
      }
    }
    class Anthropic {
      messages: InstanceType<typeof Messages>;
      constructor() {
        this.messages = new Messages();
      }
    }
    return { Anthropic, Messages };
  }

  it('instruments clients whose messages resource is a constructor field', async () => {
    const create = vi.fn(async () => ({
      model: 'claude-3-5-sonnet-20241022',
      usage: { input_tokens: 11, output_tokens: 5 },
    }));
    const { Anthropic, Messages } = buildV5Peer(create);
    vi.mocked(loadPeer).mockImplementation((spec: string) => {
      if (spec === '@anthropic-ai/sdk') return { default: Anthropic };
      if (spec === '@anthropic-ai/sdk/resources/messages') return { Messages };
      return undefined;
    });

    applyAnthropicPatch();
    const client = new Anthropic();
    const result = (await client.messages.create({ model: 'claude-3-5-sonnet-20241022' })) as {
      _pylva?: unknown;
    };

    expect(create).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueue)).toHaveBeenCalledTimes(1);
    expect(result._pylva).toBeDefined();
    const event = vi.mocked(enqueue).mock.calls[0]![0] as {
      provider: string;
      tokens_in: number;
      tokens_out: number;
    };
    expect(event.provider).toBe('anthropic');
    expect(event.tokens_in).toBe(11);
    expect(event.tokens_out).toBe(5);
  });

  it('launches the async ESM patch only once when sync patching finds no resource class', async () => {
    class Bare {}
    class Messages {
      async create(): Promise<unknown> {
        return {};
      }
    }
    esmResources.state.anthropicMessages = Messages;
    vi.mocked(loadPeer).mockImplementation((spec: string) =>
      spec === '@anthropic-ai/sdk' ? { default: Bare } : undefined,
    );

    applyAnthropicPatch();
    applyAnthropicPatch();
    await vi.dynamicImportSettled();

    const esmPatchCalls = vi
      .mocked(patchResourceProto)
      .mock.calls.filter(
        ([mod, exportName]) =>
          exportName === 'Messages' &&
          (mod as { Messages?: unknown } | undefined)?.Messages === Messages,
      );
    expect(esmPatchCalls).toHaveLength(1);
  });
});
