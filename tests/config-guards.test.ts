// validateProductionSecrets boot guard: production must reject dev-default /
// short ARGON2_SECRET; non-production is always a no-op. config is mocked so we
// can drive NODE_ENV and the secret values.

import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
}));

vi.mock('@/lib/config', () => ({
  get env() {
    return state.env;
  },
}));
vi.mock('../src/lib/config.js', () => ({
  get env() {
    return state.env;
  },
}));

import { validateProductionSecrets } from '@/lib/config-guards';

const STRONG = 'x'.repeat(48);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('validateProductionSecrets', () => {
  it('is a no-op outside production even with the dev default', () => {
    state.env = { NODE_ENV: 'development', ARGON2_SECRET: 'dev-secret-change-in-prod' };
    expect(() => validateProductionSecrets()).not.toThrow();
  });

  it('throws in production when ARGON2_SECRET is the dev default', () => {
    state.env = { NODE_ENV: 'production', ARGON2_SECRET: 'dev-secret-change-in-prod' };
    expect(() => validateProductionSecrets()).toThrow(/dev default/);
  });

  it('throws in production when ARGON2_SECRET is shorter than 32 bytes', () => {
    state.env = { NODE_ENV: 'production', ARGON2_SECRET: 'short' };
    expect(() => validateProductionSecrets()).toThrow(/at least 32 bytes/);
  });

  it('passes in production with a strong, non-default ARGON2_SECRET', () => {
    state.env = { NODE_ENV: 'production', ARGON2_SECRET: STRONG, OAUTH_STATE_SECRET: STRONG };
    expect(() => validateProductionSecrets()).not.toThrow();
  });

  it('warns (but does not throw) in production when OAUTH_STATE_SECRET is unset', () => {
    state.env = { NODE_ENV: 'production', ARGON2_SECRET: STRONG };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => validateProductionSecrets()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('OAUTH_STATE_SECRET'));
  });
});
