// Pure-unit coverage for evaluateSourceHealth — silence + cost drop +
// cold start, plus the absolute 72h ceiling backstop.

import { describe, it, expect } from 'vitest';
import { evaluateSourceHealth, type DailyEventRow } from '../../src/lib/health/source-checker.js';

const NOW = new Date('2026-04-25T12:00:00Z');

function dayString(daysAgo: number): string {
  const d = new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function denseSeries(days: number, costPerDay: number): DailyEventRow[] {
  const rows: DailyEventRow[] = [];
  for (let i = days - 1; i >= 0; i--) {
    rows.push({ day: dayString(i), event_count: 100, cost_usd: costPerDay });
  }
  return rows;
}

describe('evaluateSourceHealth — cold start gate', () => {
  it('skips silence + cost_drop when fewer than 14 distinct event-days exist', () => {
    const series = denseSeries(13, 5);
    const evaluation = evaluateSourceHealth(series, NOW, NOW);
    expect(evaluation.cold_start).toBe(true);
    expect(evaluation.silence).toBeNull();
    expect(evaluation.cost_drop).toBeNull();
  });

  it('engages detectors at exactly 14 distinct event-days', () => {
    const series = denseSeries(14, 5);
    const evaluation = evaluateSourceHealth(series, NOW, NOW);
    expect(evaluation.cold_start).toBe(false);
  });
});

describe('evaluateSourceHealth — adaptive silence', () => {
  it('does not alert when silence is below 2x the longest historical gap', () => {
    const series = denseSeries(20, 5);
    const lastSeen = new Date(NOW.getTime() - 18 * 60 * 60 * 1000);
    const evaluation = evaluateSourceHealth(series, lastSeen, NOW);
    expect(evaluation.silence).toBeNull();
  });

  it('alerts when silence exceeds 2x the longest historical gap', () => {
    const series: DailyEventRow[] = [];
    for (let i = 30; i >= 0; i--) {
      if (i === 22 || i === 23 || i === 24) continue;
      series.push({ day: dayString(i), event_count: 100, cost_usd: 5 });
    }
    const lastSeen = new Date(NOW.getTime() - 80 * 60 * 60 * 1000);
    const evaluation = evaluateSourceHealth(series, lastSeen, NOW);
    expect(evaluation.silence).not.toBeNull();
    expect(evaluation.silence?.reason).toBe('absolute_ceiling');
  });

  it('uses the absolute 72h ceiling for sources whose 2x-gap window is unreasonably small', () => {
    const series = denseSeries(20, 5);
    const lastSeen = new Date(NOW.getTime() - 75 * 60 * 60 * 1000);
    const evaluation = evaluateSourceHealth(series, lastSeen, NOW);
    expect(evaluation.silence?.reason).toBe('absolute_ceiling');
    expect(evaluation.silence?.silent_hours).toBeCloseTo(75, 0);
  });

  it('skips silence detection when last_seen_at is null', () => {
    const series = denseSeries(20, 5);
    const evaluation = evaluateSourceHealth(series, null, NOW);
    expect(evaluation.silence).toBeNull();
  });
});

describe('evaluateSourceHealth — cost drop', () => {
  it('alerts when 7d avg falls below 10% of 30d avg (>90% drop)', () => {
    const series: DailyEventRow[] = [];
    for (let i = 29; i >= 7; i--) {
      series.push({ day: dayString(i), event_count: 100, cost_usd: 100 });
    }
    for (let i = 6; i >= 0; i--) {
      series.push({ day: dayString(i), event_count: 100, cost_usd: 1 });
    }
    const lastSeen = NOW;
    const evaluation = evaluateSourceHealth(series, lastSeen, NOW);
    expect(evaluation.cost_drop).not.toBeNull();
    expect(evaluation.cost_drop?.drop_percent).toBeGreaterThan(90);
  });

  it('does not alert under normal fluctuation', () => {
    const series: DailyEventRow[] = [];
    for (let i = 29; i >= 0; i--) {
      const cost = 100 + (i % 5) * 5;
      series.push({ day: dayString(i), event_count: 100, cost_usd: cost });
    }
    const evaluation = evaluateSourceHealth(series, NOW, NOW);
    expect(evaluation.cost_drop).toBeNull();
  });

  it('smooths a single-day spike followed by a return to baseline', () => {
    const series: DailyEventRow[] = [];
    for (let i = 29; i >= 8; i--) {
      series.push({ day: dayString(i), event_count: 100, cost_usd: 100 });
    }
    series.push({ day: dayString(7), event_count: 100, cost_usd: 1000 });
    for (let i = 6; i >= 0; i--) {
      series.push({ day: dayString(i), event_count: 100, cost_usd: 100 });
    }
    const evaluation = evaluateSourceHealth(series, NOW, NOW);
    expect(evaluation.cost_drop).toBeNull();
  });

  it('returns null when the 30-day average is zero', () => {
    const series: DailyEventRow[] = [];
    for (let i = 29; i >= 0; i--) {
      series.push({ day: dayString(i), event_count: 100, cost_usd: 0 });
    }
    const evaluation = evaluateSourceHealth(series, NOW, NOW);
    expect(evaluation.cost_drop).toBeNull();
  });
});
