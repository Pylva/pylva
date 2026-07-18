import { describe, expect, it, vi } from 'vitest';
import {
  PylvaStrictProviderError,
  estimateJsonUtf8TokenUpperBound,
} from '../src/wrappers/_usage_bound.js';

describe('strict content-free usage bound', () => {
  it('counts the complete UTF-8 JSON shape conservatively for ASCII and Unicode', () => {
    const ascii = estimateJsonUtf8TokenUpperBound('openai', {
      messages: [{ role: 'user', content: 'hello' }],
    });
    const unicode = estimateJsonUtf8TokenUpperBound('openai', {
      messages: [{ role: 'user', content: 'مرحبا 👋🏽' }],
    });
    expect(ascii).toBeGreaterThan(256);
    expect(unicode).toBeGreaterThan(ascii);
  });

  it.each([
    () => {
      const cycle: Record<string, unknown> = {};
      cycle['self'] = cycle;
      return cycle;
    },
    () => {
      const shared = { text: 'private' };
      return { one: shared, two: shared };
    },
    () => new Date(),
    () => ({ invalid: BigInt(1) }),
    () => {
      const sparse: unknown[] = [];
      sparse.length = 100;
      return sparse;
    },
  ])('rejects ambiguous/non-JSON shapes deterministically %#', (build) => {
    expect(() => estimateJsonUtf8TokenUpperBound('openai', build())).toThrow(
      PylvaStrictProviderError,
    );
  });

  it('inspects array descriptors without invoking an indexed accessor', () => {
    const getter = vi.fn(() => 'private prompt');
    const array: unknown[] = [];
    Object.defineProperty(array, '0', { enumerable: true, configurable: true, get: getter });
    array.length = 1;
    expect(() => estimateJsonUtf8TokenUpperBound('openai', array)).toThrow(
      'request_contains_array_accessor',
    );
    expect(getter).not.toHaveBeenCalled();
  });

  it('bounds depth, nodes, array length, object keys, and strings before expensive traversal', () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index < 70; index += 1) {
      const next: Record<string, unknown> = {};
      cursor['next'] = next;
      cursor = next;
    }
    expect(() => estimateJsonUtf8TokenUpperBound('anthropic', deep)).toThrow(
      'request_exceeds_local_complexity_limit',
    );
    expect(() =>
      estimateJsonUtf8TokenUpperBound('openai', { text: 'x'.repeat(1_000_001) }),
    ).toThrow('request_exceeds_local_complexity_limit');
  });

  it('never includes request content in a strict error', () => {
    const secret = 'top-secret-prompt-value';
    let error: unknown;
    try {
      estimateJsonUtf8TokenUpperBound('openai', { prompt: secret, invalid: Symbol('secret') });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).not.toContain(secret);
    expect(error).toMatchObject({
      code: 'strict_provider_unsupported',
      provider: 'openai',
    });
  });
});
