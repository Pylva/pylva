// B4-4b — Pure-unit coverage of the anomaly detectors. No DB / no CH;
// every fixture is a plain TypeScript value.

import { describe, it, expect } from 'vitest';
import { AnomalySeverity } from '@pylva/shared';
import {
  detectCostDrop,
  detectCostSpike,
  detectDeployDrop,
  detectMarginRisk,
  detectSourceSilence,
} from '../../src/lib/anomaly/detector.js';

describe('detectCostSpike', () => {
  it('fires when current > 1.15 × baseline', () => {
    const r = detectCostSpike(120, 100);
    expect(r).not.toBeNull();
    expect(r!.actual_value).toBe(120);
    expect(r!.baseline_value).toBe(100);
    expect(r!.delta_pct).toBe(20);
    expect(r!.severity).toBe(AnomalySeverity.WARN);
  });

  it('escalates to ERROR when current > 2 × baseline', () => {
    const r = detectCostSpike(250, 100);
    expect(r!.severity).toBe(AnomalySeverity.ERROR);
  });

  it('does not fire below the 15% threshold', () => {
    expect(detectCostSpike(110, 100)).toBeNull();
    expect(detectCostSpike(114, 100)).toBeNull();
  });

  it('returns null when baseline is zero (cold start)', () => {
    expect(detectCostSpike(100, 0)).toBeNull();
  });
});

describe('detectCostDrop', () => {
  it('fires when current < 10% of baseline', () => {
    const r = detectCostDrop(5, 100);
    expect(r).not.toBeNull();
    expect(r!.delta_pct).toBe(-95);
  });

  it('fires when current is zero against non-trivial baseline', () => {
    const r = detectCostDrop(0, 100);
    expect(r).not.toBeNull();
  });

  it('does not fire on a 50% drop', () => {
    expect(detectCostDrop(50, 100)).toBeNull();
  });
});

describe('detectDeployDrop', () => {
  it('fires within the 24h window on >90% drop', () => {
    const r = detectDeployDrop({
      postDeployUsd: 2,
      preDeployUsd: 100,
      hoursSinceDeploy: 6,
    });
    expect(r).not.toBeNull();
    expect(r!.severity).toBe(AnomalySeverity.ERROR);
  });

  it('skips when the deploy is older than the 24h window', () => {
    expect(
      detectDeployDrop({ postDeployUsd: 0, preDeployUsd: 100, hoursSinceDeploy: 30 }),
    ).toBeNull();
  });
});

describe('detectSourceSilence', () => {
  const now = new Date('2026-04-26T12:00:00Z');
  it('fires when current gap > 2× expected and 24h is empty', () => {
    const r = detectSourceSilence(
      {
        source: 'auto',
        last_seen: new Date(now.getTime() - 6 * 3_600_000),
        events_last_24h: 0,
        expected_gap_ms: 60 * 60 * 1000,
      },
      now,
    );
    expect(r).not.toBeNull();
  });

  it('does not fire while a recent event exists', () => {
    const r = detectSourceSilence(
      {
        source: 'auto',
        last_seen: new Date(now.getTime() - 6 * 3_600_000),
        events_last_24h: 5,
        expected_gap_ms: 60 * 60 * 1000,
      },
      now,
    );
    expect(r).toBeNull();
  });
});

describe('detectMarginRisk', () => {
  it('fires when current_margin < threshold', () => {
    const r = detectMarginRisk({
      current_margin_pct: 10,
      threshold_pct: 25,
      cost_usd: 90,
      revenue_usd: 100,
    });
    expect(r).not.toBeNull();
    expect(r!.severity).toBe(AnomalySeverity.WARN);
  });

  it('escalates to ERROR on negative margin', () => {
    const r = detectMarginRisk({
      current_margin_pct: -5,
      threshold_pct: 20,
      cost_usd: 105,
      revenue_usd: 100,
    });
    expect(r!.severity).toBe(AnomalySeverity.ERROR);
  });

  it('does not fire when revenue is zero (insufficient data)', () => {
    expect(
      detectMarginRisk({
        current_margin_pct: 0,
        threshold_pct: 25,
        cost_usd: 100,
        revenue_usd: 0,
      }),
    ).toBeNull();
  });
});
