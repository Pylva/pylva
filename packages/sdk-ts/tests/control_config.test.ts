import { beforeEach, describe, expect, it } from 'vitest';
import {
  ControlMode,
  ControlUnavailablePolicy,
  DEFAULT_CONTROL_TIMEOUT_MS,
  InvalidControlConfigError,
  _resetConfigForTests,
  getConfig,
  getConfigGeneration,
  init,
} from '../src/core/config.js';

const KEY_A = `pv_live_aabbccdd_${'a'.repeat(32)}`;
const KEY_B = `pv_live_bbccddee_${'b'.repeat(32)}`;

describe('authoritative-control configuration', () => {
  beforeEach(() => _resetConfigForTests());

  it('defaults to compatibility-safe legacy + allow with a bounded deadline', () => {
    init({ apiKey: KEY_A });
    expect(getConfig()?.control).toEqual({
      mode: ControlMode.LEGACY,
      onUnavailable: ControlUnavailablePolicy.ALLOW,
      timeoutMs: DEFAULT_CONTROL_TIMEOUT_MS,
    });
    expect(Object.isFrozen(getConfig()?.control)).toBe(true);
  });

  it('accepts every public mode and unavailability policy', () => {
    for (const mode of ['legacy', 'shadow', 'enforce'] as const) {
      for (const onUnavailable of ['allow', 'deny'] as const) {
        init({ apiKey: KEY_A, control: { mode, onUnavailable, timeoutMs: 100 } });
        expect(getConfig()?.control).toEqual({ mode, onUnavailable, timeoutMs: 100 });
      }
    }
  });

  it.each([
    null,
    [],
    'enforce',
    { mode: 'unknown' },
    { onUnavailable: 'sometimes' },
    { timeoutMs: 99 },
    { timeoutMs: 30_001 },
    { timeoutMs: 100.5 },
    { timeoutMs: Number.NaN },
    { timeoutMs: Number.POSITIVE_INFINITY },
    { timeoutMs: '2000' },
    { extra: true },
  ])('rejects malformed or ambiguous control config %#', (control) => {
    expect(() => init({ apiKey: KEY_A, control: control as never })).toThrow(
      InvalidControlConfigError,
    );
  });

  it('does not mutate the installed identity when validation fails', () => {
    init({ apiKey: KEY_A, endpoint: 'https://one.test' });
    expect(() => init({ apiKey: KEY_B, control: { timeoutMs: 1 } })).toThrow(
      InvalidControlConfigError,
    );
    expect(getConfig()).not.toHaveProperty('apiKey');
    expect(getConfig()?.endpoint).toBe('https://one.test');
  });

  it('changes the cache generation only when key or endpoint identity changes', () => {
    init({ apiKey: KEY_A, endpoint: 'https://one.test', control: { mode: 'legacy' } });
    const first = getConfigGeneration();
    init({ apiKey: KEY_A, endpoint: 'https://one.test', control: { mode: 'enforce' } });
    expect(getConfigGeneration()).toBe(first);
    init({ apiKey: KEY_A, endpoint: 'https://two.test' });
    expect(getConfigGeneration()).toBe(first + 1);
    init({ apiKey: KEY_B, endpoint: 'https://two.test' });
    expect(getConfigGeneration()).toBe(first + 2);
  });
});
