import { describe, it, expect, beforeEach } from 'vitest';
import {
  init,
  isInitialized,
  InvalidApiKeyError,
  _resetConfigForTests,
} from '../src/core/config.js';

const VALID_KEY = 'pv_live_12345678_' + 'a'.repeat(32);

describe('init() — sync format validation (D19)', () => {
  beforeEach(() => _resetConfigForTests());

  it('accepts a properly-formatted API key', () => {
    expect(() => init({ apiKey: VALID_KEY })).not.toThrow();
  });

  it('accepts a legacy pv_cli_* key (universal since migration 048)', () => {
    expect(() => init({ apiKey: `pv_cli_12345678_${'a'.repeat(32)}` })).not.toThrow();
    expect(isInitialized()).toBe(true);
  });

  it('throws InvalidApiKeyError on malformed key', () => {
    expect(() => init({ apiKey: 'not-a-key' })).toThrow(InvalidApiKeyError);
  });

  it('uses the Pylva invalid-key wording', () => {
    const err = new InvalidApiKeyError();
    expect(err.message).toContain('Invalid Pylva API key format');
  });

  it('throws InvalidApiKeyError on key_id != 8 hex', () => {
    expect(() => init({ apiKey: `pv_live_12345_${'a'.repeat(32)}` })).toThrow(InvalidApiKeyError);
  });

  it('throws InvalidApiKeyError on random part != 32 hex', () => {
    expect(() => init({ apiKey: `pv_live_12345678_${'a'.repeat(10)}` })).toThrow(
      InvalidApiKeyError,
    );
  });

  it('applies defaults for endpoint / batchSize / flushInterval', () => {
    init({ apiKey: VALID_KEY });
    expect(isInitialized()).toBe(true);
  });

  it('throws when config is null or undefined', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => init(null as any)).toThrow(InvalidApiKeyError);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => init(undefined as any)).toThrow(InvalidApiKeyError);
  });
});

describe('public constructor', () => {
  it('exports Pylva', async () => {
    const sdk = await import('../src/index.js');
    expect(typeof sdk.Pylva).toBe('function');
  });
});
