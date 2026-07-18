import { describe, expect, it } from 'vitest';
import { formatLiveInteger, formatLiveTelemetryUsd } from '../../src/lib/live-number-formatting.js';

describe('live dashboard number formatting', () => {
  it.each([
    [0, '$0.00'],
    [-0, '$0.00'],
    [1_234.567, '$1,234.57'],
    [0.009, '$0.009'],
    [0.000004, '$0.000004'],
    [-0.000004, '-$0.000004'],
    [1e-18, '$0.000000000000000001'],
    [1e-19, '$1.00e-19'],
  ])('formats %s as %s', (value, expected) => {
    expect(formatLiveTelemetryUsd(value)).toBe(expected);
  });

  it.each([Number.MIN_VALUE, 1e-19, -1e-19, 0.000004, -0.000004])(
    'never renders nonzero %s as zero',
    (value) => {
      expect(formatLiveTelemetryUsd(value)).not.toBe('$0.00');
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects non-finite %s',
    (value) => {
      expect(formatLiveTelemetryUsd(value)).toBe('$—');
    },
  );

  it('keeps integer grouping and rounding for event counters', () => {
    expect(formatLiveInteger(1_234.6)).toBe('1,235');
  });
});
