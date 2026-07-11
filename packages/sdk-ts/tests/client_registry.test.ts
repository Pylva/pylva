import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetClientRegistry,
  getRegisteredClient,
  hasRegisteredClient,
  registerProviderClient,
  registerProviderClients,
} from '../src/core/client_registry.js';

describe('provider client registry', () => {
  beforeEach(() => {
    _resetClientRegistry();
  });

  it('registers arbitrary provider ids exactly', () => {
    const openrouter = { name: 'openrouter' };
    const vercelOpenAi = { name: 'openai.chat' };

    registerProviderClients({
      openrouter,
      'openai.chat': vercelOpenAi,
    });

    expect(getRegisteredClient('openrouter')).toBe(openrouter);
    expect(getRegisteredClient('openai.chat')).toBe(vercelOpenAi);
    expect(hasRegisteredClient('openai')).toBe(false);
  });

  it('keeps openai and anthropic convenience registrations as normal provider ids', () => {
    const openai = { name: 'openai' };
    registerProviderClient('openai', openai);

    expect(getRegisteredClient('openai')).toBe(openai);
  });
});
