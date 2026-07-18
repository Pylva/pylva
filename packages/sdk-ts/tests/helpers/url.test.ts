import { describe, expect, it } from 'vitest';
import { matchesExactRequest } from './url.js';

const target = {
  origin: 'https://api.openai.com',
  pathname: '/v1/chat/completions',
  method: 'POST',
} as const;

describe('matchesExactRequest', () => {
  it('requires the exact origin, path, and method', () => {
    expect(
      matchesExactRequest('https://api.openai.com/v1/chat/completions', { method: 'post' }, target),
    ).toBe(true);
    expect(
      matchesExactRequest(
        new Request('https://api.openai.com/v1/chat/completions', { method: 'POST' }),
        undefined,
        target,
      ),
    ).toBe(true);

    for (const [url, method] of [
      ['https://api.openai.com.evil.test/v1/chat/completions', 'POST'],
      ['http://api.openai.com/v1/chat/completions', 'POST'],
      ['https://api.openai.com:444/v1/chat/completions', 'POST'],
      ['https://user:secret@api.openai.com/v1/chat/completions', 'POST'],
      ['https://api.openai.com/v1/chat/completions/extra', 'POST'],
      ['https://api.openai.com/v1/chat/completions?redirect=evil', 'POST'],
      ['https://api.openai.com/v1/chat/completions#fragment', 'POST'],
      ['https://api.openai.com/v1/chat/completions', 'GET'],
    ] as const) {
      expect(matchesExactRequest(url, { method }, target)).toBe(false);
    }
  });

  it('returns false for invalid URLs', () => {
    expect(matchesExactRequest('not a URL', { method: 'POST' }, target)).toBe(false);
  });
});
