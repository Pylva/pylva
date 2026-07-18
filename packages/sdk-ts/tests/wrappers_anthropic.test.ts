// Smoke test for the Anthropic wrapper. The engine logic itself lives in
// `wrappers_engine.test.ts` — these tests pin down the bits unique to
// anthropic.ts: provider id, token-field mapping (input_tokens /
// output_tokens), and idempotent patch application.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const configState = vi.hoisted(() => ({ generation: 1 }));

vi.mock('../src/wrappers/_load.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/wrappers/_load.js')>();
  return { ...actual, loadPeer: vi.fn() };
});

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
  getConfigGeneration: () => configState.generation,
}));

vi.mock('../src/core/telemetry.js', () => ({
  enqueue: vi.fn(),
}));

const { loadPeer } = await import('../src/wrappers/_load.js');
const { applyAnthropicPatch, _resetAnthropicPatchForTests } =
  await import('../src/wrappers/anthropic.js');
const { enqueue } = await import('../src/core/telemetry.js');
const { BudgetExceededSource, PylvaBudgetExceeded } =
  await import('../src/errors/budget_exceeded.js');

type FakeCreate = (...args: unknown[]) => Promise<unknown>;
type FakeAnthropicCtor = new () => { messages: { create: FakeCreate } };

// The wrapper patches `Ctor.prototype.messages`, so the fake must put
// `messages` on the prototype (not as an instance field). Each test
// builds its own constructor — `_resetAnthropicPatchForTests` only
// clears the `applied` flag and does NOT unwind the prototype mutation.
function buildFakePeer(create: FakeCreate): { default: FakeAnthropicCtor } {
  class Ctor {}
  (Ctor.prototype as Record<string, unknown>)['messages'] = { create };
  return { default: Ctor as FakeAnthropicCtor };
}

beforeEach(() => {
  configState.generation = 1;
  _resetAnthropicPatchForTests();
  vi.mocked(enqueue).mockClear();
  vi.mocked(loadPeer).mockReset();
});

describe('applyAnthropicPatch', () => {
  it('forwards Provider.ANTHROPIC + maps input_tokens / output_tokens to telemetry', async () => {
    const create = vi.fn(async () => ({
      model: 'claude-3-5-sonnet-20241022',
      usage: { input_tokens: 12, output_tokens: 34 },
    }));
    const peer = buildFakePeer(create);
    vi.mocked(loadPeer).mockReturnValue(peer);

    applyAnthropicPatch();
    const client = new peer.default();
    const out = (await client.messages.create({ model: 'claude-3-5-sonnet-20241022' })) as {
      model: string;
      _pylva?: { original_model: string | null };
    };

    expect(create).toHaveBeenCalledTimes(1);
    expect(out.model).toBe('claude-3-5-sonnet-20241022');
    expect(out._pylva?.original_model).toBe('claude-3-5-sonnet-20241022');
    expect(vi.mocked(enqueue)).toHaveBeenCalledTimes(1);
    const event = vi.mocked(enqueue).mock.calls[0]?.[0] as {
      provider: string;
      tokens_in: number;
      tokens_out: number;
      status: string;
    };
    expect(event.provider).toBe('anthropic');
    expect(event.tokens_in).toBe(12);
    expect(event.tokens_out).toBe(34);
    expect(event.status).toBe('success');
  });

  it('emits a FAILURE telemetry event on provider error and rethrows', async () => {
    const create = vi.fn(async () => {
      throw new Error('upstream 500');
    });
    const peer = buildFakePeer(create);
    vi.mocked(loadPeer).mockReturnValue(peer);

    applyAnthropicPatch();
    const client = new peer.default();

    await expect(client.messages.create({ model: 'claude-3-5-sonnet-20241022' })).rejects.toThrow(
      'upstream 500',
    );

    const event = vi.mocked(enqueue).mock.calls[0]?.[0] as { status: string; provider: string };
    expect(event.status).toBe('failure');
    expect(event.provider).toBe('anthropic');
  });

  it('drops a delayed old-identity failure instead of enqueuing it for the new tenant', async () => {
    let rejectCreate!: (reason: unknown) => void;
    const create = vi.fn(
      () =>
        new Promise<unknown>((_resolve, reject) => {
          rejectCreate = reject;
        }),
    );
    const peer = buildFakePeer(create);
    vi.mocked(loadPeer).mockReturnValue(peer);

    applyAnthropicPatch();
    const client = new peer.default();
    const pending = client.messages.create({ model: 'claude-3-5-sonnet-20241022' });
    configState.generation += 1;
    rejectCreate(new Error('old tenant upstream failure'));

    await expect(pending).rejects.toThrow('old tenant upstream failure');
    expect(vi.mocked(enqueue)).not.toHaveBeenCalled();
  });

  it('falls through to original SDK when args[0] is not an object (R1)', async () => {
    const create = vi.fn(async () => ({ model: 'claude-3-5-sonnet-20241022' }));
    const peer = buildFakePeer(create);
    vi.mocked(loadPeer).mockReturnValue(peer);

    applyAnthropicPatch();
    const client = new peer.default();
    await client.messages.create('malformed-input' as unknown as object);

    expect(create).toHaveBeenCalledWith('malformed-input');
    // No engine ran → no telemetry attempt.
    expect(vi.mocked(enqueue)).not.toHaveBeenCalled();
  });

  it('is idempotent — applying twice does not double-wrap', async () => {
    const create = vi.fn(async () => ({ model: 'claude-3-5-sonnet-20241022' }));
    const peer = buildFakePeer(create);
    vi.mocked(loadPeer).mockReturnValue(peer);

    applyAnthropicPatch();
    applyAnthropicPatch();
    const client = new peer.default();
    await client.messages.create({ model: 'claude-3-5-sonnet-20241022' });

    expect(vi.mocked(enqueue)).toHaveBeenCalledTimes(1);
  });

  it('skips FAILURE telemetry for PylvaBudgetExceeded (intentional refusal)', async () => {
    const budgetExceeded = new PylvaBudgetExceeded({
      source: BudgetExceededSource.SDK_PRECALL,
      rule_id: 'r1',
      customer_id: 'cust_1',
      period: 'day',
      period_start: '2026-04-26T00:00:00.000Z',
      limit_usd: 5,
      accumulated_usd: 5,
      estimated_usd: 0,
    });
    const create = vi.fn(async () => {
      throw budgetExceeded;
    });
    const peer = buildFakePeer(create);
    vi.mocked(loadPeer).mockReturnValue(peer);

    applyAnthropicPatch();
    const client = new peer.default();
    await expect(
      client.messages.create({ model: 'claude-3-5-sonnet-20241022' }),
    ).rejects.toBeInstanceOf(PylvaBudgetExceeded);

    expect(vi.mocked(enqueue)).not.toHaveBeenCalled();
  });
});
