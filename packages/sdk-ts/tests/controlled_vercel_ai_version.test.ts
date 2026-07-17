import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const peers = vi.hoisted(() => ({
  providerCall: vi.fn(),
}));

vi.mock('ai', () => ({ generateText: peers.providerCall }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((file: Parameters<typeof actual.readFileSync>[0], ...args: unknown[]) => {
    if (String(file).endsWith('/ai/package.json')) return '{"version":"7.0.0"}';
    return Reflect.apply(actual.readFileSync, actual, [file, ...args]) as unknown;
  }) as typeof actual.readFileSync;
  return { ...actual, readFileSync };
});

import {
  _resetVercelAiPatchForTests,
  type ControlledOpenAIChatModel,
  createControlledOpenAIChatModel,
  controlledGenerateText,
} from '../src/wrappers/vercel-ai.js';

let model: ControlledOpenAIChatModel;

function request() {
  return {
    model,
    prompt: 'private prompt',
    maxOutputTokens: 20,
    providerOptions: { openai: { serviceTier: 'default' } },
  };
}

describe('controlled Vercel AI runtime version boundary', () => {
  beforeEach(async () => {
    _resetVercelAiPatchForTests();
    peers.providerCall.mockReset();
    model = await createControlledOpenAIChatModel({
      apiKey: 'provider-test-key',
      model: 'gpt-test-2026-01-01',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetVercelAiPatchForTests();
  });

  it('refuses AI SDK major 7 before control or provider I/O', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(controlledGenerateText(request())).rejects.toMatchObject({
      name: 'PylvaStrictProviderError',
      code: 'strict_provider_unsupported',
      provider: 'vercel-ai',
      reason: 'ai_sdk_v6_is_required',
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(peers.providerCall).not.toHaveBeenCalled();
  });
});
