import { describe, expect, it } from 'vitest';
import { hasPgErrorCode, pgErrorCode } from '../../src/lib/db/pg-error.js';

describe('pgErrorCode', () => {
  it('reads a direct own code string', () => {
    const error = { code: '23514' };

    expect(pgErrorCode(error)).toBe('23514');
    expect(hasPgErrorCode(error, '23514')).toBe(true);
  });

  it('reads a code string from one nested cause level', () => {
    const error = { cause: { code: '42P01' } };

    expect(pgErrorCode(error)).toBe('42P01');
    expect(hasPgErrorCode(error, '42P01')).toBe(true);
  });

  it('returns null for non-object errors', () => {
    expect(pgErrorCode(null)).toBeNull();
    expect(pgErrorCode(42)).toBeNull();
  });

  it('does not treat a raw string code as a pg error object', () => {
    expect(pgErrorCode('23514')).toBeNull();
    expect(hasPgErrorCode('23514', '23514')).toBe(false);
  });

  it('returns false when the requested code does not match', () => {
    const inheritedCode = Object.create({ code: '23514' }) as object;

    expect(hasPgErrorCode({ code: '23514' }, '42P01')).toBe(false);
    expect(pgErrorCode(inheritedCode)).toBeNull();
  });
});
