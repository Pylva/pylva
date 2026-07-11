// Regression for the de-escalation duplicate-alert bug.
//
// The 24h dispatch cooldown is overridden only when the new anomaly's
// severity strictly escalates above what already alerted in the window.
// The original implementation compared the new severity against the single
// most-recent prior row, so an intervening lower-severity anomaly re-opened
// the escalation gate: ERROR -> WARN -> ERROR inside 24h re-paged at ERROR
// even though an ERROR alert had already fired inside the window.

import { describe, it, expect } from 'vitest';
import { AnomalySeverity, type AnomalySeverity as AnomalySeverityType } from '@pylva/shared';
import { isSeverityCooledDown } from '../../src/lib/anomaly/cooldown-severity.js';

const { INFO, WARN, ERROR } = AnomalySeverity;

describe('isSeverityCooledDown', () => {
  it('never cools down when there are no prior anomalies in the window', () => {
    expect(isSeverityCooledDown([], WARN)).toBe(false);
    expect(isSeverityCooledDown([], ERROR)).toBe(false);
  });

  it('cools down a repeat at the same severity', () => {
    expect(isSeverityCooledDown([WARN], WARN)).toBe(true);
    expect(isSeverityCooledDown([ERROR], ERROR)).toBe(true);
  });

  it('lets a strict escalation through', () => {
    expect(isSeverityCooledDown([WARN], ERROR)).toBe(false);
    expect(isSeverityCooledDown([INFO], WARN)).toBe(false);
    expect(isSeverityCooledDown([INFO], ERROR)).toBe(false);
  });

  it('cools down a de-escalation', () => {
    expect(isSeverityCooledDown([ERROR], WARN)).toBe(true);
    expect(isSeverityCooledDown([ERROR], INFO)).toBe(true);
  });

  it('suppresses a re-escalation to a severity already alerted in the window', () => {
    expect(isSeverityCooledDown([ERROR, WARN], ERROR)).toBe(true);
    expect(isSeverityCooledDown([WARN, ERROR], ERROR)).toBe(true);
    expect(isSeverityCooledDown([WARN, ERROR, WARN], ERROR)).toBe(true);
  });

  it('still escalates past the window max when it is genuinely higher', () => {
    expect(isSeverityCooledDown([WARN, INFO], ERROR)).toBe(false);
  });

  it('treats an unknown severity string as the lowest rank', () => {
    expect(isSeverityCooledDown(['bogus' as AnomalySeverityType], WARN)).toBe(false);
    expect(isSeverityCooledDown([ERROR], 'bogus' as AnomalySeverityType)).toBe(true);
  });
});
