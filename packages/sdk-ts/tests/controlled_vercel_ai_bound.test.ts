import { afterEach, describe, expect, it } from 'vitest';
import { estimateJsonUtf8TokenUpperBound } from '../src/wrappers/_usage_bound.js';
import { _controlledAiInputBoundForTests } from '../src/wrappers/vercel-ai.js';

type TextShape = Parameters<typeof _controlledAiInputBoundForTests>[0];

function genericBound(shape: TextShape): number {
  return estimateJsonUtf8TokenUpperBound('openai', shape);
}

function expectExact(shape: TextShape): void {
  expect(_controlledAiInputBoundForTests(shape)).toBe(genericBound(shape));
}

describe('controlled Vercel text-only input bound', () => {
  afterEach(() => {
    delete (Object.prototype as { toJSON?: unknown }).toJSON;
    delete (Array.prototype as { toJSON?: unknown }).toJSON;
    delete (String.prototype as { toJSON?: unknown }).toJSON;
  });

  it.each([
    { system: null, prompt: '', messages: null },
    { system: '', prompt: null, messages: [] },
    { system: 'quotes " and slash \\', prompt: 'line\n\u0000', messages: null },
    { system: 'مرحبا 👋', prompt: '\ud800 lone surrogate', messages: null },
    {
      system: null,
      prompt: null,
      messages: [
        { role: 'user', content: 'first' },
        { content: 'second', role: 'assistant' },
      ],
    },
  ] satisfies TextShape[])('matches the generic bound for edge shape %#', expectExact);

  it('matches the generic bound across deterministic Unicode and control fuzz cases', () => {
    const alphabet = ['a', '"', '\\', '\n', '\u0000', 'é', 'م', '👋', '\ud800'];
    let state = 0x5a17_2026;
    const random = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };
    const text = (): string => {
      let value = '';
      const length = random() % 24;
      for (let index = 0; index < length; index += 1) {
        value += alphabet[random() % alphabet.length];
      }
      return value;
    };

    for (let iteration = 0; iteration < 2_000; iteration += 1) {
      const useMessages = random() % 2 === 0;
      const messages = useMessages
        ? Array.from({ length: random() % 6 }, (_, index) => ({
            role: index % 2 === 0 ? 'user' : 'assistant',
            content: text(),
          }))
        : null;
      expectExact({
        system: random() % 2 === 0 ? null : text(),
        prompt: useMessages ? null : text(),
        messages,
      });
    }
  });

  it('pins the one-million-code-unit and 100,000-node boundaries', () => {
    expectExact({ system: null, prompt: 'a'.repeat(1_000_000), messages: null });
    const tooLong = { system: null, prompt: 'a'.repeat(1_000_001), messages: null };
    expect(() => _controlledAiInputBoundForTests(tooLong)).toThrowError(
      expect.objectContaining({
        provider: 'openai',
        reason: 'request_exceeds_local_complexity_limit',
      }),
    );
    expect(() => genericBound(tooLong)).toThrowError(
      expect.objectContaining({
        provider: 'openai',
        reason: 'request_exceeds_local_complexity_limit',
      }),
    );

    expectExact({
      system: null,
      prompt: null,
      messages: Array.from({ length: 33_332 }, () => ({ role: 'user', content: '' })),
    });
    const tooMany = {
      system: null,
      prompt: null,
      messages: Array.from({ length: 33_333 }, () => ({ role: 'user', content: '' })),
    };
    expect(() => _controlledAiInputBoundForTests(tooMany)).toThrowError(
      expect.objectContaining({ reason: 'request_exceeds_local_complexity_limit' }),
    );
    expect(() => genericBound(tooMany)).toThrowError(
      expect.objectContaining({ reason: 'request_exceeds_local_complexity_limit' }),
    );
  });

  it('does not invoke polluted object, array, or string toJSON hooks', () => {
    let calls = 0;
    const polluted = (): string => {
      calls += 1;
      return 'polluted';
    };
    (Object.prototype as { toJSON?: unknown }).toJSON = polluted;
    (Array.prototype as { toJSON?: unknown }).toJSON = polluted;
    (String.prototype as { toJSON?: unknown }).toJSON = polluted;

    expectExact({
      system: 'system',
      prompt: null,
      messages: [{ role: 'user', content: 'content' }],
    });
    expect(calls).toBe(0);
  });
});
